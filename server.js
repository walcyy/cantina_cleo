const express = require('express');
const path = require('path');
const mysql = require('mysql');
const multer = require('multer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

require('dotenv').config(); // Carrega as variáveis do arquivo .env

const app = express();
const PORT = 3000;

// --- CONFIGURAÇÕES PRINCIPAIS ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURAÇÃO DA SESSÃO DE LOGIN ---
app.use(session({
    secret: 'uma_chave_secreta_muito_longa_e_dificil_de_adivinhar', // IMPORTANTE: Mude para uma frase secreta sua
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // Login dura 24 horas
}));

// --- CONFIGURAÇÃO DO MULTER (UPLOAD DE ARQUIVOS) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'public/uploads/'); },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname); }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// --- CONFIGURAÇÃO DA CONEXÃO COM O MYSQL ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

db.connect((err) => {
    if (err) { console.error('!!! ERRO AO CONECTAR COM O MYSQL !!!', err); throw err; }
    console.log('Conectado ao banco de dados MySQL.');
});

// --- CONFIGURAÇÃO DO NODEMAILER (GMAIL) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

// --- ROTAS DE AUTENTICAÇÃO E PERFIL ---

app.post('/registrar', async (req, res) => {
    const { nome, email, senha, telefone, cep, endereco, numero, bairro } = req.body;
    if (!nome || !email || !senha || !telefone) {
        return res.status(400).json({ status: 'erro', mensagem: 'Campos obrigatórios estão faltando.' });
    }
    const senhaHash = await bcrypt.hash(senha, 10);
    const sql = "INSERT INTO clientes (nome, email, senha, telefone, cep, endereco, numero, bairro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    db.query(sql, [nome, email, senhaHash, telefone, cep, endereco, numero, bairro], (err, result) => {
        if (err) {
            if (err.errno === 1062) { return res.status(409).json({ status: 'erro', mensagem: 'Este e-mail já está cadastrado.' }); }
            console.error(err);
            return res.status(500).json({ status: 'erro', mensagem: 'Erro ao cadastrar cliente.' });
        }
        res.json({ status: 'sucesso', mensagem: 'Cliente cadastrado com sucesso!' });
    });
});

app.post('/login', (req, res) => {
    const { email, senha } = req.body;
    db.query("SELECT * FROM clientes WHERE email = ?", [email], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ status: 'erro', mensagem: 'E-mail ou senha inválidos.' });
        }
        const cliente = results[0];
        const senhaCorreta = await bcrypt.compare(senha, cliente.senha);
        if (senhaCorreta) {
            req.session.clienteId = cliente.id;
            req.session.clienteNome = cliente.nome;
            res.json({ status: 'sucesso', mensagem: 'Login efetuado com sucesso!' });
        } else {
            res.status(401).json({ status: 'erro', mensagem: 'E-mail ou senha inválidos.' });
        }
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) { return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível fazer logout.' }); }
        res.json({ status: 'sucesso', mensagem: 'Logout efetuado com sucesso.' });
    });
});

