// 🔓 Отключаем проверку SSL (для хостинга)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const http = require('http');
const { GigaChat } = require('gigachat');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const fs = require('fs');
const cron = require('node-cron');

// ===== КОНФИГ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const SUB_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS) || 30;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
const FREE_LIMIT = 3;

if (!BOT_TOKEN || !GIGA_CREDENTIALS) {
    console.error('❌ Ошибка: Не заданы BOT_TOKEN или GIGACHAT_CREDENTIALS');
    process.exit(1);
}

// ===== БД =====
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

// ===== GigaChat =====
const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

// ===== Бот =====
const bot = new Telegraf(BOT_TOKEN);

// ===== Сервер (для Bothost) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('👨‍🍳 Home Chef Bot is running!');
}).listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,         tg_id BIGINT UNIQUE NOT NULL,
        username TEXT, 
        first_name TEXT, 
        free_recipes_used INTEGER DEFAULT 0,
        is_admin BOOLEAN DEFAULT FALSE, 
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY, 
        user_id BIGINT REFERENCES users(tg_id) ON DELETE CASCADE,
        starts_at TIMESTAMP DEFAULT NOW(), 
        expires_at TIMESTAMP NOT NULL,
        is_active BOOLEAN DEFAULT TRUE, 
        payment_receipt_id TEXT
    )`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY, 
        user_id BIGINT REFERENCES users(tg_id),
        amount INTEGER NOT NULL, 
        receipt_file_id TEXT NOT NULL,
        receipt_caption TEXT, 
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(), 
        approved_by BIGINT, 
        approved_at TIMESTAMP
    )`);
    
    await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_subs_expires ON subscriptions(expires_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)');
    
    console.log('✅ БД инициализирована');
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
async function getUser(tgId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    return rows[0];
}

async function createUser(tgId, username, firstName) {
    await pool.query(
        'INSERT INTO users (tg_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT (tg_id) DO NOTHING',
        [tgId, username, firstName]
    );
}

async function hasActiveSubscription(tgId) {    const { rows } = await pool.query(
        'SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW()',
        [tgId]
    );
    return rows.length > 0;
}

async function getSubscription(tgId) {
    const { rows } = await pool.query(
        'SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = TRUE ORDER BY expires_at DESC LIMIT 1',
        [tgId]
    );
    return rows[0];
}

async function incrementFreeRecipes(tgId) {
    await pool.query('UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id = $1', [tgId]);
}

async function getFreeRecipesUsed(tgId) {
    const user = await getUser(tgId);
    return user ? user.free_recipes_used : 0;
}

