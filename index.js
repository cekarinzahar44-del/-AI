// 🔓 Отключаем предупреждения о самоподписанных сертификатах (для разработки)
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

// 🔹 Явные параметры подключения к БД (чтобы избежать ошибок парсинга connectionString)
const DB_CONFIG = {
    host: process.env.DB_HOST || 'node1.pghost.ru',
    port: parseInt(process.env.DB_PORT) || 15698,  // ✅ Правильный порт!
    database: process.env.DB_NAME || 'bothost_db_6f7970830deb',
    user: process.env.DB_USER || 'bothost_db_6f7970830deb',
    password: process.env.DB_PASSWORD, // ← Обязательно задайте в .env!
    
    // 🔐 SSL для удалённого подключения
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    
    // ⏱ Таймауты
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 10 // Максимум подключений в пуле
};

// 🔹 Резервный вариант: если задан DATABASE_URL — используем его
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) {
    console.error('❌ ОШИБКА: Не задан BOT_TOKEN в .env');
    process.exit(1);
}

if (!DB_CONFIG.password && !DATABASE_URL) {
    console.error('❌ ОШИБКА: Не задан пароль от БД (DB_PASSWORD или DATABASE_URL)');
    process.exit(1);
}

console.log('🚀 Запуск Шеф-Повар AI...');
console.log(`📦 Node ${process.version} | Port ${PORT}`);

// ===== ПОДКЛЮЧЕНИЕ К БД =====
let pool;
function createPool() {
    if (DATABASE_URL) {
        console.log('🗄️ Подключение через DATABASE_URL');
        return new Pool({ 
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 15000
        });
    } else {
        console.log(`🗄️ Подключение через параметры: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
        return new Pool(DB_CONFIG);
    }
}

// ===== ИНИЦИАЛИЗАЦИЯ БОТА =====
const bot = new Telegraf(BOT_TOKEN);

// ===== HTTP СЕРВЕР (для хостинга / health checks) =====
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('👨‍🍳 Шеф-Повар AI Bot работает!\nВерсия: 2.1');
    }
});

// ===== ИНИЦИАЛИЗАЦИЯ БД с повторными попытками =====
async function initDB(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔄 Попытка подключения к БД #${attempt}/${retries}...`);
            
            pool = createPool();
            
            // Проверяем подключение
            const client = await pool.connect();
            const res = await client.query('SELECT NOW() as server_time, version()');
            client.release();
            
            const pgVersion = res.rows[0].version.split('\n')[0];
            const serverTime = res.rows[0].server_time;
            
            console.log(`✅ БД подключена! PostgreSQL: ${pgVersion}`);
            console.log(`🕐 Время сервера БД: ${serverTime}`);
            
            // Создаём таблицы, если не существуют
            await createTables();
                        return true;
            
        } catch (err) {
            console.warn(`⚠️ Попытка #${attempt} не удалась: ${err.message}`);
            
            if (attempt === retries) {
                console.error('❌ Не удалось подключиться к БД после всех попыток');
                console.error('🔎 Детали ошибки:', {
                    code: err.code,
                    errno: err.errno,
                    syscall: err.syscall,
                    address: err.address,
                    port: err.port
                });
                throw err;
            }
            
            // Ждём перед следующей попыткой
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function createTables() {
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
            status VARCHAR(20) DEFAULT 'pending',            plan_type VARCHAR(10) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            approved_by BIGINT,
            approved_at TIMESTAMP
        )`);
        
        // Индексы для ускорения
        await pool.query('CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(is_active, expires_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)');
        
        console.log('✅ Таблицы проверены/созданы');
    } catch (err) {
        console.error('❌ Ошибка создания таблиц:', err.message);
        throw err;
    }
}

// ===== ПОДКЛЮЧЕНИЕ МОДУЛЕЙ =====
function loadModules() {
    try {
        require('./admin')(bot, pool, ADMIN_ID);
        require('./bot')(bot, pool, ADMIN_ID);
        console.log('✅ Модули загружены: bot, admin');
        return true;
    } catch (err) {
        console.error('❌ Ошибка загрузки модулей:', err.message);
        console.error(err.stack);
        return false;
    }
}

// ===== КРОН: Напоминания об окончании подписки =====
function setupCron() {
    // Ежедневно в 10:00 проверяем подписки
    cron.schedule('0 10 * * *', async () => {
        console.log('⏰ [CRON] Проверка подписок...');
        try {
            const { rows } = await pool.query(`
                SELECT u.tg_id, u.first_name, s.expires_at, s.plan_type 
                FROM subscriptions s 
                JOIN users u ON s.user_id = u.tg_id 
                WHERE s.is_active = TRUE 
                AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
            `);
            
            for (const sub of rows) {
                const days = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);                await bot.telegram.sendMessage(
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
            console.error('❌ [CRON] Ошибка:', e.message);
        }
    }, { timezone: 'Europe/Moscow' });
    
    console.log('✅ Cron-задачи настроены');
}

// ===== ОБРАБОТКА СИГНАЛОВ ЗАВЕРШЕНИЯ =====
function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        console.log(`\n🛑 Получен сигнал ${signal}. Завершение работы...`);
        
        // Останавливаем бота
        try {
            await bot.stop(signal);
            console.log('✅ Бот остановлен');
        } catch (e) {
            console.error('⚠️ Ошибка при остановке бота:', e.message);
        }
        
        // Закрываем пул БД
        try {
            await pool?.end();
            console.log('✅ Подключения к БД закрыты');
        } catch (e) {
            console.error('⚠️ Ошибка при закрытии БД:', e.message);
        }
        
        // Закрываем HTTP-сервер
        server.close(() => {
            console.log('✅ HTTP-сервер закрыт');
            process.exit(0);        });
        
        // Экстренный выход через 10 сек, если сервер не закрылся
        setTimeout(() => {
            console.warn('⚠️ Принудительное завершение');
            process.exit(1);
        }, 10000);
    };
    
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    
    // Обработка необработанных ошибок
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    });
    
    process.on('uncaughtException', (err) => {
        console.error('❌ Uncaught Exception:', err);
        // Не завершаем процесс сразу — даём боту шанс восстановиться
    });
}

// ===== ЗАПУСК =====
async function start() {
    try {
        // 1. Инициализируем БД
        await initDB();
        
        // 2. Загружаем модули
        if (!loadModules()) {
            throw new Error('Не удалось загрузить модули бота');
        }
        
        // 3. Настраиваем cron
        setupCron();
        
        // 4. Запускаем бота
        await bot.launch({
            dropPendingUpdates: true
        });
        
        const botInfo = await bot.telegram.getMe();
        console.log('🚀 Бот запущен успешно!');
        console.log(`🤖 Bot: @${botInfo.username} (ID: ${botInfo.id})`);
        console.log(`👤 Admin ID: ${ADMIN_ID || 'не задан'}`);
        console.log(`🌐 HTTP: http://localhost:${PORT}/health`);
        
        // 5. Запускаем HTTP-сервер
        server.listen(PORT, () => {            console.log(`🌐 HTTP-сервер слушает порт ${PORT}`);
        });
        
        // 6. Настраиваем завершение
        setupGracefulShutdown();
        
    } catch (err) {
        console.error('❌ Фатальная ошибка при запуске:', err.message);
        console.error(err.stack);
        
        // Пробуем закрыть ресурсы
        await pool?.end();
        server.close();
        
        process.exit(1);
    }
}

// 🔥 Запускаем
start();

// Экспорт для тестов (опционально)
module.exports = { bot, pool, DB_CONFIG };
