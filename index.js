// 🔓 Отключаем SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();

const http = require('http');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const cron = require('node-cron');

// ===== КОНФИГ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;

if (!BOT_TOKEN) {
    console.error('❌ Не задан BOT_TOKEN');
    process.exit(1);
}

// ===== БД =====
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

// ===== БОТ =====
const bot = new Telegraf(BOT_TOKEN);

// ===== СЕРВЕР =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('👨‍🍳 Home Chef Bot is running!');
}).listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, tg_id BIGINT UNIQUE NOT NULL,
        username TEXT, first_name TEXT, free_recipes_used INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
        starts_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP NOT NULL,
        is_active BOOLEAN DEFAULT TRUE, payment_receipt_id TEXT
    )`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(tg_id),
        amount INTEGER NOT NULL, receipt_file_id TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(), approved_by BIGINT, approved_at TIMESTAMP
    )`);
    
    await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_expires ON subscriptions(expires_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)');
    
    console.log('✅ БД инициализирована');
}

// ===== ПОДКЛЮЧАЕМ МОДУЛИ =====
require('./bot')(bot, pool);        // Пользовательская часть
require('./admin')(bot, pool, ADMIN_ID);  // Админ-панель

// ===== КРОН: НАПОМИНАНИЯ =====
cron.schedule('0 10 * * *', async () => {
    console.log('⏰ Проверка подписок...');
    try {
        const { rows: soon } = await pool.query(`
            SELECT u.tg_id, s.expires_at FROM subscriptions s 
            JOIN users u ON s.user_id = u.tg_id 
            WHERE s.is_active = TRUE 
            AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
        `);
        
        for (const sub of soon) {
            const days = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
            await bot.telegram.sendMessage(sub.tg_id, 
                `⏰ <b>Подписка истекает через ${days} д.</b>\nПродлите, чтобы не потерять доступ!`,
                { parse_mode: 'HTML' }
            );
        }
        
        await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW()`);
        console.log('✅ Истёкшие подписки деактивированы');
    } catch (e) { console.error('Cron error:', e); }
});

// ===== ЗАПУСК =====
async function start() {
    await initDB();
    await bot.launch();
    console.log('🚀 Bot started!');
}
start();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