// ===== КОМАНДА /start =====
bot.start(async (ctx) => {
    const tgId = ctx.from.id;
    await createUser(tgId, ctx.from.username, ctx.from.first_name);
    
    const isAdmin = tgId === ADMIN_ID;
    const sub = await getSubscription(tgId);
    
    if (isAdmin) {
        // АДМИН-ПАНЕЛЬ
        const { rows: stats } = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active_subs,
                (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_payments
        `);
        
        const msg = `👨‍💼 <b>Панель администратора</b>\n\n` +
            `📊 <b>Статистика:</b>\n` +
            `• Всего пользователей: ${stats[0].total_users}\n` +
            `• Активных подписок: ${stats[0].active_subs}\n` +
            `• Ожидающих оплат: ${stats[0].pending_payments}\n\n` +
            `🔧 <b>Управление:</b>`;
        
        return ctx.reply(msg, { 
            parse_mode: 'HTML',            reply_markup: Markup.keyboard([
                ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
                ['📊 Статистика', '🔍 Поиск пользователя'],
                ['⚙️ Настройки', 'ℹ️ Помощь']
            ]).resize()
        });
    }
    
    // ОБЫЧНЫЙ ПОЛЬЗОВАТЕЛЬ
    let msg = '👋 Привет! Я <b>Домашний Шеф</b> 🍳\n\n';
    msg += 'Напиши продукты, которые есть дома, и я придумаю рецепт!\n';
    msg += `🎁 У тебя <b>${FREE_LIMIT} бесплатных рецепта</b>.\n\n`;
    
    if (sub) {
        const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
        msg += `✅ Ваша подписка активна до ${new Date(sub.expires_at).toLocaleDateString('ru-RU')}\n`;
        msg += `⏳ Осталось дней: <b>${daysLeft}</b>`;
    } else {
        const freeUsed = await getFreeRecipesUsed(tgId);
        msg += `📊 Использовано: ${freeUsed} из ${FREE_LIMIT}`;
    }
    
    ctx.reply(msg, { parse_mode: 'HTML' });
});

// ===== АДМИН: КНОПКИ =====

bot.hears('📋 Ожидающие оплаты', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const { rows } = await pool.query(`
        SELECT p.id, u.first_name, u.username, p.amount, p.created_at
        FROM payments p
        JOIN users u ON p.user_id = u.tg_id
        WHERE p.status = 'pending'
        ORDER BY p.created_at DESC
        LIMIT 10
    `);
    
    if (rows.length === 0) return ctx.reply('✅ Нет ожидающих оплат');
    
    let msg = `📋 <b>Ожидающие оплаты (${rows.length}):</b>\n\n`;
    rows.forEach(r => {
        msg += `<b>#${r.id}</b> — ${r.first_name} (@${r.username || 'нет'})\n`;
        msg += `💰 ${r.amount}₽ | 🕐 ${new Date(r.created_at).toLocaleString('ru-RU')}\n\n`;
    });
    
    ctx.reply(msg, { parse_mode: 'HTML' });
});
bot.hears('📥 Экспорт подписок', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    await ctx.reply('🔄 Генерирую Excel...');
    
    try {
        const { rows } = await pool.query(`
            SELECT 
                u.tg_id, u.first_name, u.username,
                s.starts_at, s.expires_at,
                EXTRACT(DAY FROM (s.expires_at - NOW())) as days_left,
                p.amount, p.created_at as payment_date
            FROM subscriptions s
            JOIN users u ON s.user_id = u.tg_id
            LEFT JOIN payments p ON s.payment_receipt_id = p.id::text
            WHERE s.is_active = TRUE
            ORDER BY s.expires_at ASC
        `);
        
        if (rows.length === 0) return ctx.reply('📭 Нет активных подписок');
        
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Подписки');
        
        ws.columns = [
            { header: 'TG ID', key: 'tg_id', width: 15 },
            { header: 'Имя', key: 'name', width: 20 },
            { header: 'Username', key: 'username', width: 20 },
            { header: 'Начало', key: 'starts', width: 20 },
            { header: 'Окончание', key: 'expires', width: 20 },
            { header: 'Дней осталось', key: 'days', width: 15 },
            { header: 'Сумма', key: 'amount', width: 10 },
            { header: 'Дата оплаты', key: 'paid_at', width: 20 }
        ];
        
        rows.forEach(r => ws.addRow({
            tg_id: r.tg_id,
            name: r.first_name || '-',
            username: r.username ? '@' + r.username : '-',
            starts: new Date(r.starts_at).toLocaleString('ru-RU'),
            expires: new Date(r.expires_at).toLocaleString('ru-RU'),
            days: Math.ceil(r.days_left),
            amount: `${r.amount}₽`,
            paid_at: r.payment_date ? new Date(r.payment_date).toLocaleString('ru-RU') : '-'
        }));
        
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00AA00' } };
        
        const fileName = `subscriptions-${Date.now()}.xlsx`;        await workbook.xlsx.writeFile(fileName);
        
        await ctx.replyWithDocument({
            source: fs.createReadStream(fileName),
            filename: 'active-subscriptions.xlsx'
        });
        
        fs.unlinkSync(fileName);
        
    } catch (e) {
        console.error('Export error:', e);
        ctx.reply('❌ Ошибка экспорта: ' + e.message);
    }
});

bot.hears('📊 Статистика', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const { rows: stats } = await pool.query(`
        SELECT 
            (SELECT COUNT(*) FROM users) as total_users,
            (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active_subs,
            (SELECT COUNT(*) FROM subscriptions WHERE is_active = FALSE) as expired_subs,
            (SELECT COUNT(*) FROM payments WHERE status = 'approved') as approved_payments,
            (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_payments,
            (SELECT SUM(amount) FROM payments WHERE status = 'approved') as total_revenue
    `);
    
    const s = stats[0];
    const msg = `📊 <b>Полная статистика:</b>\n\n` +
        `👥 <b>Пользователи:</b>\n` +
        `• Всего: ${s.total_users}\n` +
        `• С подпиской: ${s.active_subs}\n` +
        `• Истекло: ${s.expired_subs}\n\n` +
        `💰 <b>Финансы:</b>\n` +
        `• Подтверждено оплат: ${s.approved_payments}\n` +
        `• Ожидает: ${s.pending_payments}\n` +
        `• Выручка: ${s.total_revenue || 0}₽\n\n` +
        `📈 Конверсия: ${s.total_users > 0 ? Math.round((s.active_subs / s.total_users) * 100) : 0}%`;
    
    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.hears('🔍 Поиск пользователя', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('🔍 Введите TG ID пользователя для поиска:\n\n(Функция в разработке)');
});