app.get('/perfil', (req, res) => {
    if (req.session.clienteId) {
        db.query("SELECT id, nome, email, telefone, cep, endereco, numero, bairro FROM clientes WHERE id = ?", [req.session.clienteId], (err, results) => {
            if (err || results.length === 0) { return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' }); }
            res.json({ status: 'logado', cliente: results[0] });
        });
    } else {
        res.json({ status: 'nao_logado' });
    }
});

app.get('/meus-pedidos', (req, res) => {
    if (!req.session.clienteId) {
        return res.status(401).json({ status: 'erro', mensagem: 'Acesso não autorizado.' });
    }
    const clienteId = req.session.clienteId;
    const sql = "SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY data_pedido DESC, id DESC";
    db.query(sql, [clienteId], (err, results) => {
        if (err) { console.error("Erro ao buscar histórico de pedidos:", err); return res.status(500).json({ status: 'erro', mensagem: 'Erro no servidor.' }); }
        res.json(results);
    });
});

// --- ROTAS DE RECUPERAÇÃO DE SENHA ---

app.post('/solicitar-recuperacao', (req, res) => {
    const { email } = req.body;
    db.query('SELECT * FROM clientes WHERE email = ?', [email], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ status: 'sucesso', mensagem: 'Se uma conta com este e-mail existir, um link de recuperação foi enviado.' });
        }
        const cliente = results[0];
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); // 1 hora
        db.query('UPDATE clientes SET token_recuperacao = ?, token_expiracao = ? WHERE id = ?', [token, expiracao, cliente.id], (err, result) => {
            if (err) { return res.status(500).send('Erro no servidor.'); }

            const linkDeRecuperacao = `http://${process.env.SERVER_IP}:3000/redefinir-senha.html?token=${token}`;

            const mailOptions = {
                from: `Cantina da Cléo <${process.env.GMAIL_USER}>`,
                to: cliente.email,
                subject: 'Recuperação de Senha - Cantina da Cléo',
                text: `Olá, ${cliente.nome}. Para redefinir sua senha, por favor, copie e cole este link no seu navegador: ${linkDeRecuperacao}`,
                html: `
                    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
                        <h2 style="color: #4E342E;">Recuperação de Senha</h2>
                        <p>Olá, ${cliente.nome}.</p>
                        <p>Recebemos uma solicitação para redefinir sua senha. Clique no botão abaixo para criar uma nova.</p>
                        <a href="${linkDeRecuperacao}" 
                           style="display: inline-block; padding: 12px 25px; margin: 20px 0; font-size: 16px; color: white; background-color: #C62828; text-decoration: none; border-radius: 8px;">
                           Redefinir Senha
                        </a>
                        <p style="font-size: 12px; color: #666;">Se você não solicitou isso, pode ignorar este e-mail.</p>
                        <p style="font-size: 12px; color: #666;">Este link expira em 1 hora.</p>
                    </div>
                `
            };
            
            transporter.sendMail(mailOptions, (err, info) => {
                if (err) { console.error("Erro ao enviar e-mail:", err); }
                 return res.json({ status: 'sucesso', mensagem: 'Se uma conta com este e-mail existir, um link de recuperação foi enviado.' });
            });
        });
    });
});

app.post('/redefinir-senha', async (req, res) => {
    const { token, novaSenha } = req.body;
    const sql = "SELECT * FROM clientes WHERE token_recuperacao = ? AND token_expiracao > NOW()";
    db.query(sql, [token], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({ status: 'erro', mensagem: 'Token inválido ou expirado.' });
        }
        const cliente = results[0];
        const senhaHash = await bcrypt.hash(novaSenha, 10);
        const updateSql = "UPDATE clientes SET senha = ?, token_recuperacao = NULL, token_expiracao = NULL WHERE id = ?";
        db.query(updateSql, [senhaHash, cliente.id], (err, result) => {
            if (err) { return res.status(500).send('Erro ao atualizar a senha.'); }
            res.json({ status: 'sucesso', mensagem: 'Senha redefinida com sucesso!' });
        });
    });
});


// --- ROTAS DE PEDIDOS ---

app.post('/novo_pedido', (req, res) => {
    upload.single('comprovante')(req, res, function (err) {
        if (err) {
            console.error("Erro durante o upload:", err);
            return res.status(500).json({ status: 'erro', mensagem: 'Erro ao fazer upload do arquivo.' });
        }
        const dados = req.body;
        const comprovanteUrl = req.file ? `/uploads/${req.file.filename}` : null;
        const clienteId = req.session.clienteId || null;
        const sqlPrecos = "SELECT preco FROM pratos WHERE nome_prato = ? UNION ALL SELECT preco FROM acompanhamentos WHERE nome_acompanhamento = ?";
        db.query(sqlPrecos, [dados.prato, dados.acompanhamento], (err, precosResult) => {
            if (err || precosResult.length < 2) {
                console.error("Erro ao buscar preços para o pedido:", err);
                return res.status(500).send("Erro ao verificar preços dos itens do cardápio.");
            }
            const precoPrato = parseFloat(precosResult[0].preco);
            const precoAcompanhamento = parseFloat(precosResult[1].preco);
            const valorTotal = (precoPrato + precoAcompanhamento) * parseInt(dados.quantidade);
            const sql = `INSERT INTO pedidos (nome_cliente, telefone, endereco, prato, acompanhamento, quantidade, hora, status, observacao, data_pedido, forma_pagamento, comprovante_pix_url, valor_total, cliente_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?)`;
            const params = [dados.nome, dados.telefone, dados.endereco, dados.prato, dados.acompanhamento, dados.quantidade, new Date().toLocaleTimeString('pt-BR'), 'Recebido', dados.observacao, dados.forma_pagamento, comprovanteUrl, valorTotal, clienteId];
            db.query(sql, params, (err, results) => {
                if (err) { console.error(err); return res.status(500).send("Erro ao salvar pedido."); }
                res.json({ status: 'sucesso', mensagem: 'Pedido recebido e salvo!', pedidoId: results.insertId });
            });
        });
    });
});

