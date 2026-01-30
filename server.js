const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const mysql = require('mysql');
const multer = require('multer');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'segredo_cantina_2026', resave: false, saveUninitialized: true
}));

// --- CONFIGURAÇÃO DE UPLOAD ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
});
const upload = multer({ storage: storage });

// --- BANCO DE DADOS ---
const db = mysql.createPool({
    connectionLimit: 10,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

io.on('connection', (socket) => console.log('⚡ Socket conectado: ' + socket.id));

// ==================================================================
//                            ROTAS
// ==================================================================

// --- 1. DOWNLOAD DO APP (NOVO!) ---
app.get('/baixar-app', (req, res) => {
    const file = path.join(__dirname, 'public', 'app.apk');
    res.download(file, 'CantinaDaCleo.apk', (err) => {
        if (err) {
            console.log("Erro download:", err);
            res.status(404).send("<h1>Ops!</h1><p>O arquivo do App ainda não foi gerado no servidor.</p>");
        }
    });
});

// --- 2. PEDIDOS ---
app.get('/get_pedidos', (req, res) => {
    // Busca pedidos de hoje e ontem
    db.query("SELECT * FROM pedidos WHERE data_pedido >= CURDATE() - INTERVAL 1 DAY ORDER BY id DESC", (err, results) => {
        if(err) return res.json([]);
        res.json(results);
    });
});

app.post('/novo_pedido', upload.single('comprovante'), (req, res) => {
    const d = req.body;
    const url = req.file ? `/uploads/${req.file.filename}` : null;
    const hora = new Date().toLocaleTimeString('pt-BR');
    
    let carrinho = [];
    try { carrinho = JSON.parse(d.carrinho_json); } catch(e){}
    
    let itensStr = carrinho.map(i => `${i.qtd}x ${i.nome}`).join(' | ');
    let total = carrinho.reduce((acc, i) => acc + (i.preco * i.qtd), 0);

    const sql = `INSERT INTO pedidos (nome_cliente, telefone, endereco, prato, quantidade, hora, status, observacao, data_pedido, forma_pagamento, comprovante_pix_url, valor_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?)`;
    
    db.query(sql, [d.nome, d.telefone, d.endereco, itensStr, carrinho.length, hora, 'Recebido', d.observacao, d.forma_pagamento, url, total], (err, result) => {
        if(err) return res.status(500).json({status:'erro', erro: err});
        io.emit('novo_pedido_servidor', { id: result.insertId });
        res.json({status:'sucesso', pedidoId: result.insertId});
    });
});

app.post('/pedido/:id/status', (req, res) => {
    db.query('UPDATE pedidos SET status = ? WHERE id = ?', [req.body.novoStatus, req.params.id], () => {
        io.emit('atualizacao_status', { id: req.params.id, status: req.body.novoStatus });
        res.json({status:'sucesso'});
    });
});

app.post('/pedido/:id/alertar', (req, res) => {
    io.emit('alerta_sonoro', { id: req.params.id });
    res.json({status:'sucesso'});
});

// --- 3. FINANCEIRO (COM PROTEÇÃO CONTRA NULL) ---
app.get('/relatorio-financeiro', (req, res) => {
    const sql = `SELECT data_pedido, COUNT(id) as qtd, 
    COALESCE(SUM(valor_total), 0) as total, 
    COALESCE(SUM(CASE WHEN forma_pagamento='PIX' THEN valor_total ELSE 0 END), 0) as pix,
    COALESCE(SUM(CASE WHEN forma_pagamento='Dinheiro' THEN valor_total ELSE 0 END), 0) as dinheiro,
    COALESCE(SUM(CASE WHEN forma_pagamento='Cartão' THEN valor_total ELSE 0 END), 0) as cartao
    FROM pedidos GROUP BY data_pedido ORDER BY data_pedido DESC LIMIT 15`;
    
    db.query(sql, (err, results) => {
        if(err) return res.json([]);
        const formatados = results.map(r => ({
            ...r,
            data_visual: new Date(r.data_pedido).toLocaleDateString('pt-BR'),
            data_iso: r.data_pedido
        }));
        res.json(formatados);
    });
});

app.get('/pedidos-por-data', (req, res) => {
    db.query("SELECT * FROM pedidos WHERE DATE(data_pedido) = DATE(?)", [req.query.data], (err, results) => {
        res.json(results || []);
    });
});

// --- 4. CARDÁPIOS E BEBIDAS ---
app.get('/todos-os-cardapios', (req, res) => {
    db.query("SELECT * FROM cardapios", async (err, menus) => {
        if(err) return res.json([]);
        const completo = await Promise.all(menus.map(async m => {
            return new Promise(resolve => {
                db.query("SELECT * FROM pratos WHERE cardapio_id = ?", [m.id], (e, pratos) => {
                    resolve({ ...m, isAtivo: m.ativo, pratos: pratos || [] });
                });
            });
        }));
        res.json(completo);
    });
});

app.get('/cardapio-ativo', (req, res) => {
    db.query("SELECT * FROM cardapios WHERE ativo = 1 LIMIT 1", (err, r) => {
        if(!r.length) return res.json({pratos:[]});
        db.query("SELECT * FROM pratos WHERE cardapio_id = ?", [r[0].id], (e, p) => res.json({nome: r[0].nome, pratos: p}));
    });
});

app.get('/bebidas-ativas', (req, res) => {
    db.query('SELECT * FROM bebidas WHERE ativo = TRUE', (err, results) => {
        res.json(results || []);
    });
});

app.post('/cardapio', (req, res) => {
    db.query("INSERT INTO cardapios (nome, ativo) VALUES (?, 0)", [req.body.nome], (err, r) => {
        const id = r.insertId;
        const pratos = req.body.pratos || [];
        if(pratos.length) {
            const values = pratos.map(p => [p.nome, p.preco, id]);
            db.query("INSERT INTO pratos (nome_prato, preco, cardapio_id) VALUES ?", [values]);
        }
        res.json({status:'sucesso'});
    });
});

app.put('/cardapio/:id', (req, res) => {
    db.query("UPDATE cardapios SET nome = ? WHERE id = ?", [req.body.nome, req.params.id]);
    db.query("DELETE FROM pratos WHERE cardapio_id = ?", [req.params.id], () => {
        const pratos = req.body.pratos || [];
        if(pratos.length) {
            const values = pratos.map(p => [p.nome, p.preco, req.params.id]);
            db.query("INSERT INTO pratos (nome_prato, preco, cardapio_id) VALUES ?", [values]);
        }
        res.json({status:'sucesso'});
    });
});

app.delete('/cardapio/:id', (req, res) => {
    db.query("DELETE FROM cardapios WHERE id = ?", [req.params.id], () => res.json({status:'sucesso'}));
});

app.post('/ativar-cardapio/:id', (req, res) => {
    db.query("UPDATE cardapios SET ativo = 0", () => {
        db.query("UPDATE cardapios SET ativo = 1 WHERE id = ?", [req.params.id], () => res.json({status:'sucesso'}));
    });
});

app.post('/upload-foto-prato/:id', upload.single('foto'), (req, res) => {
    const url = `/uploads/${req.file.filename}`;
    db.query('UPDATE pratos SET foto = ? WHERE id = ?', [url, req.params.id], () => res.json({status:'sucesso', url}));
});

// --- 5. USUÁRIOS ---
app.post('/login', (req, res) => {
    db.query("SELECT * FROM clientes WHERE email = ? AND senha = ?", [req.body.email, req.body.senha], (err, r) => {
        if(r && r.length) {
            req.session.clienteId = r[0].id;
            res.json({status:'sucesso'});
        } else {
            res.status(401).json({status:'erro'});
        }
    });
});

app.get('/perfil', (req, res) => {
    if(!req.session.clienteId) return res.json({status:'nao'});
    db.query("SELECT * FROM clientes WHERE id = ?", [req.session.clienteId], (err, r) => {
        res.json({status:'logado', cliente: r[0]});
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({status:'ok'}));
});

// --- 6. CONFIG LOJA ---
app.get('/status-loja', (req, res) => {
    db.query("SELECT * FROM configuracoes LIMIT 1", (err, r) => {
        res.json(r[0] || { aberto: true, modo: 'ABERTO' });
    });
});

app.post('/config-loja', (req, res) => {
    db.query("UPDATE configuracoes SET modo = ?, abertura = ?, fechamento = ? WHERE id = 1", 
        [req.body.modo, req.body.abertura, req.body.fechamento], () => res.json({status:'sucesso'}));
});

// --- 7. IMPRESSÃO TÉRMICA ---
app.get('/imprimir/:id', (req, res) => {
    db.query("SELECT * FROM pedidos WHERE id = ?", [req.params.id], (err, r) => {
        if(!r.length) return res.send("Erro");
        const p = r[0];
        const itens = p.prato.split('|').map(i => `<div>${i.trim()}</div>`).join('');
        
        res.send(`
            <html>
            <body style="font-family:monospace; width:300px; font-size:12px;">
                <div style="text-align:center; font-weight:bold; font-size:14px; margin-bottom:10px;">CANTINA DA CLÉO</div>
                <div style="text-align:center; border-bottom:1px dashed #000; padding-bottom:5px;">Pedido #${p.id} - ${p.hora.substring(0,5)}</div>
                <div style="margin-top:10px;"><strong>CLIENTE:</strong><br>${p.nome_cliente}<br>${p.telefone}</div>
                ${p.endereco ? `<div style="margin-top:5px;"><strong>ENTREGA:</strong><br>${p.endereco}</div>` : ''}
                <div style="border-top:1px dashed #000; margin:10px 0;"></div>
                <div>${itens}</div>
                ${p.observacao ? `<div style="margin-top:5px; font-weight:bold;">OBS: ${p.observacao}</div>` : ''}
                <div style="border-top:1px dashed #000; margin:10px 0;"></div>
                <div style="text-align:right; font-size:14px; font-weight:bold;">TOTAL: R$ ${parseFloat(p.valor_total).toFixed(2)}</div>
                <div style="text-align:right; font-size:11px;">${p.forma_pagamento}</div>
                <script>window.print();</script>
            </body>
            </html>
        `);
    });
});

http.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
