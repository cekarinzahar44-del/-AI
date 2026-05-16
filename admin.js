const { Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const fs = require('fs');

module.exports = (bot, pool, ADMIN_ID) => {

    if (!ADMIN_ID) {
        console.warn('⚠️ ADMIN_ID не задан, админка отключена');
        return;
    }

    // ===== АДМИН /start =====
    bot.start(async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return; // Пропускаем дальше
        
        const { rows: stats } = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as users,
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as subs,
                (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending
        `);
        
        const msg = `👨‍ <b>Админ-панель</b>\n\n` +
            `📊 Статистика:\n` +
            `• Пользователей: ${stats[0].users}\n` +
            `• Подписок: ${stats[0].subs}\n` +
            `• Ожидает: ${stats[0].pending}\n\n` +
            `🔧 Управление:`;
        
        ctx.reply(msg, { 
            parse_mode: 'HTML',
            reply_markup: Markup.keyboard([
                ['📋 Ожидающие', '📥 Экспорт'],
                ['📊 Статистика', 'ℹ️ Помощь']
            ]).resize()
        });
    });

    // ===== КНОПКИ АДМИНА =====
    bot.hears('📋 Ожидающие', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        const { rows } = await pool.query(`
            SELECT p.id, u.first_name, p.amount, p.created_at 
            FROM payments p JOIN users u ON p.user_id = u.tg_id 
            WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 10
        `);
        
        if (rows.length === 0) return ctx.reply('✅ Нет ожидающих');
                let msg = `📋 <b>Ожидает (${rows.length}):</b>\n\n`;
        rows.forEach(r => {
            msg += `#${r.id} — ${r.first_name} (${r.amount}₽)\n`;
        });
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.hears('📥 Экспорт', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await ctx.reply('🔄 Генерирую...');
        
        try {
            const { rows } = await pool.query(`
                SELECT u.first_name, u.username, s.expires_at, p.amount
                FROM subscriptions s 
                JOIN users u ON s.user_id = u.tg_id
                LEFT JOIN payments p ON s.payment_receipt_id = p.id::text
                WHERE s.is_active = TRUE
            `);
            
            if (rows.length === 0) return ctx.reply('📭 Нет подписок');
            
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Subscriptions');
            ws.columns = [
                {header:'Имя',key:'name',width:20},
                {header:'Username',key:'user',width:20},
                {header:'Истекает',key:'date',width:20},
                {header:'Сумма',key:'amount',width:10}
            ];
            
            rows.forEach(r => ws.addRow({
                name: r.first_name,
                user: '@' + (r.username || '-'),
                date: new Date(r.expires_at).toLocaleDateString('ru-RU'),
                amount: `${r.amount}₽`
            }));
            
            ws.getRow(1).font = { bold: true };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00AA00' } };
            
            const file = `subs-${Date.now()}.xlsx`;
            await wb.xlsx.writeFile(file);
            await ctx.replyWithDocument({ source: fs.createReadStream(file), filename: 'subscriptions.xlsx' });
            fs.unlinkSync(file);
            
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });
    bot.hears('📊 Статистика', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        const { rows: stats } = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as users,
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active,
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = FALSE) as expired,
                (SELECT COUNT(*) FROM payments WHERE status = 'approved') as approved,
                (SELECT SUM(amount) FROM payments WHERE status = 'approved') as revenue
        `);
        
        const s = stats[0];
        const msg = `📊 <b>Статистика:</b>\n\n` +
            `👥 Пользователи: ${s.users}\n` +
            `✅ Активные: ${s.active}\n` +
            `⏰ Истекли: ${s.expired}\n\n` +
            `💰 Оплаты: ${s.approved}\n` +
            `💵 Выручка: ${s.revenue || 0}₽`;
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.hears('ℹ️ Помощь', (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        ctx.reply('ℹ️ Админ-панель\n\nЖдите уведомления о чеках и нажимайте кнопки.');
    });

    // ===== УВЕДОМЛЕНИЕ АДМИНУ О ЧЕКЕ =====
    bot.on('new_payment', async (data) => {
        const { payId, userId, user, fileId } = data;
        
        try {
            const fileLink = await bot.telegram.getFileLink(fileId);
            await bot.telegram.sendMessage(ADMIN_ID, 
                `🔔 <b>Новый чек #${payId}</b>\n\n` +
                `👤 ${user.first_name} (@${user.username || 'нет'})\n` +
                `💰 ${process.env.SUBSCRIPTION_PRICE || 500}₽\n\n` +
                `[📎 Посмотреть чек](${fileLink})`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Подтвердить', `approve_${payId}`)],
                        [Markup.button.callback('❌ Отклонить', `reject_${payId}`)]
                    ])
                }
            );
        } catch (e) {
            console.error('Notify error:', e);        }
    });

    // ===== ПОДТВЕРЖДЕНИЕ ОПЛАТЫ =====
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒');
        
        const payId = ctx.match[1];
        const SUB_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS) || 30;
        
        try {
            await pool.query(`UPDATE payments SET status='approved', approved_at=NOW() WHERE id=$1`, [payId]);
            
            const { rows } = await pool.query(`SELECT user_id FROM payments WHERE id=$1`, [payId]);
            if (!rows.length) return ctx.answerCbQuery('❌');
            
            const userId = rows[0].user_id;
            const expires = new Date();
            expires.setDate(expires.getDate() + SUB_DAYS);
            
            await pool.query(
                `INSERT INTO subscriptions (user_id, expires_at, payment_receipt_id) VALUES ($1, $2, $3)`,
                [userId, expires, payId]
            );
            
            await ctx.telegram.sendMessage(userId, 
                `🎉 <b>Подписка активирована!</b>\n\n` +
                `✅ Оплата подтверждена\n` +
                `📅 До: ${expires.toLocaleDateString('ru-RU')}\n` +
                `🍳 Готовьте!`,
                { parse_mode: 'HTML' }
            );
            
            ctx.answerCbQuery('✅ Выдана!');
            ctx.editMessageText(`✅ #${payId} подтверждена`);
            
        } catch (e) {
            console.error(e);
            ctx.answerCbQuery('❌ Ошибка');
        }
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒');
        const payId = ctx.match[1];
        await pool.query(`UPDATE payments SET status='rejected' WHERE id=$1`, [payId]);
        ctx.answerCbQuery('❌ Отклонено');
        ctx.editMessageText(`❌ #${payId} отклонена`);
    });
    console.log('✅ Admin module loaded');
};
