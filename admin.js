const { Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const fs = require('fs');

module.exports = (bot, pool, ADMIN_ID) => {

    // Если админ не настроен, этот файл ничего не делает
    if (!ADMIN_ID) return;

    // 1. Админ-панель при /start (Проверяем ID пользователя)
    bot.start(async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return; // Если не админ — пропускаем этот код

        const { rows: stats } = await pool.query(`
            SELECT (SELECT COUNT(*) FROM users) as users,
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

    // 2. Кнопки админа
    bot.hears('📋 Ожидающие', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const { rows } = await pool.query(`
            SELECT p.id, u.first_name, p.amount FROM payments p 
            JOIN users u ON p.user_id = u.tg_id 
            WHERE p.status = 'pending' LIMIT 5
        `);
        if (!rows.length) return ctx.reply('✅ Нет ожидающих');
        const list = rows.map(r => `#${r.id} — ${r.first_name} (${r.amount}₽)`).join('\n');
        ctx.reply(`📋 Ожидает:\n${list}`, { parse_mode: 'HTML' });
    });

    bot.hears('📥 Экспорт', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;        await ctx.reply('🔄 Генерирую Excel...');
        try {
            const { rows } = await pool.query(`SELECT u.first_name, u.username, s.expires_at FROM subscriptions s JOIN users u ON s.user_id = u.tg_id WHERE s.is_active = TRUE`);
            if (!rows.length) return ctx.reply('📭 Нет активных подписок');
            
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Subs');
            ws.columns = [{header:'Имя',key:'n',width:20},{header:'User',key:'u',width:20},{header:'Дата',key:'d',width:20}];
            rows.forEach(r => ws.addRow({n:r.first_name, u:'@'+(r.username||'-'), d:new Date(r.expires_at).toLocaleDateString('ru-RU')}));
            
            const file = `subs-${Date.now()}.xlsx`;
            await wb.xlsx.writeFile(file);
            await ctx.replyWithDocument({source: fs.createReadStream(file), filename:'subs.xlsx'});
            fs.unlinkSync(file);
        } catch (e) { ctx.reply('❌ Ошибка'); }
    });

    bot.hears('📊 Статистика', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        const { rows: s } = await pool.query(`SELECT (SELECT COUNT(*) FROM users) as u, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as a`);
        ctx.reply(`👥 Юзеров: ${s[0].u}\n✅ Подписок: ${s[0].a}`, { parse_mode: 'HTML' });
    });

    bot.hears('ℹ️ Помощь', (ctx) => { if (ctx.from.id === ADMIN_ID) ctx.reply('ℹ️ Ждите чеки и жмите кнопки.'); });

    // 3. Подтверждение оплат (Кнопки)
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒');
        const payId = ctx.match[1];
        try {
            // Обновляем статус
            await pool.query(`UPDATE payments SET status='approved', approved_at=NOW() WHERE id=$1`, [payId]);
            
            // Находим юзера и дату
            const { rows } = await pool.query(`SELECT user_id FROM payments WHERE id=$1`, [payId]);
            if (!rows.length) return;
            
            const expires = new Date();
            expires.setDate(expires.getDate() + (parseInt(process.env.SUBSCRIPTION_DAYS) || 30));
            
            // Создаем подписку
            await pool.query(`INSERT INTO subscriptions (user_id, expires_at, payment_receipt_id) VALUES ($1, $2, $3)`, [rows[0].user_id, expires, payId]);
            
            // Пишем юзеру
            await ctx.telegram.sendMessage(rows[0].user_id, `🎉 Подписка активирована!\n📅 До: ${expires.toLocaleDateString('ru-RU')}`, { parse_mode: 'HTML' });
            
            ctx.answerCbQuery('✅ Выдана!');
            ctx.editMessageText(`✅ Заявка #${payId} подтверждена`);
        } catch (e) {
            console.error(e);            ctx.answerCbQuery('❌ Ошибка');
        }
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒');
        await pool.query(`UPDATE payments SET status='rejected' WHERE id=$1`, [ctx.match[1]]);
        ctx.answerCbQuery('❌');
        ctx.editMessageText(`❌ Заявка #${ctx.match[1]} отклонена`);
    });

    console.log('✅ Admin module loaded');
};
