// 🔓 Отключаем SSL для локальной разработки
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();

const { Telegraf } = require('telegraf');
const http = require('http');
const { Pool } = require('pg');
const cron = require('node-cron');

// ===== КОНФИГУРАЦИЯ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
    console.error('❌ ОШИБКА: Не задан BOT_TOKEN в .env');
    process.exit(1);
}

console.log('🚀 Запуск Шеф-Повар AI...');

// ===== ПОДКЛЮЧЕНИЕ К БД =====
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: false // Для продакшена настройте SSL
});

// ===== ИНИЦИАЛИЗАЦИЯ БОТА =====
const bot = new Telegraf(BOT_TOKEN);

// ===== HTTP СЕРВЕР (для хостинга) =====
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('👨‍🍳 Шеф-Повар AI Bot работает!\nВерсия: 2.0');
}).listen(PORT, () => {
    console.log(`🌐 HTTP-сервер запущен на порту ${PORT}`);
});

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            tg_id BIGINT UNIQUE NOT NULL,
            username TEXT,
            first_name TEXT,
            free_recipes_used INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
                await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
            id SERIAL PRIMARY KEY,
            user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
            starts_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            plan_type VARCHAR(10) DEFAULT 'PRO',
            payment_receipt_id TEXT
        )`);
        
        await pool.query(`CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            user_id BIGINT REFERENCES users(tg_id),
            amount INTEGER NOT NULL,
            receipt_file_id TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            plan_type VARCHAR(10) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            approved_by BIGINT,
            approved_at TIMESTAMP
        )`);
        
        // Индексы
        await pool.query('CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(is_active, expires_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)');
        
        console.log('✅ База данных инициализирована');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
        throw err;
    }
}

// ===== ПОДКЛЮЧЕНИЕ МОДУЛЕЙ =====
const loadModules = () => {
    try {
        require('./admin')(bot, pool, ADMIN_ID);
        require('./bot')(bot, pool, ADMIN_ID);
        console.log('✅ Модули загружены: bot, admin');
    } catch (err) {
        console.error('❌ Ошибка загрузки модулей:', err);
        process.exit(1);
    }
};

// ===== КРОН: Напоминания об окончании подписки =====
cron.schedule('0 10 * * *', async () => {    console.log('⏰ [CRON] Проверка подписок...');
    try {
        const { rows } = await pool.query(`
            SELECT u.tg_id, u.first_name, s.expires_at, s.plan_type 
            FROM subscriptions s 
            JOIN users u ON s.user_id = u.tg_id 
            WHERE s.is_active = TRUE 
            AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
        `);
        
        for (const sub of rows) {
            const days = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
            await bot.telegram.sendMessage(
                sub.tg_id,
                `⏰ <b>Подписка "${sub.plan_type}" истекает через ${days} д.</b>\n\n` +
                `👨‍🍳 Продлите, чтобы не потерять доступ к рецептам!\n` +
                `💳 PRO — 500₽ | 💎 VIP — 800₽`,
                { parse_mode: 'HTML' }
            );
            console.log(`🔔 Уведомление отправлено пользователю ${sub.tg_id}`);
        }
        
        // Деактивируем истёкшие подписки
        const { rowCount } = await pool.query(
            `UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW() AND is_active = TRUE`
        );
        if (rowCount > 0) {
            console.log(`✅ Деактивировано ${rowCount} истёкших подписок`);
        }
    } catch (e) {
        console.error('❌ [CRON] Ошибка:', e);
    }
});

// ===== ЗАПУСК =====
async function start() {
    await initDB();
    loadModules();
    
    await bot.launch({
        dropPendingUpdates: true
    });
    
    console.log('🚀 Бот запущен успешно!');
    console.log(`👤 Admin ID: ${ADMIN_ID || 'не задан'}`);
    console.log(`💬 Bot username: @${(await bot.telegram.getMe()).username}`);
    
    // Graceful shutdown
    const stop = (signal) => {
        console.log(`\n🛑 Получен сигнал ${signal}. Остановка бота...`);        bot.stop(signal);
        pool.end();
        process.exit(0);
    };
    
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
}

start().catch(err => {
    console.error('❌ Фатальная ошибка при запуске:', err);
    process.exit(1);
});
