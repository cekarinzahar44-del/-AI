// Отключаем предупреждения о SSL (для хостинговых БД)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// dotenv нужен только для локальных тестов, на BotHost он просто игнорируется
require('dotenv').config();

const { Telegraf } = require('telegraf');
const http = require('http');
const { Pool } = require('pg');
const cron = require('node-cron');

// === ЧИТАЕМ ПЕРЕМЕННЫЕ ИЗ ПАНЕЛИ БОТХОСТ ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const PORT = parseInt(process.env.PORT) || 3000;

if (!BOT_TOKEN) {
    console.error('❌ ОШИБКА: Не задан BOT_TOKEN в панели хостинга');
    process.exit(1);
}

console.log('🚀 Запуск Шеф-Повар AI...');

// === КОНФИГУРАЦИЯ БД: ПРИОРИТЕТ У DATABASE_URL ===
let dbConfig;

if (process.env.DATABASE_URL) {
    console.log('🗄️ Использую DATABASE_URL из панели BotHost');
    dbConfig = {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
        max: 10
    };
} else if (process.env.DB_HOST && process.env.DB_PASSWORD) {
    console.log('🗄️ Использую отдельные переменные БД');
    dbConfig = {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 15000,
        max: 10
    };
} else {
    console.error('❌ ОШИБКА: Не найдены DATABASE_URL или DB_HOST/DB_PASSWORD в панели хостинга');
    process.exit(1);
}
// Безопасный лог (скрываем пароль)
const logConn = dbConfig.connectionString
    ? dbConfig.connectionString.replace(/:([^:@]+)@/, ':***@')
    : `${dbConfig.user}:***@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;
console.log(`🔗 Подключение к БД: ${logConn}`);

const pool = new Pool(dbConfig);
const bot = new Telegraf(BOT_TOKEN);

// HTTP-сервер для health-check
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('👨‍🍳 Шеф-Повар AI Bot работает!');
});

// === ИНИЦИАЛИЗАЦИЯ БД ===
async function initDB() {
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('✅ База данных подключена успешно');
    } catch (err) {
        console.error('❌ Ошибка подключения к БД:', err.message);
        console.error('💡 Проверьте в панели BotHost:');
        console.error('   • Привязана ли БД к проекту бота?');
        console.error('   • Правильный ли порт в DATABASE_URL?');
        throw err;
    }

    // Создаём таблицы
    const queries = [
        `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, tg_id BIGINT UNIQUE NOT NULL, username TEXT, first_name TEXT, free_recipes_used INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE, starts_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP NOT NULL, is_active BOOLEAN DEFAULT TRUE, plan_type VARCHAR(10) DEFAULT 'PRO', payment_receipt_id TEXT)`,
        `CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(tg_id), amount INTEGER NOT NULL, receipt_file_id TEXT NOT NULL, status VARCHAR(20) DEFAULT 'pending', plan_type VARCHAR(10) NOT NULL, created_at TIMESTAMP DEFAULT NOW(), approved_by BIGINT, approved_at TIMESTAMP)`
    ];

    for (const q of queries) await pool.query(q);

    // Индексы
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id)',
        'CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(is_active, expires_at)',
        'CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)'
    ];
    for (const q of indexes) await pool.query(q).catch(() => {});
    console.log('✅ Таблицы и индексы готовы');
}

// === ЗАГРУЗКА МОДУЛЕЙ ===
function loadModules() {
    try {
        require('./admin')(bot, pool, ADMIN_ID);
        require('./bot')(bot, pool, ADMIN_ID);
        console.log('✅ Модули bot.js и admin.js загружены');
        return true;
    } catch (e) {
        console.error('❌ Ошибка загрузки модулей:', e.message);
        return false;
    }
}

// === CRON ===
function setupCron() {
    cron.schedule('0 10 * * *', async () => {
        console.log('⏰ [CRON] Проверка подписок...');
        try {
            const { rows } = await pool.query(`
                SELECT u.tg_id, s.expires_at, s.plan_type FROM subscriptions s
                JOIN users u ON s.user_id = u.tg_id
                WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
            `);
            for (const s of rows) {
                const days = Math.ceil((new Date(s.expires_at) - new Date()) / 86400000);
                await bot.telegram.sendMessage(s.tg_id,
                    `⏰ <b>Подписка "${s.plan_type}" истекает через ${days} д.</b>\nПродлите доступ!`,
                    { parse_mode: 'HTML' }
                );
            }
            await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW()`);
            console.log('✅ CRON выполнен');
        } catch (e) { console.error('CRON error:', e.message); }
    }, { timezone: 'Europe/Moscow' });
}

// === ЗАПУСК ===
async function start() {
    await initDB();
    loadModules();
    setupCron();

    await bot.launch({ dropPendingUpdates: true });
    const me = await bot.telegram.getMe();
    console.log(`🚀 Бот запущен: @${me.username} | Admin: ${ADMIN_ID || 'не задан'}`);

    server.listen(PORT, () => console.log(`🌐 HTTP на порту ${PORT}`));
    process.once('SIGINT', () => { bot.stop('SIGINT'); pool.end(); process.exit(0); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); pool.end(); process.exit(0); });
}

start().catch(err => {
    console.error('❌ Фатальная ошибка:', err.message);
    process.exit(1);
});
