const { Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const fs = require('fs');

module.exports = (bot, pool, ADMIN_ID) => {
    if (!ADMIN_ID) return;
    console.log(`✅ Admin module loaded (ID: ${ADMIN_ID})`);

    // ===== АДМИН /start =====
    bot.start(async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        try {
            const { rows: stats } = await pool.query(`
                SELECT 
                    (SELECT COUNT(*) FROM users) as users,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as subs,
                    (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending
            `);
            
            const msg = `👨‍ <b>Панель администратора</b>\n\n` +
                `📊 <b>Статистика:</b>\n` +
                `• Всего пользователей: ${stats[0].users}\n` +
                `• Активных подписок: ${stats[0].subs}\n` +
                `• Ожидающих оплат: ${stats[0].pending}`;
            
            await ctx.reply(msg, { 
                parse_mode: 'HTML',
                reply_markup: Markup.keyboard([
                    ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
                    ['📊 Статистика', 'ℹ️ Помощь']
                ]).resize()
            });
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    // ===== КНОПКИ АДМИНА =====
    bot.hears('📋 Ожидающие оплаты', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        try {
            const { rows } = await pool.query(`
                SELECT p.id, u.first_name, u.username, p.amount, p.created_at, p.plan_type
                FROM payments p JOIN users u ON p.user_id = u.tg_id 
                WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 10
            `);
            
            if (rows.length === 0) return ctx.reply('✅ Нет ожидающих оплат');
            
            let msg = `📋 <b>Ожидающие оплаты (${rows.length}):</b>\n\n`;
            rows.forEach(r => {
                msg += `<b>#${r.id}</b> — ${r.first_name} (@${r.username || 'нет'})\n`;
                msg += `💎 ${r.plan_type} | 💰 ${r.amount}₽\n\n`;
            });
            ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
    });

    bot.hears('📊 Статистика', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        try {
            const { rows: stats } = await pool.query(`
                SELECT (SELECT COUNT(*) FROM users) as total,
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active,
                (SELECT SUM(amount) FROM payments WHERE status = 'approved') as revenue
            `);
            ctx.reply(`📊 <b>Статистика:</b>\nПользователей: ${stats[0].total}\nПодписок: ${stats[0].active}\nВыручка: ${stats[0].revenue || 0}₽`, { parse_mode: 'HTML' });
        } catch (e) { ctx.reply('❌ Ошибка'); }
    });
    
    bot.hears('ℹ️ Помощь', (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        ctx.reply('📚 Одобрение и отклонение платежей теперь происходит в основном чате.');
    });

    // Заглушка для экспорта (можно вернуть если нужно)
    bot.hears('📥 Экспорт подписок', (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        ctx.reply('🔄 Функция экспорта временно отключена для стабильности.');
    });
};