app.get('/get_pedidos', (req, res) => {
    db.query('SELECT * FROM pedidos ORDER BY id DESC', (err, results) => {
        if (err) { console.error(err); return res.status(500).send("Erro ao buscar pedidos."); }
        const pedidosFormatados = results.map(p => ({...p, nome: p.nome_cliente}));
        res.json(pedidosFormatados);
    });
});

app.get('/pedidos/total-hoje', (req, res) => {
    const sql = "SELECT COUNT(id) as total FROM pedidos WHERE data_pedido = CURDATE()";
    db.query(sql, (err, result) => {
        if (err) { console.error(err); return res.status(500).send("Erro ao buscar total."); }
        res.json(result[0]);
    });
});

app.get('/pedido/:id', (req, res) => {
    const pedidoId = req.params.id;
    db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId], (err, result) => {
        if (err || result.length === 0) {
            return res.status(404).send('Pedido não encontrado.');
        }
        const pedido = result[0];
        const respostaLimpa = {
            id: pedido.id, status: pedido.status, prato: pedido.prato,
            acompanhamento: pedido.acompanhamento, quantidade: pedido.quantidade,
            observacao: pedido.observacao, valor_total: pedido.valor_total,
            forma_pagamento: pedido.forma_pagamento
        };
        res.json(respostaLimpa);
    });
});

app.post('/pedido/:id/status', (req, res) => {
    const pedidoId = req.params.id;
    const { novoStatus } = req.body;
    const statusPermitidos = ['Recebido', 'Em Preparo', 'Saiu para Entrega', 'Entregue'];
    if (!statusPermitidos.includes(novoStatus)) { return res.status(400).send('Status inválido.'); }
    db.query('UPDATE pedidos SET status = ? WHERE id = ?', [novoStatus, pedidoId], (err, result) => {
        if (err) { console.error(err); return res.status(500).send('Erro ao atualizar status.'); }
        res.json({ status: 'sucesso', mensagem: `Status do pedido #${pedidoId} atualizado para ${novoStatus}` });
    });
});

// --- ROTAS DE CARDÁPIOS ---
app.get('/cardapio-ativo', (req, res) => {
    const sql = 'SELECT * FROM cardapios WHERE ativo = TRUE';
    db.query(sql, (err, cardapiosResult) => {
        if (err || cardapiosResult.length === 0) { return res.status(404).json({ mensagem: "Nenhum cardápio ativo no momento." }); }
        const cardapioAtivo = cardapiosResult[0];
        const pratosSql = 'SELECT nome_prato as nome, preco FROM pratos WHERE cardapio_id = ?';
        const acompSql = 'SELECT nome_acompanhamento as nome, preco FROM acompanhamentos WHERE cardapio_id = ?';
        db.query(pratosSql, [cardapioAtivo.id], (err, pratosResult) => {
            if (err) { console.error(err); return res.status(500).send("Erro ao buscar pratos."); }
            db.query(acompSql, [cardapioAtivo.id], (err, acompResult) => {
                if (err) { console.error(err); return res.status(500).send("Erro ao buscar acompanhamentos."); }
                res.json({ id: cardapioAtivo.id, nome: cardapioAtivo.nome, pratos: pratosResult, acompanhamentos: acompResult });
            });
        });
    });
});