bot.hears('⚙️ Настройки', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;    ctx.reply('⚙️ <b>Настройки бота:</b>\n\n' +
        `• Цена подписки: ${SUB_PRICE}₽\n` +
        `• Длительность: ${SUB_DAYS} дн.\n` +
        `• Бесплатных рецептов: ${FREE_LIMIT}\n` +
        `• СБП номер: ${SBP_PHONE}\n` +
        `• Получатель: ${SBP_RECIPIENT}`, { parse_mode: 'HTML' });
});

bot.hears('ℹ️ Помощь', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('📚 <b>Справка для админа:</b>\n\n' +
        '<b>Команды:</b>\n' +
        '/pending — список ожидающих оплат\n' +
        '/export_subs — экспорт в Excel\n' +
        '/admin — админ-панель\n\n' +
        '<b>Как работает:</b>\n' +
        '1. Пользователь присылает чек\n' +
        '2. Вам приходит уведомление с кнопками\n' +
        '3. Нажмите ✅ для активации подписки\n' +
        '4. Бот сам уведомит пользователя', { parse_mode: 'HTML' });
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply('🔒 Доступ запрещён');
    }
    await ctx.reply('👨‍💼 Открыта админ-панель...');
    bot.emit('message', { from: ctx.from, chat: ctx.chat, text: '/start' });
});

// ===== ОБРАБОТКА ТЕКСТА (ЗАПРОС РЕЦЕПТА) =====
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const tgId = ctx.from.id;
    
    if (text.startsWith('/')) return;
    
    await createUser(tgId, ctx.from.username, ctx.from.first_name);
    
    const hasSub = await hasActiveSubscription(tgId);
    const freeUsed = await getFreeRecipesUsed(tgId);
    
    if (!hasSub && freeUsed >= FREE_LIMIT) {
        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('💳 Оформить подписку — 500₽', 'pay_subscribe')
        ]);
        return ctx.reply(
            `🔒 <b>Пробная версия завершена!</b>\n\n` +
            `Вы использовали все ${FREE_LIMIT} бесплатных рецепта.\n` +
            `📅 Подписка на месяц — <b>${SUB_PRICE}₽</b>\n` +            `✅ Неограниченные рецепты`,
            { parse_mode: 'HTML', ...keyboard }
        );
    }
    
    await ctx.replyWithChatAction('typing');
    try {
        const response = await giga.chat({
            model: 'GigaChat',
            messages: [
                { role: 'system', content: 'Ты профессиональный повар. Дай подробный рецепт из указанных продуктов. Укажи ингредиенты и шаги приготовления.' },
                { role: 'user', content: `Продукты: ${text}` }
            ],
            max_tokens: 1500
        });
        
        const recipe = response.choices[0].message.content;
        await ctx.reply(recipe, { parse_mode: 'HTML' });
        
        if (!hasSub) {
            await incrementFreeRecipes(tgId);
            const newCount = freeUsed + 1;
            if (newCount < FREE_LIMIT) {
                await ctx.reply(`🎁 Осталось бесплатных рецептов: <b>${FREE_LIMIT - newCount}</b>`, { parse_mode: 'HTML' });
            }
        }
    } catch (e) {
        ctx.reply('❌ Ошибка генерации: ' + e.message);
    }
});

// ===== КНОПКА ОПЛАТЫ =====
bot.action('pay_subscribe', async (ctx) => {
    await ctx.answerCbQuery();
    
    const paymentMsg = 
`💳 <b>Оплата подписки — ${SUB_PRICE}₽ / месяц</b>

1️⃣ Переведите <b>${SUB_PRICE}₽</b> по СБП:
📱 Номер: <code>${SBP_PHONE}</code>
👤 Получатель: ${SBP_RECIPIENT}
🏦 Банки: 🟢 Сбер, 🔵 ВТБ, 🟡 Т-банк

2️⃣ После оплаты пришлите сюда <b>чек</b> (скриншот или PDF).

⏱ Подписка активируется в течение 5 минут после проверки.`;

    ctx.reply(paymentMsg, { 
        parse_mode: 'HTML',
        reply_markup: Markup.forceReply({ placeholder: '📎 Прикрепите чек здесь' })    });
});

