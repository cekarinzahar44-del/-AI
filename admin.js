const { Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const fs = require('fs').promises;
const path = require('path');

module.exports = (bot, pool, ADMIN_ID) => {
    if (!ADMIN_ID) {
        console.warn('⚠️ ADMIN_ID не задан — админ-панель отключена');
        return;
    }
    console.log(`✅ Admin module loaded (ID: ${ADMIN_ID})`);

    // ===== /start для админа =====
    bot.start(async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        try {
            const { rows: stats } = await pool.query(`
                SELECT 
                    (SELECT COUNT(*) FROM users) as total_users,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active_subs,
                    (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_payments,
                    (SELECT SUM(amount) FROM payments WHERE status = 'approved') as total_revenue
            `);
            
            const s = stats[0];
            const msg = `👨‍💼 <b>Панель администратора</b>\n\n` +
                `📊 <b>Статистика:</b>\n` +
                `• 👥 Пользователей: ${s.total_users}\n` +
                `• 🔥 Активных подписок: ${s.active_subs}\n` +
                `• ⏳ Ожидающих оплат: ${s.pending_payments}\n` +
                `• 💰 Выручка: ${s.total_revenue || 0}₽\n\n` +
                `🔧 <b>Управление:</b>`;
            
            await ctx.reply(msg, { 
                parse_mode: 'HTML',
                reply_markup: Markup.keyboard([
                    ['📋 Ожидающие оплаты', '📥 Экспорт подписок'],
                    ['📊 Статистика', '🗑 Очистка'],
                    ['ℹ️ Помощь']
                ]).resize()
            });
        } catch (e) {
            console.error('Admin start error:', e);
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    // ===== 📋 Ожидающие оплаты =====
    bot.hears('📋 Ожидающие оплаты', async (ctx) => {        if (ctx.from.id !== ADMIN_ID) return;
        
        try {
            const { rows } = await pool.query(`
                SELECT p.id, u.first_name, u.username, u.tg_id, p.amount, p.plan_type, p.created_at
                FROM payments p 
                JOIN users u ON p.user_id = u.tg_id 
                WHERE p.status = 'pending' 
                ORDER BY p.created_at DESC 
                LIMIT 20
            `);
            
            if (rows.length === 0) {
                return ctx.reply('✅ Нет ожидающих оплат 🎉');
            }
            
            let msg = `📋 <b>Ожидающие оплаты (${rows.length}):</b>\n\n`;
            rows.forEach((r, i) => {
                msg += `<b>#${i+1} Заявка ${r.id}</b>\n`;
                msg += `👤 ${r.first_name} ${r.username ? '@'+r.username : ''} (ID: ${r.tg_id})\n`;
                msg += `💎 ${r.plan_type} | 💰 ${r.amount}₽\n`;
                msg += `🕐 ${new Date(r.created_at).toLocaleString('ru-RU')}\n\n`;
            });
            msg += `<i>Чеки уже отправлены вам в личные сообщения от бота.</i>`;
            
            ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    // ===== 📥 Экспорт подписок в Excel =====
    bot.hears('📥 Экспорт подписок', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        await ctx.reply('🔄 Генерирую Excel-файл...');
        
        try {
            const { rows } = await pool.query(`
                SELECT 
                    u.tg_id, u.first_name, u.username, u.created_at as user_joined,
                    s.id as sub_id, s.starts_at, s.expires_at, s.plan_type,
                    p.amount, p.created_at as payment_date
                FROM subscriptions s 
                JOIN users u ON s.user_id = u.tg_id
                LEFT JOIN payments p ON s.payment_receipt_id = p.id::text
                WHERE s.is_active = TRUE
                ORDER BY s.expires_at ASC
            `);
                        if (rows.length === 0) {
                return ctx.reply('📭 Нет активных подписок для экспорта');
            }
            
            const workbook = new ExcelJS.Workbook();
            const ws = workbook.addWorksheet('Активные подписки');
            
            ws.columns = [
                { header: 'TG ID', key: 'tg_id', width: 15 },
                { header: 'Имя', key: 'name', width: 20 },
                { header: 'Username', key: 'username', width: 20 },
                { header: 'Дата регистрации', key: 'joined', width: 20 },
                { header: 'Тариф', key: 'plan', width: 10 },
                { header: 'Начало', key: 'starts', width: 20 },
                { header: 'Окончание', key: 'expires', width: 20 },
                { header: 'Сумма', key: 'amount', width: 10 },
                { header: 'Дата оплаты', key: 'paid_at', width: 20 }
            ];
            
            rows.forEach(r => ws.addRow({
                tg_id: r.tg_id,
                name: r.first_name || '-',
                username: r.username ? '@' + r.username : '-',
                joined: new Date(r.user_joined).toLocaleString('ru-RU'),
                plan: r.plan_type,
                starts: new Date(r.starts_at).toLocaleString('ru-RU'),
                expires: new Date(r.expires_at).toLocaleString('ru-RU'),
                amount: `${r.amount}₽`,
                paid_at: r.payment_date ? new Date(r.payment_date).toLocaleString('ru-RU') : '-'
            }));
            
            // Стилизация заголовка
            const headerRow = ws.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
            headerRow.alignment = { horizontal: 'center' };
            
            // Автофильтр
            ws.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: 9 }
            };
            
            const fileName = `subscriptions_${Date.now()}.xlsx`;
            const filePath = path.join(__dirname, fileName);
            
            await workbook.xlsx.writeFile(filePath);
            
            await ctx.replyWithDocument({
                source: fs.createReadStream(filePath),                filename: `подписки_${new Date().toISOString().split('T')[0]}.xlsx`
            });
            
            // Удаляем временный файл
            await fs.unlink(filePath);
            
        } catch (e) {
            console.error('Export error:', e);
            ctx.reply('❌ Ошибка экспорта: ' + e.message);
        }
    });

    // ===== 📊 Полная статистика =====
    bot.hears('📊 Статистика', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        try {
            const { rows: stats } = await pool.query(`
                SELECT 
                    (SELECT COUNT(*) FROM users) as total_users,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active_subs,
                    (SELECT COUNT(*) FROM subscriptions WHERE is_active = FALSE) as expired_subs,
                    (SELECT COUNT(*) FROM payments WHERE status = 'approved') as approved_payments,
                    (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending_payments,
                    (SELECT COUNT(*) FROM payments WHERE status = 'rejected') as rejected_payments,
                    (SELECT SUM(amount) FROM payments WHERE status = 'approved') as total_revenue,
                    (SELECT COUNT(DISTINCT user_id) FROM subscriptions) as unique_subscribers
            `);
            
            const s = stats[0];
            const conversion = s.total_users > 0 
                ? Math.round((s.unique_subscribers / s.total_users) * 100) 
                : 0;
            
            const msg = `📊 <b>Полная статистика проекта</b>\n\n` +
                `👥 <b>Пользователи:</b>\n` +
                `• Всего: ${s.total_users}\n` +
                `• С подпиской: ${s.active_subs}\n` +
                `• Истекло: ${s.expired_subs}\n` +
                `• Уникальных подписчиков: ${s.unique_subscribers}\n\n` +
                `💰 <b>Финансы:</b>\n` +
                `• Подтверждено: ${s.approved_payments} оплат\n` +
                `• Ожидает: ${s.pending_payments}\n` +
                `• Отклонено: ${s.rejected_payments}\n` +
                `• 💵 Выручка: ${s.total_revenue || 0}₽\n\n` +
                `📈 Конверсия в подписку: <b>${conversion}%</b>`;
            
            ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);        }
    });

    // ===== 🗑 Очистка (опционально) =====
    bot.hears('🗑 Очистка', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        
        await ctx.reply(
            `⚠️ <b>Очистка данных</b>\n\n` +
            `Выберите действие:`,
            {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🗑 Удалить истёкшие подписки', 'admin_clean_expired')],
                    [Markup.button.callback('🗑 Удалить старые pending-платежи', 'admin_clean_old_pending')],
                    [Markup.button.callback('🔙 Отмена', 'admin_cancel')]
                ])
            }
        );
    });

    bot.action('admin_clean_expired', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await ctx.answerCbQuery();
        
        const { rowCount } = await pool.query(
            `DELETE FROM subscriptions WHERE is_active = FALSE AND expires_at < NOW() - INTERVAL '30 days'`
        );
        await ctx.reply(`✅ Удалено ${rowCount} старых неактивных подписок`);
    });

    bot.action('admin_clean_old_pending', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await ctx.answerCbQuery();
        
        const { rowCount } = await pool.query(
            `DELETE FROM payments WHERE status = 'pending' AND created_at < NOW() - INTERVAL '7 days'`
        );
        await ctx.reply(`✅ Удалено ${rowCount} старых ожидающих платежей`);
    });

    bot.action('admin_cancel', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        await ctx.answerCbQuery('Отменено');
        await ctx.editMessageText('❌ Очистка отменена');
    });

    // ===== ℹ️ Помощь =====
    bot.hears('ℹ️ Помощь', (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;        ctx.reply(
            `📚 <b>Справка для администратора</b>\n\n` +
            `✅ <b>Как работает оплата:</b>\n` +
            `1. Пользователь выбирает тариф и получает инструкцию по СБП\n` +
            `2. После оплаты он отправляет чек боту (фото/PDF)\n` +
            `3. Вам приходит уведомление с чеком и кнопками:\n` +
            `   • ✅ Одобрить — активирует подписку на 30 дней\n` +
            `   • ❌ Отклонить — запросит причину отказа\n\n` +
            `🔧 <b>Кнопки меню:</b>\n` +
            `• 📋 Ожидающие оплаты — список всех pending-заявок\n` +
            `• 📥 Экспорт — выгрузка активных подписок в Excel\n` +
            `• 📊 Статистика — полная аналитика проекта\n` +
            `• 🗑 Очистка — удаление устаревших записей`,
            { parse_mode: 'HTML' }
        );
    });

    // ===== 🔘 Обработка approve/reject (заглушки) =====
    // Основная логика — в bot.js, здесь только защита
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }
        await ctx.answerCbQuery('ℹ️ Обработка в основном модуле bot.js');
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }
        await ctx.answerCbQuery('ℹ️ Обработка в основном модуле bot.js');
    });
};
