const fs = require('fs');
const path = require('path');

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const client = require('prom-client');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_123';

// --- CONFIGURAÇÃO DO BANCO DE DADOS (SQLite) ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        log('ERROR', `Falha ao conectar no banco SQLite: ${err.message}`);
    } else {
        log('INFO', 'Conectado ao banco de dados SQLite com sucesso.');
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);
});

// --- HELPER DE LOGS ESTRUTURADOS ---
function log(level, message, metadata = {}) {
    const logObj = {
        timestamp: new Date().toISOString(),
        level: level,
        message: message,
        ...metadata
    };
    const logText = JSON.stringify(logObj);

    // Mostra no console do VS Code
    if (level === 'ERROR') {
        console.error(logText);
    } else {
        console.log(logText);
    }

    // Salva em um arquivo físico de log
    try {
        fs.appendFileSync(path.join(__dirname, 'app.log'), logText + '\n');
    } catch (err) {
        console.error("Erro ao escrever no arquivo de log:", err.message);
    }
}

// --- MÉTRICAS PROMETHEUS ---
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total de requisições HTTP recebidas',
    labelNames: ['method', 'route', 'status'],
});

const httpRequestDurationSeconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duração das requisições HTTP em segundos',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.3, 0.5, 1, 3, 5]
});

// --- MÉTRICAS DO E-COMMERCE ---
const ecommerceVendasTotal = new client.Counter({
    name: 'ecommerce_vendas_total',
    help: 'Total de vendas processadas no checkout (sucesso ou falha de pagamento).',
    labelNames: ['status'],
});

const ecommerceItensAdicionadosTotal = new client.Counter({
    name: 'ecommerce_itens_adicionados_total',
    help: 'Total de itens adicionados no carrinho.',
});

const ecommerceFaturamentoReais = new client.Gauge({
    name: 'ecommerce_faturamento_reais',
    help: 'Faturamento acumulado em reais (somatório dos checkouts bem-sucedidos).',
});

let ecommerceFaturamentoAtual = 0;
ecommerceFaturamentoReais.set(ecommerceFaturamentoAtual);

registry.registerMetric(httpRequestsTotal);
registry.registerMetric(httpRequestDurationSeconds);
registry.registerMetric(ecommerceVendasTotal);
registry.registerMetric(ecommerceItensAdicionadosTotal);
registry.registerMetric(ecommerceFaturamentoReais);


// Middleware global para capturar logs e métricas de requisições
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        
        if (req.path !== '/metrics') {
            httpRequestsTotal.labels(req.method, req.path, res.statusCode).inc();
            httpRequestDurationSeconds.labels(req.method, req.path, res.statusCode).observe(duration);
            
            const logLevel = res.statusCode >= 400 ? 'ERROR' : 'INFO';
            log(logLevel, `Requisição processada: ${req.method} ${req.originalUrl}`, {
                status: res.statusCode,
                durationSeconds: duration,
                ip: req.ip
            });
        }
    });
    next();
});

// --- MIDDLEWARE DE AUTENTICAÇÃO JWT (USADO APENAS NAS ROTAS PROTEGIDAS) ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        log('ERROR', 'Tentativa de acesso a rota protegida sem token.');
        return res.status(401).json({ error: 'Token não fornecido.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            log('ERROR', 'Token inválido ou expirado apresentado.');
            return res.status(403).json({ error: 'Token inválido.' });
        }
        req.user = user;
        next();
    });
}

// ==========================================
// 🔓 ROTAS PÚBLICAS (MÉTRICAS E INCIDENTES)
// ==========================================

// Endpoint de métricas do Prometheus
app.get('/metrics', async (req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
});

// =========================
// E-COMMERCE - ROTAS PÚBLICAS
// =========================

// POST /cart/add
app.post('/cart/add', (req, res) => {
    const { produto, itens = 1 } = req.body || {};

    if (!produto || typeof produto !== 'object') {
        return res.status(400).json({ error: 'Campo "produto" é obrigatório.' });
    }

    const quantidade = Number(itens);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
        return res.status(400).json({ error: 'Campo "itens" (quantidade) deve ser um número maior que zero.' });
    }

    ecommerceItensAdicionadosTotal.inc(quantidade);

    log('INFO', 'Item adicionado ao carrinho', {
        produto: {
            id: produto.id,
            nome: produto.nome,
            sku: produto.sku,
            categoria: produto.categoria,
        },
        quantidade,
    });

    res.status(201).json({ message: 'Item adicionado ao carrinho com sucesso.', quantidade });
});