// ===== ОБРАБОТКА ЧЕКОВ =====
bot.on(['photo', 'document'], async (ctx) => {
    const tgId = ctx.from.id;
    const user = await getUser(tgId);
    
    if (!user) return;
    
    let fileId;
    if (ctx.message.photo) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.document) {
        if (!ctx.message.document.mime_type?.startsWith('image/') && 
            ctx.message.document.mime_type !== 'application/pdf') {
            return;
        }
        fileId = ctx.message.document.file_id;
    }
    
    if (!fileId) return;
    
    const { rows } = await pool.query(
        `INSERT INTO payments (user_id, amount, receipt_file_id, receipt_caption) 
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tgId, SUB_PRICE, fileId, ctx.message.caption || '']
    );
    
    const paymentId = rows[0].id;
    
    await ctx.reply(
        `✅ Чек получен! <b>Заявка #${paymentId}</b>\n\n` +
        `Администратор проверит оплату и активирует подписку. Обычно это занимает до 5 минут.`,
        { parse_mode: 'HTML' }
    );
    
    if (ADMIN_ID) {
        const fileInfo = await ctx.telegram.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        
        await ctx.telegram.sendMessage(ADMIN_ID, 
            `🔔 <b>Новая оплата!</b>\n\n` +
            `👤 Пользователь: ${user.first_name || user.username} (@${user.username || 'нет'})\n` +
            `💰 Сумма: ${SUB_PRICE}₽\n` +
            `📎 Чек: ${fileUrl}\n\n` +
            `Подтвердить оплату:`,
            { 
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([                    Markup.button.callback('✅ Подтвердить', `approve_pay_${paymentId}`),
                    Markup.button.callback('❌ Отклонить', `reject_pay_${paymentId}`)
                ])
            }
        );
    }
});

// ===== АДМИН: ПОДТВЕРЖДЕНИЕ ОПЛАТЫ =====
bot.action(/^approve_pay_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Доступ запрещён');
    
    const paymentId = ctx.match[1];
    
    try {
        await pool.query(
            `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`,
            [ADMIN_ID, paymentId]
        );
        
        const { rows: payRows } = await pool.query(
            `SELECT p.user_id, u.first_name FROM payments p 
             JOIN users u ON p.user_id = u.tg_id WHERE p.id = $1`,
            [paymentId]
        );
        
        if (payRows.length === 0) return ctx.answerCbQuery('❌ Платёж не найден');
        
        const userId = payRows[0].user_id;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + SUB_DAYS);
        
        await pool.query(
            `INSERT INTO subscriptions (user_id, expires_at, payment_receipt_id) 
             VALUES ($1, $2, $3)`,
            [userId, expiresAt, paymentId]
        );
        
        await ctx.telegram.sendMessage(userId,
            `🎉 <b>Подписка активирована!</b>\n\n` +
            `✅ Оплата ${SUB_PRICE}₽ подтверждена\n` +
            `📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}\n` +
            `🍳 Теперь вы можете получать неограниченное количество рецептов!`,
            { parse_mode: 'HTML' }
        );
        
        await ctx.answerCbQuery('✅ Подписка активирована!');
        await ctx.editMessageText(`✅ Заявка #${paymentId} подтверждена`);
            } catch (e) {
        console.error('Approval error:', e);
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action(/^reject_pay_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Доступ запрещён');
    
    const paymentId = ctx.match[1];
    
    await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]);
    await ctx.answerCbQuery('❌ Отклонено');
    await ctx.editMessageText(`❌ Заявка #${paymentId} отклонена`);
});

