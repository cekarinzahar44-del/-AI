const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;

const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

module.exports = (bot, pool) => {

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

    async function hasActiveSubscription(tgId) {
        const { rows } = await pool.query(
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

    // ===== /start =====    bot.start(async (ctx) => {
        const tgId = ctx.from.id;
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const sub = await getSubscription(tgId);
        let msg = '👋 Привет! Я <b>Домашний Шеф</b> 🍳\n\n';
        msg += 'Напиши продукты, и я придумаю рецепт!\n';
        msg += `🎁 У тебя <b>${FREE_LIMIT} бесплатных рецепта</b>.\n\n`;
        
        if (sub) {
            const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
            msg += `✅ Подписка активна до ${new Date(sub.expires_at).toLocaleDateString('ru-RU')}\n`;
            msg += `⏳ Осталось: <b>${daysLeft} дн.</b>`;
        } else {
            const used = await getFreeRecipesUsed(tgId);
            msg += `📊 Использовано: ${used} из ${FREE_LIMIT}`;
        }
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    // ===== ЗАПРОС РЕЦЕПТА =====
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const tgId = ctx.from.id;
        
        if (text.startsWith('/')) return;
        
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const hasSub = await hasActiveSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);
        
        if (!hasSub && freeUsed >= FREE_LIMIT) {
            return ctx.reply(
                `🔒 <b>Лимит исчерпан!</b>\n\nОформите подписку за ${SUB_PRICE}₽`,
                { 
                    parse_mode: 'HTML', 
                    reply_markup: Markup.inlineKeyboard([
                        Markup.button.callback('💳 Оформить подписку', 'pay_subscribe')
                    ])
                }
            );
        }
        
        await ctx.replyWithChatAction('typing');
        try {
            const response = await giga.chat({
                model: 'GigaChat',
                messages: [                    { role: 'system', content: 'Ты шеф-повар. Дай краткий рецепт.' },
                    { role: 'user', content: `Продукты: ${text}` }
                ],
                max_tokens: 800
            });
            
            await ctx.reply(response.choices[0].message.content);
            
            if (!hasSub) {
                await incrementFreeRecipes(tgId);
                const left = FREE_LIMIT - (freeUsed + 1);
                if (left > 0) await ctx.reply(`🎁 Осталось: ${left}`);
            }
        } catch (e) {
            ctx.reply('❌ Ошибка: ' + e.message);
        }
    });

    // ===== КНОПКА ОПЛАТЫ =====
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
        const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
        
        ctx.reply(
            `💳 <b>Оплата — ${SUB_PRICE}₽</b>\n\n` +
            `📱 СБП: <code>${SBP_PHONE}</code>\n` +
            `👤 ${SBP_RECIPIENT}\n\n` +
            `📎 <b>Пришлите чек сюда!</b>`,
            { parse_mode: 'HTML' }
        );
    });

    // ===== ПРИЁМ ЧЕКОВ =====
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id;
        const user = await getUser(tgId);
        if (!user) return;
        
        let fileId;
        if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        else if (ctx.message.document) fileId = ctx.message.document.file_id;
        
        if (!fileId) return;
        
        const { rows } = await pool.query(
            `INSERT INTO payments (user_id, amount, receipt_file_id) VALUES ($1, $2, $3) RETURNING id`,
            [tgId, SUB_PRICE, fileId]
        );
                const payId = rows[0].id;
        await ctx.reply(`✅ Чек принят! Заявка #${payId}. Ожидайте.`);
        
        // Уведомление админу (обрабатывается в admin.js)
        ctx.emit('new_payment', { payId, userId: tgId, user, fileId });
    });

    console.log('✅ Bot module loaded');
};
