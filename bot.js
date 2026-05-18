const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const PRO_PRICE = 500;
const VIP_PRICE = 800;
const FREE_LIMIT = 3;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';

// =========================
// 🔌 GIGACHAT WRAPPER (как в старом коде, но на fetch)
// =========================
let cachedToken = null;
let tokenExpiry = 0;

async function getGigaToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    
    const res = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${GIGA_CREDENTIALS}`,
            'RqUID': crypto.randomUUID()
        },
        body: 'scope=GIGACHAT_API_PERS'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`GigaChat Auth: ${data.message || res.statusText}`);
    
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_at - 30) * 1000;
    return cachedToken;
}

// 🔹 Объект в стиле старого кода: giga.chat({...})
const giga = {
    async chat({ model, messages, max_tokens, temperature }) {
        const token = await getGigaToken();
        const res = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ model, messages, max_tokens, temperature })
        });        const data = await res.json();
        if (!res.ok) throw new Error(`GigaChat API: ${data.message || res.statusText}`);
        return data;
    }
};

// =========================
// ВАШ КОД НИЖЕ — БЕЗ ИЗМЕНЕНИЙ
// =========================

module.exports = (bot, pool, ADMIN_ID) => {
    console.log('✅ VIP Chef Bot loaded');
    const userStates = {};

    // ===== DB HELPERS =====
    async function createUser(tgId, username, firstName) {
        await pool.query(
            `INSERT INTO users (tg_id, username, first_name, free_recipes_used)
             VALUES ($1, $2, $3, 0) ON CONFLICT (tg_id) DO NOTHING`,
            [tgId, username, firstName]
        );
    }
    async function getUser(tgId) {
        const { rows } = await pool.query(`SELECT * FROM users WHERE tg_id = $1`, [tgId]);
        return rows[0];
    }
    async function getFreeRecipesUsed(tgId) {
        const user = await getUser(tgId);
        return user?.free_recipes_used || 0;
    }
    async function incrementFreeRecipes(tgId) {
        await pool.query(`UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id = $1`, [tgId]);
    }
    async function resetFreeRecipes(tgId) {
        await pool.query(`UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`, [tgId]);
    }
    async function hasSubscription(tgId) {
        const { rows } = await pool.query(
            `SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW() LIMIT 1`,
            [tgId]
        );
        return rows[0];
    }

    // ===== UI =====
    async function sendSubscriptionMenu(ctx) {
        return ctx.reply(
            `🎯 <b>Вы использовали все 3 пробных рецепта!</b>\n\n💳 <b>PRO — ${PRO_PRICE}₽ / месяц</b>\n• Безлимитные запросы\n💎 <b>VIP — ${VIP_PRICE}₽ / месяц</b>\n• Всё из PRO + меню + диетолог + КБЖУ`,
            {
                parse_mode: 'HTML',                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback(`💰 Оплатить PRO версию`, 'pay_pro')],
                    [Markup.button.callback(`💎 Оплатить VIP версию`, 'pay_vip')]
                ])
            }
        );
    }

    // ===== START =====
    bot.start(async (ctx) => {
        if (ctx.from.id === ADMIN_ID) return;
        const tgId = ctx.from.id;
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        const subscription = await hasSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);

        if (subscription) {
            return ctx.reply(
                `👨‍🍳 <b>Добро пожаловать!</b>\n🔥 Тариф: <b>${subscription.plan_type}</b>\n\n🎯 Напишите ингредиенты или название блюда.`,
                { parse_mode: 'HTML' }
            );
        }
        if (freeUsed >= FREE_LIMIT) return sendSubscriptionMenu(ctx);
        const left = FREE_LIMIT - freeUsed;
        ctx.reply(
            `👨‍🍳 <b>Привет! Я Шеф-Повар AI</b>\n\n🍽 Напишите ингредиенты или блюдо.${left < 3 ? `\n🎁 Осталось: <b>${left}</b>` : ''}`,
            { parse_mode: 'HTML' }
        );
    });

    // ===== PAYMENT =====
    bot.action('pay_pro', async (ctx) => {
        await ctx.answerCbQuery();
        userStates[ctx.from.id] = { payingFor: 'PRO', amount: PRO_PRICE };
        await ctx.editMessageText(
            `💳 Оплата — ${PRO_PRICE}₽\n\n1️⃣ СБП: <code>${SBP_PHONE}</code>\n👤 ${SBP_RECIPIENT}\n2️⃣ Пришлите чек сюда.\n⏱ Активация ~5 мин.`,
            { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'show_subscriptions')]]) }
        );
    });
    bot.action('pay_vip', async (ctx) => {
        await ctx.answerCbQuery();
        userStates[ctx.from.id] = { payingFor: 'VIP', amount: VIP_PRICE };
        await ctx.editMessageText(
            `💳 Оплата — ${VIP_PRICE}₽\n\n1️⃣ СБП: <code>${SBP_PHONE}</code>\n👤 ${SBP_RECIPIENT}\n2️⃣ Пришлите чек сюда.\n⏱ Активация ~5 мин.`,
            { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'show_subscriptions')]]) }
        );
    });
    bot.action('show_subscriptions', async (ctx) => {
        await ctx.answerCbQuery();
        delete userStates[ctx.from.id];        await sendSubscriptionMenu(ctx);
    });

    // ===== RECEIPTS =====
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id;
        const state = userStates[tgId];
        if (!state?.payingFor) return ctx.reply('📎 Чеки принимаю только при оплате.');
        
        let fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : ctx.message.document?.file_id;
        if (!fileId) return;

        const { rows } = await pool.query(
            `INSERT INTO payments (user_id, amount, receipt_file_id, status, plan_type) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
            [tgId, state.amount, fileId, state.payingFor]
        );
        const paymentId = rows[0].id;
        delete userStates[tgId];

        await ctx.reply(`✅ <b>Чек получен!</b>\n📋 Заявка #${paymentId} на проверке.`, { parse_mode: 'HTML' });

        const user = await getUser(tgId);
        const caption = `🔔 Оплата\n👤 ${user?.first_name || 'User'} (@${user?.username || 'no'})\n💎 ${state.payingFor} | 💰 ${state.amount}₽\n📋 #${paymentId}`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✅ Одобрить', `approve_${paymentId}`), Markup.button.callback('❌ Отклонить', `reject_${paymentId}`)]]);

        if (ctx.message.photo) await ctx.telegram.sendPhoto(ADMIN_ID, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
        else await ctx.telegram.sendDocument(ADMIN_ID, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
    });

    // ===== ADMIN: APPROVE/REJECT =====
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒 Запрещено', { show_alert: true });
        const pid = ctx.match[1];
        try {
            const { rows: [pay] } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [pid]);
            if (!pay) return ctx.answerCbQuery('❌ Не найдено', { show_alert: true });
            
            const expires = new Date(); expires.setDate(expires.getDate() + 30);
            await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1`, [pay.user_id]);
            await pool.query(`INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) VALUES ($1, TRUE, $2, $3)`, [pay.user_id, expires, pay.plan_type]);
            await resetFreeRecipes(pay.user_id);
            await pool.query(`UPDATE payments SET status = 'approved' WHERE id = $1`, [pid]);

            await ctx.answerCbQuery('✅ Активировано');
            await ctx.editMessageCaption(`✅ Одобрено #${pid}\n🔥 ${pay.plan_type}`, { parse_mode: 'HTML' });
            await ctx.telegram.sendMessage(pay.user_id, `🎉 <b>Подписка активирована!</b>\n🔥 ${pay.plan_type} до ${expires.toLocaleDateString('ru-RU')}`, { parse_mode: 'HTML' });
        } catch (e) { await ctx.answerCbQuery('❌ Ошибка', { show_alert: true }); }
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
        userStates[`admin_reject_${ADMIN_ID}`] = ctx.match[1];
        await ctx.answerCbQuery('✍️ Напишите причину');
        await ctx.reply('Причина отклонения #' + ctx.match[1]);
    });

    bot.on('text', async (ctx) => {
        const adminKey = `admin_reject_${ADMIN_ID}`;
        if (ctx.from.id === ADMIN_ID && userStates[adminKey]) {
            const pid = userStates[adminKey];
            const reason = ctx.message.text.trim();
            delete userStates[adminKey];
            await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [pid]);
            await ctx.reply(`❌ Заявка #${pid} отклонена`);
            const msg = reason.toLowerCase() === 'нет причины' ? `❌ Платёж отклонён.` : `❌ Отклонено.\n📌 Причина: <i>${reason}</i>`;
            try {
                const { rows: [pay] } = await pool.query(`SELECT user_id FROM payments WHERE id = $1`, [pid]);
                await ctx.telegram.sendMessage(pay.user_id, msg, { parse_mode: 'HTML' });
            } catch(e) {}
            return;
        }
        await handleUserRecipeRequest(ctx);
    });

    // ===== RECIPE HANDLER =====
    async function handleUserRecipeRequest(ctx) {
        const text = ctx.message?.text?.trim();
        if (!text || text.startsWith('/')) return;
        const tgId = ctx.from.id;
        if (tgId === ADMIN_ID) return;

        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        const subscription = await hasSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);
        if (!subscription && freeUsed >= FREE_LIMIT) return sendSubscriptionMenu(ctx);

        // 🔹 ОПРЕДЕЛЕНИЕ ТИПА ЗАПРОСА
        const lower = text.toLowerCase();
        const dishKeywords = ['рецепт', 'приготовь', 'хочу', 'сделай', 'как сделать', 'карбонара', 'борщ', 'паста', 'салат', 'суп', 'котлеты', 'пирог', 'торт', 'десерт', 'запеканка', 'омлет', 'блины', 'рагу', 'гуляш', 'плов', 'уха', 'солянка', 'харчо', 'печенье', 'кекс', 'суфле', 'мусс', 'желе', 'крем'];
        const isDish = dishKeywords.some(kw => lower.includes(kw));
        const hasCommas = text.includes(',');
        const ingredientPatterns = /\b(куриц|говядин|свинин|рыб|лук|морков|картофел|помидор|огурц|чеснок|сметан|молок|сыр|яиц|масл|мука|сахар|соль|перец|специ|зелень|капуст|свёкл|фасол|рис|гречк|макарон|лаваш|творог|сливк|йогурт|мед|лимон|апельсин|яблок|груш|банан|клубник|малин|смородин|орех|изюм|шоколад|какао|ванил|кориц|имбирь|базилик|петруш|укроп|кинз|мят|розмарин|тимьян|паприк|куркум|карри|соев|уксус|вин|коньяк|водк|пиво)\b/ig;
        const requestType = (!isDish && (hasCommas || ingredientPatterns.test(lower))) ? 'ingredients' : 'dish';

        if (!userStates[tgId]) {
            userStates[tgId] = { requestType, ingredients: text, step: 'details' };
            const q = requestType === 'ingredients' 
                ? `👨‍🍳 Уточните:\n👥 На сколько порций?\n🥗 Предпочтения (ПП, без глютена)?`
                : `👨‍🍳 Уточните:\n👥 На сколько порций?\n🥗 Диетические предпочтения?`;
            return ctx.reply(q);        }

        if (userStates[tgId]?.step === 'details') {
            const state = userStates[tgId];
            const details = text;
            delete userStates[tgId];
            const loading = await ctx.reply('👨‍🍳 Готовлю рецепт...');

            try {
                const planType = subscription?.plan_type || 'FREE';
                const isVIP = planType === 'VIP';
                const isPP = isVIP && details?.toLowerCase().includes('пп');
                
                const baseSystem = `Ты — элитный ИИ ШЕФ-ПОВАР${isVIP ? ' и ИИ-ДИЕТОЛОГ' : ''}.
Твоя задача — создавать идеальные рецепты.

🎯 ОТВЕЧАЙ СТРОГО ПО СТРУКТУРЕ:
1️⃣ <b>Название блюда</b> (с эмодзи)
2️⃣ <b>🍽 Вкусное описание</b> (2-3 сочных предложения)
3️⃣ <b>🛒 Ингредиенты</b> (спроси "На сколько порций?", если не указано, пересчитай граммовки)
4️⃣ <b>🔥 Метод приготовления</b> (варка/жарка/тушение/запекание)
5️⃣ <b>👨‍🍳 Пошаговое приготовление</b> (граммы, мл, время, температура, посуда)
6️⃣ <b>💡 Советы от Шеф-повара ИИ</b> (лайфхаки, замены, ошибки)
7️⃣ <b>🍷 Идеальные напитки</b> (🍷 Алкогольные + 🧃 Безалкогольные)
${isVIP ? `\n✨ VIP-ДОПОЛНЕНИЯ:\n• 🥗 КБЖУ на порцию\n• ${isPP ? '• Только ПП-ингредиенты' : ''}` : ''}
Используй эмодзи. Форматируй жирное через <b>текст</b>. Отвечай строго по структуре.`;

                const userPrompt = state.requestType === 'ingredients'
                    ? `🎯 ЗАДАЧА: Приготовь блюдо ТОЛЬКО из: "${state.ingredients}"\n⚠️ Можно: соль, перец, специи, масло. НЕЛЬЗЯ: другие продукты.\n${details ? `Доп: ${details}` : ''}`
                    : `🎯 ЗАДАЧА: Рецепт блюда. Запрос: "${state.ingredients}"\nДай классический или авторский рецепт.\n${details ? `Условия: ${details}` : ''}`;

                // 🔹 ВАШ СТАРЫЙ ВЫЗОВ — РАБОТАЕТ!
                const response = await giga.chat({
                    model: 'GigaChat',
                    messages: [
                        { role: 'system', content: baseSystem },
                        { role: 'user', content: userPrompt }
                    ],
                    max_tokens: 3000,
                    temperature: 0.85
                });

                try { await ctx.deleteMessage(loading.message_id); } catch(e) {}
                const recipe = response.choices?.[0]?.message?.content || '❌ Не удалось сгенерировать';
                await ctx.reply(recipe, { parse_mode: 'HTML' });

                if (!subscription) {
                    await incrementFreeRecipes(tgId);
                    const left = FREE_LIMIT - (freeUsed + 1);
                    if (left <= 0) await sendSubscriptionMenu(ctx);                }
            } catch (err) {
                try { await ctx.deleteMessage(loading.message_id); } catch(e) {}
                console.error('GigaChat error:', err);
                ctx.reply('❌ Ошибка генерации. Попробуйте позже.');
            }
        }
    }

    // ===== VIP COMMANDS =====
    bot.command('weekmenu', async (ctx) => {
        const sub = await hasSubscription(ctx.from.id);
        if (!sub || sub.plan_type !== 'VIP') return ctx.reply('🔒 Только в VIP');
        userStates[ctx.from.id] = { mode: 'weekmenu' };
        ctx.reply(`📅 <b>Меню на период</b>\nУкажите:\n👥 Человек\n💰 Бюджет\n🥗 Тип\n📆 Период`, { parse_mode: 'HTML' });
    });
    bot.command('diet', async (ctx) => {
        const sub = await hasSubscription(ctx.from.id);
        if (!sub || sub.plan_type !== 'VIP') return ctx.reply('🔒 Только в VIP');
        userStates[ctx.from.id] = { mode: 'diet' };
        ctx.reply(`🥗 <b>ИИ-Диетолог</b>\nУкажите:\n📏 Рост\n⚖️ Вес\n🎂 Возраст\n🎯 Цель`, { parse_mode: 'HTML' });
    });

    bot.on('text', async (ctx) => {
        const tgId = ctx.from.id;
        const state = userStates[tgId];
        if (state?.mode && ctx.from.id !== ADMIN_ID) {
            await ctx.reply('🔄 Функция в разработке!');
            delete userStates[tgId];
            return;
        }
        if (!ctx.message?.text?.startsWith('/')) {
            if (!state || state.step !== 'details') {
                await handleUserRecipeRequest(ctx);
            }
        }
    });
};