// ===== АДМИН: КОМАНДЫ =====
bot.command('pending', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('🔒 Только для админа');
    
    const { rows } = await pool.query(`
        SELECT p.id, u.first_name, u.username, p.amount, p.created_at
        FROM payments p
        JOIN users u ON p.user_id = u.tg_id
        WHERE p.status = 'pending'
        ORDER BY p.created_at DESC
        LIMIT 10
    `);
    
    if (rows.length === 0) return ctx.reply('✅ Нет ожидающих оплат');
    
    let msg = `📋 <b>Ожидающие оплаты (${rows.length}):</b>\n\n`;
    rows.forEach(r => {
        msg += `#${r.id} — ${r.first_name} (@${r.username || 'нет'}) — ${r.amount}₽ — ${new Date(r.created_at).toLocaleString('ru-RU')}\n`;
    });
    
    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('export_subs', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('🔒 Только для админа');
    
    await ctx.reply('🔄 Генерирую отчёт...');
    
    try {
        const { rows } = await pool.query(`
            SELECT 
                u.tg_id, u.first_name, u.username,
                s.starts_at, s.expires_at,
                EXTRACT(DAY FROM (s.expires_at - NOW())) as days_left,                p.amount, p.created_at as payment_date
            FROM subscriptions s
            JOIN users u ON s.user_id = u.tg_id
            LEFT JOIN payments p ON s.payment_receipt_id = p.id::text
            WHERE s.is_active = TRUE
            ORDER BY s.expires_at ASC
        `);
        
        if (rows.length === 0) return ctx.reply('📭 Нет активных подписок');
        
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Подписки');
        
        ws.columns = [
            { header: 'TG ID', key: 'tg_id', width: 15 },
            { header: 'Имя', key: 'name', width: 20 },
            { header: 'Username', key: 'username', width: 20 },
            { header: 'Начало', key: 'starts', width: 20 },
            { header: 'Окончание', key: 'expires', width: 20 },
            { header: 'Дней осталось', key: 'days', width: 15 },
            { header: 'Сумма', key: 'amount', width: 10 },
            { header: 'Дата оплаты', key: 'paid_at', width: 20 }
        ];
        
        rows.forEach(r => ws.addRow({
            tg_id: r.tg_id,
            name: r.first_name || '-',
            username: r.username ? '@' + r.username : '-',
            starts: new Date(r.starts_at).toLocaleString('ru-RU'),
            expires: new Date(r.expires_at).toLocaleString('ru-RU'),
            days: Math.ceil(r.days_left),
            amount: `${r.amount}₽`,
            paid_at: r.payment_date ? new Date(r.payment_date).toLocaleString('ru-RU') : '-'
        }));
        
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00AA00' } };
        
        const fileName = `subscriptions-${Date.now()}.xlsx`;
        await workbook.xlsx.writeFile(fileName);
        
        await ctx.replyWithDocument({
            source: fs.createReadStream(fileName),
            filename: 'active-subscriptions.xlsx'
        });
        
        fs.unlinkSync(fileName);
        
    } catch (e) {
        console.error('Export error:', e);        ctx.reply('❌ Ошибка экспорта: ' + e.message);
    }
});

// ===== КРОН: УВЕДОМЛЕНИЯ =====
cron.schedule('0 10 * * *', async () => {
    console.log('🔄 Проверка подписок...');
    
    try {
        const { rows: soon } = await pool.query(`
            SELECT s.user_id, u.tg_id, u.first_name, s.expires_at
            FROM subscriptions s
            JOIN users u ON s.user_id = u.tg_id
            WHERE s.is_active = TRUE 
            AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
        `);
        
        for (const sub of soon) {
            const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
            try {
                await bot.telegram.sendMessage(sub.tg_id,
                    `⏰ <b>Напоминание о подписке</b>\n\n` +
                    `Ваша подписка на «Домашний Шеф» истекает через <b>${daysLeft} д.</b>\n` +
                    `📅 Дата окончания: ${new Date(sub.expires_at).toLocaleDateString('ru-RU')}\n\n` +
                    `Чтобы продлить, напишите /start или кнопку «Оформить подписку» в любом запросе рецепта.`,
                    { parse_mode: 'HTML' }
                );
                console.log(`🔔 Уведомление отправлено пользователю ${sub.tg_id}`);
            } catch (e) {
                console.error(`Не удалось отправить уведомление ${sub.tg_id}:`, e.message);
            }
        }
        
        await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE expires_at < NOW() AND is_active = TRUE`);
        console.log('✅ Истёкшие подписки деактивированы');
        
    } catch (e) {
        console.error('Cron error:', e);
    }
});

// ===== ЗАПУСК =====
async function start() {
    await initDB();
    await bot.launch();
    console.log('🚀 Bot started!');
}
start();

process.once('SIGINT', () => bot.stop('SIGINT'));process.once('SIGTERM', () => bot.stop('SIGTERM'));
