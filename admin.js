const { Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const fs = require('fs');

module.exports = (bot, pool, ADMIN_ID) => {

    if (!ADMIN_ID) {
        console.warn('⚠️ ADMIN_ID не задан, админка отключена');
        return;
    }

    console.log(`✅ Admin module loaded (Admin ID: ${ADMIN_ID})`);

    // ===== АДМИН /start =====
    bot.start(async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return; // Пропускаем, пусть обрабатывает bot.js
        
        try {
            const { rows: stats } = await pool.query(`
                SELECT 
                    (SELECT COUNT(*) FROM users) as users,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as subs,
                    (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending
            `);
            
            const msg = `👨‍💼 <b>Панель администратора</b>\n\n` +
                `📊 <b>Статистика:</b>\n` +
                `• Всего пользователей: ${stats[0].users}\n` +
                `• Активных подписок: ${stats[0].subs}\n` +
                `• Ожидающих оплат: ${stats[0].pending}\n\n` +
                `🔧 <b>Управление:</b>`;
            
            await ctx.reply(msg, { 
                parse_mode: 'HTML',
                reply_markup: Markup.keyboard([
                    ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
                    ['📊 Статистика', 'ℹ️ Помощь']
                ]).resize()
            });
        } catch (e) {
            console.error('Admin start error:', e);
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    // ===== КНОПКИ АДМИНА =====
    bot.hears('📋 Ожидающие оплаты', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        try {            const { rows } = await pool.query(`
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
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    bot.hears('📥 Экспорт подписок', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        await ctx.reply('🔄 Генерирую Excel...');
        
        try {
            const { rows } = await pool.query(`
                SELECT 
                    u.tg_id, u.first_name, u.username,
                    s.starts_at, s.expires_at,
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
                { header: 'Username', key: 'username', width: 20 },                { header: 'Начало', key: 'starts', width: 20 },
                { header: 'Окончание', key: 'expires', width: 20 },
                { header: 'Сумма', key: 'amount', width: 10 },
                { header: 'Дата оплаты', key: 'paid_at', width: 20 }
            ];
            
            rows.forEach(r => ws.addRow({
                tg_id: r.tg_id,
                name: r.first_name || '-',
                username: r.username ? '@' + r.username : '-',
                starts: new Date(r.starts_at).toLocaleString('ru-RU'),
                expires: new Date(r.expires_at).toLocaleString('ru-RU'),
                amount: `${r.amount}₽`,
                paid_at: r.payment_date ? new Date(r.payment_date).toLocaleString('ru-RU') : '-'
            }));
            
            ws.getRow(1).font = { bold: true };
            ws.getRow(1).fill = { 
                type: 'pattern', 
                pattern: 'solid', 
                fgColor: { argb: 'FF00AA00' } 
            };
            
            const fileName = `subscriptions-${Date.now()}.xlsx`;
            await workbook.xlsx.writeFile(fileName);
            
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
        
        try {
            const { rows: stats } = await pool.query(`
                SELECT 
                    (SELECT COUNT(*) FROM users) as total_users,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active_subs,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = FALSE) as expired_subs,
                    (SELECT COUNT(*) FROM payments WHERE status = 'approved') as approved_payments,
                    (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_payments,                    (SELECT SUM(amount) FROM payments WHERE status = 'approved') as total_revenue
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
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    bot.hears('ℹ️ Помощь', (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        ctx.reply('📚 <b>Справка для админа:</b>\n\n' +
            'Когда пользователь присылает чек,\n' +
            'вам придёт уведомление с кнопками:\n' +
            '✅ Подтвердить — активирует подписку\n' +
            '❌ Отклонить — отклоняет заявку\n\n' +
            'Также используйте кнопки меню выше.');
    });

    // ===== ОБРАБОТКА КНОПОК =====
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }
        
        const payId = ctx.match[1];
        
        try {
            await ctx.answerCbQuery('⏳ Активация...');
            
            // Обновляем платёж
            await pool.query(
                `UPDATE payments SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2`,
                [ADMIN_ID, payId]
            );
            
            // Находим пользователя
            const { rows } = await pool.query(                `SELECT user_id FROM payments WHERE id=$1`, 
                [payId]
            );
            
            if (!rows.length) {
                return ctx.answerCbQuery('❌ Платёж не найден', { show_alert: true });
            }
            
            const userId = rows[0].user_id;
            const SUB_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS) || 30;
            const expires = new Date();
            expires.setDate(expires.getDate() + SUB_DAYS);
            
            // Создаём подписку
            await pool.query(
                `INSERT INTO subscriptions (user_id, expires_at, payment_receipt_id) 
                 VALUES ($1, $2, $3)`,
                [userId, expires, payId]
            );
            
            // Уведомляем пользователя
            await ctx.telegram.sendMessage(
                userId,
                `🎉 <b>Подписка активирована!</b>\n\n` +
                `✅ Оплата ${process.env.SUBSCRIPTION_PRICE || 500}₽ подтверждена\n` +
                `📅 Действует до: ${expires.toLocaleDateString('ru-RU')}\n` +
                `🍳 Теперь у вас неограниченный доступ к рецептам!`,
                { parse_mode: 'HTML' }
            );
            
            // Обновляем сообщение админа
            await ctx.editMessageText(`✅ <b>Заявка #${payId} подтверждена!</b>\nПодписка выдана пользователю ${userId}`);
            
            await ctx.answerCbQuery('✅ Подписка выдана!', { show_alert: false });
            console.log(`✅ Подписка выдана пользователю ${userId} (чек #${payId})`);
            
        } catch (e) {
            console.error('Approve error:', e);
            await ctx.answerCbQuery('❌ Ошибка: ' + e.message, { show_alert: true });
        }
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }
        
        const payId = ctx.match[1];
        
        try {            await pool.query(`UPDATE payments SET status='rejected' WHERE id=$1`, [payId]);
            
            await ctx.editMessageText(`❌ <b>Заявка #${payId} отклонена</b>`);
            
            await ctx.answerCbQuery('❌ Отклонено');
            console.log(`❌ Заявка #${payId} отклонена`);
            
        } catch (e) {
            console.error('Reject error:', e);
            await ctx.answerCbQuery('❌ Ошибка', { show_alert: true });
        }
    });

};
