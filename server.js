const express = require('express');
const path = require('path');
const mysql = require('mysql');
const multer = require('multer');
const cors = require('cors');

const app = express();
const PORT = 3000;

// --- CONFIGURAÇÕES PRINCIPAIS ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    host: 'localhost',
    user: 'cantina_user',
    password: 'sua_senha_forte_da_aws',
    database: 'cantina'
});

db.connect((err) => {
    if (err) { console.error('!!! ERRO AO CONECTAR COM O MYSQL !!!', err); throw err; }
    console.log('Conectado ao banco de dados MySQL.');
});

// --- ROTAS DA APLICAÇÃO ---

app.post('/novo_pedido', (req, res) => {
    upload.single('comprovante')(req, res, function (err) {
        if (err) {
            console.error("Erro durante o upload:", err);
            return res.status(500).json({ status: 'erro', mensagem: 'Erro ao fazer upload do arquivo.' });
        }
        
        const dados = req.body;
        const comprovanteUrl = req.file ? `/uploads/${req.file.filename}` : null;

        const sqlPrecos = "SELECT preco FROM pratos WHERE nome_prato = ? UNION ALL SELECT preco FROM acompanhamentos WHERE nome_acompanhamento = ?";
        db.query(sqlPrecos, [dados.prato, dados.acompanhamento], (err, precosResult) => {
            if (err || precosResult.length < 2) {
                console.error("Erro ao buscar preços para o pedido:", err);
                return res.status(500).send("Erro ao verificar preços dos itens do cardápio.");
            }
            
            const precoPrato = parseFloat(precosResult[0].preco);
            const precoAcompanhamento = parseFloat(precosResult[1].preco);
            const valorTotal = (precoPrato + precoAcompanhamento) * parseInt(dados.quantidade);

            const sql = `INSERT INTO pedidos (nome_cliente, telefone, endereco, prato, acompanhamento, quantidade, hora, status, observacao, data_pedido, forma_pagamento, comprovante_pix_url, valor_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?)`;
            const params = [dados.nome, dados.telefone, dados.endereco, dados.prato, dados.acompanhamento, dados.quantidade, new Date().toLocaleTimeString('pt-BR'), 'Recebido', dados.observacao, dados.forma_pagamento, comprovanteUrl, valorTotal];
            
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

app.get('/cardapio-ativo', (req, res) => {
    const sql = 'SELECT * FROM cardapios WHERE ativo = TRUE';
    db.query(sql, (err, cardapiosResult) => {
        if (err || cardapiosResult.length === 0) {
            return res.status(404).json({ mensagem: "Nenhum cardápio ativo no momento." });
        }
        const cardapioAtivo = cardapiosResult[0];
        const pratosSql = 'SELECT nome_prato as nome, preco FROM pratos WHERE cardapio_id = ?';
        const acompSql = 'SELECT nome_acompanhamento as nome, preco FROM acompanhamentos WHERE cardapio_id = ?';
        db.query(pratosSql, [cardapioAtivo.id], (err, pratosResult) => {
            if (err) { console.error(err); return res.status(500).send("Erro ao buscar pratos."); }
            db.query(acompSql, [cardapioAtivo.id], (err, acompResult) => {
                if (err) { console.error(err); return res.status(500).send("Erro ao buscar acompanhamentos."); }
                const response = {
                    id: cardapioAtivo.id,
                    nome: cardapioAtivo.nome,
                    pratos: pratosResult,
                    acompanhamentos: acompResult
                };
                res.json(response);
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
        Promise.all(promessas)
            .then(cardapiosCompletos => res.json(cardapiosCompletos))
            .catch(error => {
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
    if (!nome || !pratos || pratos.length === 0) {
        return res.status(400).json({ status: 'erro', mensagem: 'Nome e Pratos são obrigatórios.' });
    }
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

// =================================================================
// ROTA CORRIGIDA PARA GARANTIR O FORMATO CORRETO DOS DADOS
// =================================================================
app.get('/pedido/:id', (req, res) => {
    const pedidoId = req.params.id;
    db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId], (err, result) => {
        if (err || result.length === 0) {
            return res.status(404).send('Pedido não encontrado.');
        }
        // Limpa e formata o objeto antes de enviar
        const pedido = result[0];
        const respostaLimpa = {
            id: pedido.id,
            status: pedido.status,
            prato: pedido.prato,
            acompanhamento: pedido.acompanhamento,
            quantidade: pedido.quantidade,
            observacao: pedido.observacao,
            valor_total: pedido.valor_total,
            forma_pagamento: pedido.forma_pagamento
        };
        res.json(respostaLimpa);
    });
});
// =================================================================

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

// --- INICIAR O SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor da Cantina rodando na porta ${PORT}`);
});