app.get('/todos-os-cardapios', (req, res) => {
    db.query('SELECT * FROM cardapios', (err, cardapios) => {
        if (err) { console.error(err); return res.status(500).send("Erro ao buscar cardápios."); }
        if (cardapios.length === 0) { return res.json([]); }
        const promessas = cardapios.map(cardapio => {
            return new Promise((resolve, reject) => {
                const pratosSql = 'SELECT nome_prato FROM pratos WHERE cardapio_id = ?';
                db.query(pratosSql, [cardapio.id], (err, pratosResult) => {
                    if (err) { return reject(err); }
                    const cardapioCompleto = { ...cardapio, isAtivo: cardapio.ativo, pratos: pratosResult.map(p => p.nome_prato) };
                    resolve(cardapioCompleto);
                });
            });
        });
        Promise.all(promessas).then(cardapiosCompletos => res.json(cardapiosCompletos)).catch(error => {
            console.error("Erro ao montar os cardápios completos:", error);
            res.status(500).send("Erro ao processar os cardápios.");
        });
    });
});

app.post('/ativar-cardapio/:id', (req, res) => {
    const idParaAtivar = req.params.id;
    db.query('UPDATE cardapios SET ativo = FALSE', (err, result) => {
        if (err) { console.error(err); return res.status(500).send("Erro ao desativar cardápios."); }
        db.query('UPDATE cardapios SET ativo = TRUE WHERE id = ?', [idParaAtivar], (err, result) => {
            if (err) { console.error(err); return res.status(500).send("Erro ao ativar cardápio."); }
            res.json({ status: 'sucesso', mensagem: `Cardápio ${idParaAtivar} ativado!` });
        });
    });
});

app.delete('/cardapio/:id', (req, res) => {
    const idParaDeletar = req.params.id;
    const sql = 'DELETE FROM cardapios WHERE id = ?';
    db.query(sql, [idParaDeletar], (err, result) => {
        if (err) { console.error("Erro ao deletar cardápio:", err); return res.status(500).json({ status: 'erro', mensagem: 'Erro no servidor.' }); }
        res.json({ status: 'sucesso', mensagem: 'Cardápio deletado com sucesso!' });
    });
});

app.post('/cardapio', (req, res) => {
    const { nome, pratos, acompanhamentos } = req.body;
    if (!nome || !pratos || pratos.length === 0) { return res.status(400).json({ status: 'erro', mensagem: 'Nome e Pratos são obrigatórios.' }); }
    db.query('INSERT INTO cardapios (nome) VALUES (?)', [nome], (err, result) => {
        if (err) { console.error("Erro ao inserir cardápio:", err); return res.status(500).json({ status: 'erro', mensagem: 'Erro no servidor.' }); }
        const novoCardapioId = result.insertId;
        const pratosValues = pratos.map(p => { const [nomeItem, preco] = p.split(';'); return [nomeItem.trim(), parseFloat(preco) || 0, novoCardapioId]; });
        if(pratosValues.length > 0) {
            db.query('INSERT INTO pratos (nome_prato, preco, cardapio_id) VALUES ?', [pratosValues], (err, result) => { if (err) { console.error("Erro ao inserir pratos:", err); } });
        }
        if (acompanhamentos && acompanhamentos.length > 0) {
            const acompanhamentosValues = acompanhamentos.map(a => { const [nomeItem, preco] = a.split(';'); return [nomeItem.trim(), parseFloat(preco) || 0, novoCardapioId]; });
            if(acompanhamentosValues.length > 0) {
                db.query('INSERT INTO acompanhamentos (nome_acompanhamento, preco, cardapio_id) VALUES ?', [acompanhamentosValues], (err, result) => { if (err) { console.error("Erro ao inserir acompanhamentos:", err); } });
            }
        }
        res.json({ status: 'sucesso', mensagem: 'Cardápio adicionado com sucesso!' });
    });
});


// --- INICIAR O SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor da Cantina rodando na porta ${PORT}`);
});