// POST /checkout
app.post('/checkout', (req, res) => {
    const { valor, itens } = req.body || {};

    if (valor === undefined) {
        return res.status(400).json({ error: 'Campo "valor" é obrigatório.' });
    }

    const valorNum = Number(valor);
    if (!Number.isFinite(valorNum) || valorNum < 0) {
        return res.status(400).json({ error: 'Campo "valor" deve ser um número válido.' });
    }

    const itensPayload = itens ?? [];

    // Simulação do pagamento.
    if (valorNum === 999) {
        ecommerceVendasTotal.labels('falha_pagamento').inc();

        log('ERROR', 'Gateway de pagamento caiu durante o checkout (falha simulada).', {
            valor: valorNum,
            itens: itensPayload,
            motivo: 'valor_exato_999',
            gateway: {
                nome: 'payment-gateway-simulado',
                status: 'DOWN',
            },
        });

        return res.status(402).json({ error: 'Falha no pagamento: gateway indisponível.' });
    }

    // Aprovar venda
    ecommerceVendasTotal.labels('sucesso').inc();

    ecommerceFaturamentoAtual += valorNum;
    ecommerceFaturamentoReais.set(ecommerceFaturamentoAtual);

    log('INFO', 'Checkout aprovado e venda registrada.', {
        valor: valorNum,
        itens: itensPayload,
    });

    return res.status(200).json({ message: 'Pagamento aprovado e venda registrada com sucesso.' });
});

// Incidente 1: Erro 500 intermitente [cite: 196]
app.get('/incidente/erro500', (req, res) => {
    log('ERROR', 'Incidente Ativado: Falha crítica interna simulada via endpoint');
    res.status(500).json({ error: 'Erro interno induzido no servidor.' });
});


// Incidente 2: Sobrecarga de CPU [cite: 197]
app.get('/incidente/stress-cpu', (req, res) => {
    log('INFO', 'Incidente Ativado: Iniciando rotina intensa de stress de CPU.');
    const end = Date.now() + 5000; 
    while (Date.now() < end) {
        Math.random() * Math.random();
    }
    res.json({ message: 'Rotina de estresse concluída de 5 segundos.' });
});

// Incidente 3: Latência/Timeout simulado [cite: 198]
app.get('/incidente/timeout', (req, res) => {
    const delay = 6000;
    log('INFO', `Incidente Ativado: Injetando delay artificial de ${delay}ms.`);
    setTimeout(() => {
        res.json({ message: `Resposta entregue tardiamente após ${delay}ms.` });
    }, delay);
});

// Autenticação básica [cite: 179]
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const stmt = db.prepare(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`);
        stmt.run(name, email, hashedPassword, function(err) {
            if (err) {
                log('ERROR', `Falha ao registrar usuário: ${email}`, { error: err.message });
                return res.status(400).json({ error: 'E-mail já cadastrado.' });
            }
            log('INFO', 'Usuário registrado com sucesso', { email });
            res.status(201).json({ id: this.lastID, name, email });
        });
        stmt.finalize();
    } catch (e) {
        log('ERROR', 'Erro interno no servidor ao registrar usuário', { error: e.message });
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) {
            log('ERROR', `Tentativa de login inválida: E-mail não encontrado`, { email });
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            log('ERROR', `Tentativa de login inválida: Senha incorreta`, { email });
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
        log('INFO', 'Usuário autenticado com sucesso', { email });
        res.json({ token });
    });
});

// ==========================================
// 🔒 ROTAS PROTEGIDAS (EXIGEM TOKEN JWT) [cite: 179]
// ==========================================
app.get('/users', authenticateToken, (req, res) => {
    db.all(`SELECT id, name, email FROM users`, [], (err, rows) => {
        if (err) {
            log('ERROR', 'Falha ao buscar usuários', { error: err.message });
            return res.status(500).json({ error: 'Erro interno.' });
        }
        res.json(rows);
    });
});

app.put('/users/:id', authenticateToken, (req, res) => {
    const { name, email } = req.body;
    const { id } = req.params;
    db.run(`UPDATE users SET name = ?, email = ? WHERE id = ?`, [name, email, id], function(err) {
        if (err) {
            log('ERROR', `Falha ao atualizar usuário ID ${id}`, { error: err.message });
            return res.status(400).json({ error: 'Erro ao atualizar dados.' });
        }
        log('INFO', `Usuário atualizado com sucesso`, { userId: id, email });
        res.json({ message: 'Usuário atualizado com sucesso.' });
    });
});

app.delete('/users/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM users WHERE id = ?`, [id], function(err) {
        if (err) {
            log('ERROR', `Falha ao deletar usuário ID ${id}`, { error: err.message });
            return res.status(500).json({ error: 'Erro ao deletar usuário.' });
        }
        log('INFO', `Usuário removido do sistema`, { userId: id });
        res.json({ message: 'Usuário excluído com sucesso.' });
    });
});

// Inicialização
app.listen(PORT, () => {
    log('INFO', `Aplicação Node em execução na porta ${PORT}`);
});