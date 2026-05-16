const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;

const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

module.exports = (bot, pool) => {

    // 1. /start для Пользователя
    bot.start(async (ctx) => {
        // Если это админ, мы ничего не делаем здесь (admin.js уже сработал)
        if (ctx.from.id === ADMIN_ID) return; 

        const tgId = ctx.from.id;
        // Создаем юзера
        await pool.query(
            'INSERT INTO users (tg_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT (tg_id) DO NOTHING',
            [tgId, ctx.from.username, ctx.from.first_name]
        );

        const { rows: subs } = await pool.query(
            'SELECT expires_at FROM subscriptions WHERE user_id = $1 AND is_active = TRUE ORDER BY expires_at DESC LIMIT 1',
            [tgId]
        );

        const { rows: user } = await pool.query('SELECT free_recipes_used FROM users WHERE tg_id = $1', [tgId]);
        const used = user[0]?.free_recipes_used || 0;

        let msg = '👋 Привет! Я <b>Домашний Шеф</b> 🍳\nНапиши продукты, и я придумаю рецепт!\n';
        msg += `🎁 У тебя <b>${FREE_LIMIT} бесплатных рецепта</b>.\n\n`;

        if (subs.length > 0) {
            const daysLeft = Math.ceil((new Date(subs[0].expires_at) - new Date()) / 86400000);
            msg += `✅ Подписка активна до ${new Date(subs[0].expires_at).toLocaleDateString('ru-RU')} (Осталось: ${daysLeft} дн.)`;
        } else {
            msg += `📊 Использовано: ${used} из ${FREE_LIMIT}`;
        }
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    // 2. Запрос рецепта (ОБЯЗАТЕЛЬНО async)
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const tgId = ctx.from.id;

        if (text.startsWith('/')) return;        
        // Админы не генерируют рецепты текстом
        if (tgId === ADMIN_ID) return ctx.reply('🔒 Используйте кнопки меню.');

        // Создаем юзера (на всякий случай)
        await pool.query(
            'INSERT INTO users (tg_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT (tg_id) DO NOTHING',
            [tgId, ctx.from.username, ctx.from.first_name]
        );

        // Проверяем подписку
        const { rows: subs } = await pool.query(
            'SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW()', [tgId]
        );
        const hasSub = subs.length > 0;

        // Проверяем лимит
        const { rows: user } = await pool.query('SELECT free_recipes_used FROM users WHERE tg_id = $1', [tgId]);
        const used = user[0]?.free_recipes_used || 0;

        if (!hasSub && used >= FREE_LIMIT) {
            return ctx.reply(`🔒 Лимит исчерпан! Оформите подписку за ${SUB_PRICE}₽`, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([Markup.button.callback('💳 Оплатить', 'pay_subscribe')])
            });
        }

        await ctx.replyWithChatAction('typing');
        try {
            const res = await giga.chat({
                model: 'GigaChat',
                messages: [{ role: 'system', content: 'Ты шеф-повар. Дай краткий рецепт.' }, { role: 'user', content: `Продукты: ${text}` }],
                max_tokens: 800
            });
            await ctx.reply(res.choices[0].message.content);

            // Считаем бесплатные
            if (!hasSub) {
                await pool.query('UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id = $1', [tgId]);
                const left = FREE_LIMIT - (used + 1);
                if (left > 0) await ctx.reply(`🎁 Осталось бесплатных: ${left}`);
            }
        } catch (e) { ctx.reply('❌ Ошибка AI: ' + e.message); }
    });

    // 3. Кнопка оплаты
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        const phone = process.env.SBP_PHONE || '+79022231321';
        ctx.reply(`💳 Оплата — ${SUB_PRICE}₽\n📱 СБП: <code>${phone}</code>\n\n📎 Пришлите чек сюда!`, { parse_mode: 'HTML' });    });

    // 4. Приём чеков
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id;
        let fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : ctx.message.document?.file_id;
        if (!fileId) return;

        // Сохраняем чек в БД
        const { rows } = await pool.query(`INSERT INTO payments (user_id, amount, receipt_file_id) VALUES ($1, $2, $3) RETURNING id`, [tgId, SUB_PRICE, fileId]);
        const payId = rows[0].id;
        
        // Получаем имя юзера
        const { rows: u } = await pool.query('SELECT first_name, username FROM users WHERE tg_id = $1', [tgId]);
        const name = u[0]?.first_name || 'User';
        const username = u[0]?.username || 'нет';

        await ctx.reply(`✅ Чек принят! Заявка #${payId}. Ожидайте.`);

        // Уведомляем админа (напрямую, без require)
        if (ADMIN_ID) {
            try {
                const link = await ctx.telegram.getFileLink(fileId);
                await ctx.telegram.sendMessage(ADMIN_ID, `🔔 Новый чек #${payId}\n👤 ${name} (@${username})\n💰 ${SUB_PRICE}₽\n[📎 Чек](${link})`, {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Подтвердить', `approve_${payId}`)],
                        [Markup.button.callback('❌ Отклонить', `reject_${payId}`)]
                    ])
                });
            } catch(e) { console.error('Notify error:', e); }
        }
    });

    console.log('✅ User module loaded');
};
