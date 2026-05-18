const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto'); // 🔹 Добавлено для генерации RqUID

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

const PRO_PRICE = 500;
const VIP_PRICE = 800;
const FREE_LIMIT = 3;

const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';

// 🔹 УДАЛЕНО: const giga = new GigaChat(...)
// 🔹 ВСТАВЛЕНО: Нативные функции для GigaChat API через fetch

// =========================
// 🔌 GIGACHAT API (Native Fetch)
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

async function callGigaChat(systemPrompt, userPrompt, maxTokens = 3000, temperature = 0.85) {
    const token = await getGigaToken();
    const res = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'        },        body: JSON.stringify({
            model: 'GigaChat',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: maxTokens,
            temperature
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`GigaChat API: ${data.message || res.statusText}`);
    return data.choices[0].message.content;
}

// =========================
// ВАШ КОД НИЖЕ — БЕЗ ИЗМЕНЕНИЙ (кроме замены giga.chat → callGigaChat)
// =========================

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ VIP Chef Bot loaded');

    // =========================
    // USER STATES
    // =========================
    const userStates = {};

    // =========================
    // HELPER: Определение типа запроса
    // =========================
    function detectRequestType(text) {
        const lower = text.toLowerCase();
        
        const dishKeywords = [
            'рецепт', 'приготовь', 'хочу', 'сделай', 'как сделать',
            'карбонара', 'борщ', 'паста', 'салат', 'суп', 'котлеты',
            'пирог', 'торт', 'десерт', 'запеканка', 'омлет', 'блины',
            'рагу', 'гуляш', 'плов', 'уха', 'солянка', 'харчо',
            'печенье', 'кекс', 'суфле', 'мусс', 'желе', 'крем'
        ];
        
        if (dishKeywords.some(kw => lower.includes(kw))) {
            return 'dish';
        }
        
        const ingredientPatterns = [
            /\b(куриц|говядин|свинин|рыб|лук|морков|картофел|помидор|огурц|чеснок|сметан|молок|сыр|яиц|масл|мука|сахар|соль|перец|специ|зелень|капуст|свёкл|фасол|рис|гречк|макарон|лаваш|творог|сливк|йогурт|мед|лимон|апельсин|яблок|груш|банан|клубник|малин|смородин|орех|изюм|шоколад|какао|ванил|кориц|имбирь|базилик|петруш|укроп|кинз|мят|розмарин|тимьян|паприк|куркум|карри|соев|уксус|вин|коньяк|водк|пиво)\b/ig
        ];        
        const hasCommas = text.includes(',');        const hasIngredients = ingredientPatterns.some(p => p.test(lower));
        
        if ((hasCommas || hasIngredients) && !dishKeywords.some(kw => lower.includes(kw))) {
            return 'ingredients';
        }
        
        return 'dish';
    }

    // =========================
    // HELPER: Формирование промпта
    // =========================
    function buildPrompt(requestType, ingredients, details, planType) {
        const isVIP = planType === 'VIP';
        const isPP = isVIP && details?.toLowerCase().includes('пп');
        
        const baseSystem = `Ты — элитный ИИ ШЕФ-ПОВАР${isVIP ? ' и ИИ-ДИЕТОЛОГ' : ''}.
Твоя задача — создавать идеальные рецепты с атмосферными описаниями.

🎯 ТЫ ОБЯЗАН ОТВЕЧАТЬ СТРОГО ПО СТРУКТУРЕ:

1️⃣ <b>Название блюда</b> (жирным, с эмодзи)

2️⃣ <b>🍽 Вкусное описание</b>
   — 2-3 предложения, сочные, аппетитные, пробуждающие желание готовить

3️⃣ <b>🛒 Ингредиенты</b>
   — Сначала спроси: "На сколько порций готовить?" (если пользователь не указал)
   — Пересчитай граммовки под указанное количество порций
   — Формат: • Продукт — количество (г/мл/шт)

4️⃣ <b>🔥 Метод приготовления</b>
   — Варка / жарка / тушение / запекание / на пару / гриль

5️⃣ <b>👨‍🍳 Пошаговое приготовление</b>
   — Каждый шаг: что добавить (граммы/мл), сколько времени, температура, посуда
   — Формат: "Шаг 1: ... (5 мин, 180°C, сковорода)"

6️⃣ <b>💡 Советы от Шеф-повара ИИ</b>
   — Лайфхаки, замены ингредиентов, частые ошибки новичков

7️⃣ <b>🍷 Идеальные напитки</b>
   — 🍷 Алкогольные: 1-2 варианта
   — 🧃 Безалкогольные: 1-2 варианта

${isVIP ? `✨ VIP-ДОПОЛНЕНИЯ:
• 🥗 Калорийность блюда (КБЖУ на порцию)
• ${isPP ? '• Только ПП-ингредиенты, без сахара/муки/жиров' : ''}• 📊 Рекомендации диетолога (если запрошено)
` : ''}
Используй эмодзи для визуального разделения.
Не используй ** для жирного — только <b>тег</b>.
Не добавляй лишних вступлений — сразу по структуре.`;

        if (requestType === 'ingredients') {
            return {
                system: baseSystem,
                user: `🎯 ЗАДАЧА: Приготовь блюдо ТОЛЬКО из этих ингредиентов:
"${ingredients}"

⚠️ ПРАВИЛА:
• Можно добавлять: соль, перец, специи, растительное/сливочное масло для жарки/запекания
• НЕЛЬЗЯ добавлять другие основные продукты
• Если из набора нельзя приготовить полноценное блюдо — честно напиши об этом и предложи докупить 1-2 минимально необходимых продукта (назови конкретно)

${details ? `Дополнительно: ${details}` : ''}

Ответь строго по 7-пунктовой структуре.`
            };
        }
        
        return {
            system: baseSystem,
            user: `🎯 ЗАДАЧА: Пользователь запросил блюдо или общий рецепт.
Запрос: "${ingredients}"

Дай лучший, классический или авторский рецепт этого блюда с полным набором ингредиентов.

${details ? `Условия: ${details}` : ''}

Ответь строго по 7-пунктовой структуре.`
        };
    }

    // =========================
    // DB HELPERS
    // =========================
    async function createUser(tgId, username, firstName) {
        await pool.query(
            `INSERT INTO users (tg_id, username, first_name, free_recipes_used)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (tg_id) DO NOTHING`,
            [tgId, username, firstName]
        );
    }

    async function getUser(tgId) {        const { rows } = await pool.query(`SELECT * FROM users WHERE tg_id = $1`, [tgId]);
        return rows[0];
    }
    async function getFreeRecipesUsed(tgId) {
        const user = await getUser(tgId);
        return user?.free_recipes_used || 0;
    }

    async function incrementFreeRecipes(tgId) {
        await pool.query(
            `UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id = $1`,
            [tgId]
        );
    }

    async function resetFreeRecipes(tgId) {
        await pool.query(
            `UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`,
            [tgId]
        );
    }

    async function hasSubscription(tgId) {
        const { rows } = await pool.query(
            `SELECT * FROM subscriptions
             WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW()
             LIMIT 1`,
            [tgId]
        );
        return rows[0];
    }

   
 // =========================
// UI: Меню подписок
// =========================
async function sendSubscriptionMenu(ctx) {
    return ctx.reply(
        `🎯 <b>Вы использовали все 3 пробных рецепта!</b>

Чтобы продолжить пользоваться <b>Шеф-Поваром AI</b>, выберите подписку:

💳 <b>PRO — ${PRO_PRICE}₽ / месяц</b>
• Неограниченное количество запросов к боту
• Все базовые рецепты
💎 <b>VIP — ${VIP_PRICE}₽ / месяц</b>
• Всё из PRO +
• 📅 Меню от ИИ: день / неделя / 2 недели / месяц
• 🥗 ИИ-Диетолог: похудение / набор массы / поддержание веса
• 🥗 Только ПП-блюда (по запросу)• 🔢 Счётчик калорий и КБЖУ для каждого блюда`,
        {
            parse_mode: 'HTML',
            // 🔥 ИСПРАВЛЕНО: прямой формат кнопок            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 Оплатить PRO версию', callback_data: 'pay_pro' }],
                    [{ text: '💎 Оплатить VIP версию', callback_data: 'pay_vip' }]
                ]
            }
        }
    );
}
    
           

    // =========================
    // UI: Инструкция по оплате
    // =========================
    function getPaymentInstruction(planType, amount) {
        return `💳 Оплата подписки — ${amount}₽ / месяц

1️⃣ Переведите ${amount}₽ по СБП:
📱 Номер: <code>${SBP_PHONE}</code>
👤 Получатель: ${SBP_RECIPIENT}
🏦 Банки: 🟢 Сбер, 🔵 ВТБ, 🟡 Т-банк

2️⃣ После оплаты пришлите сюда чек (скриншот или PDF).

⏱ Подписка активируется в течение 5 минут после проверки.`;
    }

    // =========================
    // START
    // =========================
    bot.start(async (ctx) => {
        if (ctx.from.id === ADMIN_ID) return;

        const tgId = ctx.from.id;
        await createUser(tgId, ctx.from.username, ctx.from.first_name);

        const subscription = await hasSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);

        if (subscription) {
            return ctx.reply(
                `👨‍🍳 <b>Добро пожаловать обратно!</b>

🔥 Ваш тариф: <b>${subscription.plan_type}</b>
🎯 Напишите:
• Список ингредиентов — получу рецепт только из них
• Или название блюда — дам классический рецепт

${subscription.plan_type === 'VIP' ? '\n✨ VIP-доступ: /weekmenu — меню на период, /diet — ИИ-диетолог' : ''}`,                { parse_mode: 'HTML' }            );
        }

        if (freeUsed >= FREE_LIMIT) {
            return sendSubscriptionMenu(ctx);
        }

        const left = FREE_LIMIT - freeUsed;
        await ctx.reply(
            `👨‍🍳 <b>Привет! Я Шеф-Повар AI</b>

🍽 Я помогу:
• Приготовить блюдо из ваших ингредиентов
• Найти рецепт любого блюда
• Составить меню и рассчитать калории${left < 3 ? '\n\n🎁 <b>Пробный доступ:</b> осталось ' + left + ' бесплатных рецепта' : ''}`,
            { parse_mode: 'HTML' }
        );
    });

  
 // =========================
// PAYMENT FLOW
// =========================
bot.action('pay_pro', async (ctx) => {
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = { payingFor: 'PRO', amount: PRO_PRICE };
    
    await ctx.editMessageText(
        getPaymentInstruction('PRO', PRO_PRICE),
        {
            parse_mode: 'HTML',
            // 🔥 ИСПРАВЛЕНО: прямой формат кнопок
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад к тарифам', callback_data: 'show_subscriptions' }]
                ]
            }
        }
    );
});

bot.action('pay_vip', async (ctx) => {
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = { payingFor: 'VIP', amount: VIP_PRICE };
    
    await ctx.editMessageText(
        getPaymentInstruction('VIP', VIP_PRICE),
        {
            parse_mode: 'HTML',
            // 🔥 ИСПРАВЛЕНО: прямой формат кнопок            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад к тарифам', callback_data: 'show_subscriptions' }]
                ]
            }
        }
    );
});

bot.action('show_subscriptions', async (ctx) => {
    await ctx.answerCbQuery();
    delete userStates[ctx.from.id];
    await sendSubscriptionMenu(ctx);
});

    // =========================
    // RECEIPT HANDLING
    // =========================
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id;
        const state = userStates[tgId];
        
        if (!state?.payingFor) {
            return ctx.reply('📎 Я принимаю чеки только в процессе оплаты подписки.\nЕсли вы хотели отправить рецепт — просто напишите текст.');
        }

        let fileId;
        if (ctx.message.photo) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        } else if (ctx.message.document) {
            fileId = ctx.message.document.file_id;
        }
        if (!fileId) return;

        const planType = state.payingFor;
        const amount = state.amount;

        const { rows } = await pool.query(
            `INSERT INTO payments (user_id, amount, receipt_file_id, status, plan_type)
             VALUES ($1, $2, $3, 'pending', $4)
             RETURNING id`,
            [tgId, amount, fileId, planType]
        );
        const paymentId = rows[0].id;

        delete userStates[tgId];

        await ctx.reply(
            `✅ <b>Чек получен!</b>
📋 Заявка #${paymentId} отправлена на проверку.
⏱ Обычно это занимает до 5 минут.`,
            { parse_mode: 'HTML' }
        );

        const user = await getUser(tgId);
        const caption = `🔔 <b>Новая оплата</b>
👤 Пользователь: ${user?.first_name || 'Unknown'}
📛 @${user?.username || 'нет'} | 🆔 <code>${tgId}</code>
💎 Тариф: <b>${planType}</b>
💰 Сумма: ${amount}₽
📋 Заявка: #${paymentId}`;

        // 🔥 ИСПРАВЛЕНО: прямой формат кнопок для админа
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ Одобрить', callback_data: `approve_${paymentId}` }],
                [{ text: '❌ Отклонить', callback_data: `reject_${paymentId}` }]
            ]
        };

        if (ctx.message.photo) {
            await ctx.telegram.sendPhoto(ADMIN_ID, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await ctx.telegram.sendDocument(ADMIN_ID, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
        }
    });

    // =========================
    // ADMIN: APPROVE
    // =========================
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }
        const paymentId = ctx.match[1];

        try {
            const { rows: [payment] } = await pool.query(
                `SELECT * FROM payments WHERE id = $1`, [paymentId]
            );
            if (!payment) return ctx.answerCbQuery('❌ Заявка не найдена', { show_alert: true });

            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);

            await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1`, [payment.user_id]);

            await pool.query(
                `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type)                 VALUES ($1, TRUE, $2, $3)`,
                [payment.user_id, expiresAt, payment.plan_type]
            );

            await resetFreeRecipes(payment.user_id);

            await pool.query(`UPDATE payments SET status = 'approved' WHERE id = $1`, [paymentId]);
            await ctx.answerCbQuery('✅ Подписка активирована');
            await ctx.editMessageCaption(
                `✅ <b>Одобрено</b>\n📋 Заявка #${paymentId}\n🔥 Подписка ${payment.plan_type} активирована`,
                { parse_mode: 'HTML' }
            );

            await ctx.telegram.sendMessage(
                payment.user_id,
                `🎉 <b>Подписка активирована!</b>

🔥 Тариф: <b>${payment.plan_type}</b>
📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}

👨‍🍳 Добро пожаловать в Шеф-Повар AI!
${payment.plan_type === 'VIP' ? '\n✨ Доступны: /weekmenu — меню на период, /diet — ИИ-диетолог' : ''}`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Approve error:', e);
            await ctx.answerCbQuery('❌ Ошибка: ' + e.message, { show_alert: true });
        }
    });

    // =========================
    // ADMIN: REJECT (с причиной)
    // =========================
    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }
        const paymentId = ctx.match[1];
        
        userStates[`admin_reject_${ADMIN_ID}`] = { paymentId };
        
        await ctx.answerCbQuery('✍️ Напишите причину отказа (или "нет причины")');
        await ctx.reply('📝 Введите причину отклонения заявки #' + paymentId);
    });

    // Обработка причины отказа от админа
    bot.on('text', async (ctx) => {
        const adminKey = `admin_reject_${ADMIN_ID}`;
        if (ctx.from.id === ADMIN_ID && userStates[adminKey]) {
            const { paymentId } = userStates[adminKey];            const reason = ctx.message.text.trim();
            delete userStates[adminKey];

            try {
                const { rows: [payment] } = await pool.query(
                    `SELECT * FROM payments WHERE id = $1`, [paymentId]                );
                if (!payment) return ctx.reply('❌ Заявка не найдена');

                await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]);

                await ctx.reply(`❌ Заявка #${paymentId} отклонена`);

                let rejectMsg = `❌ <b>Платёж отклонён</b>\n\nПроверьте чек и попробуйте снова.`;
                if (reason && reason.toLowerCase() !== 'нет причины') {
                    rejectMsg += `\n\n📌 Причина: <i>${reason}</i>`;
                }

                await ctx.telegram.sendMessage(payment.user_id, rejectMsg, { parse_mode: 'HTML' });
            } catch (e) {
                console.error('Reject error:', e);
                ctx.reply('❌ Ошибка: ' + e.message);
            }
            return;
        }

        await handleUserRecipeRequest(ctx);
    });

    // =========================
    // MAIN: Recipe Request Handler
    // =========================
    async function handleUserRecipeRequest(ctx) {
        const text = ctx.message?.text?.trim();
        if (!text || text.startsWith('/')) return;

        const tgId = ctx.from.id;
        if (tgId === ADMIN_ID) return;

        await createUser(tgId, ctx.from.username, ctx.from.first_name);

        const subscription = await hasSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);

        if (!subscription && freeUsed >= FREE_LIMIT) {
            return sendSubscriptionMenu(ctx);
        }

        const requestType = detectRequestType(text);
        
        if (!userStates[tgId]) {            userStates[tgId] = {
                requestType,
                ingredients: text,
                step: 'details'
            };            
            const prompt = requestType === 'ingredients' 
                ? `👨‍🍳 Уточните для идеального рецепта:\n👥 На сколько порций?\n🥗 Есть ли предпочтения (ПП, без глютена и т.д.)?`
                : `👨‍🍳 Уточните:\n👥 На сколько порций готовить?\n🥗 Есть ли диетические предпочтения?`;
                
            return ctx.reply(prompt);
        }

        if (userStates[tgId]?.step === 'details') {
            const state = userStates[tgId];
            const details = text;
            delete userStates[tgId];

            const loading = await ctx.reply('👨‍🍳 Готовлю рецепт...');

            try {
                const planType = subscription?.plan_type || 'FREE';
                const { system, user: userPrompt } = buildPrompt(
                    state.requestType,
                    state.ingredients,
                    details,
                    planType
                );

                // 🔹 ЗАМЕНА: giga.chat() → callGigaChat()
                const recipe = await callGigaChat(system, userPrompt, 3000, 0.85);

                try { await ctx.deleteMessage(loading.message_id); } catch(e) {}

                await ctx.reply(recipe, { parse_mode: 'HTML' });

                if (!subscription) {
                    await incrementFreeRecipes(tgId);
                    const newUsed = freeUsed + 1;
                    const left = FREE_LIMIT - newUsed;
                    
                    if (left <= 0) {
                        await sendSubscriptionMenu(ctx);
                    }
                }

            } catch (err) {
                console.error('GigaChat error:', err);
                await ctx.reply('❌ Ошибка генерации рецепта. Попробуйте позже.');
            }
        }    }

    // =========================
    // VIP COMMANDS    // =========================
    bot.command('weekmenu', async (ctx) => {
        const subscription = await hasSubscription(ctx.from.id);
        if (!subscription || subscription.plan_type !== 'VIP') {
            return ctx.reply('🔒 Эта функция доступна только в тарифе VIP');
        }
        
        userStates[ctx.from.id] = { mode: 'weekmenu' };
        await ctx.reply(
            `📅 <b>Составляю меню</b>\n\nУкажите:\n• 👥 Количество человек\n• 💰 Бюджет на период (опционально)\n• 🥗 Тип питания (обычное / ПП / низкоуглеводное)\n• 📆 Период: день / неделя / 2 недели / месяц`,
            { parse_mode: 'HTML' }
        );
    });

    bot.command('diet', async (ctx) => {
        const subscription = await hasSubscription(ctx.from.id);
        if (!subscription || subscription.plan_type !== 'VIP') {
            return ctx.reply('🔒 Эта функция доступна только в тарифе VIP');
        }
        
        userStates[ctx.from.id] = { mode: 'diet' };
        await ctx.reply(
            `🥗 <b>ИИ-Диетолог</b>\n\nУкажите:\n• 📏 Рост (см)\n• ⚖️ Вес (кг)\n• 🎂 Возраст\n• 🎯 Цель (похудение / набор массы / поддержание веса)`,
            { parse_mode: 'HTML' }
        );
    });

    // Обработка ответов на VIP-команды
    bot.on('text', async (ctx) => {
        const tgId = ctx.from.id;
        const state = userStates[tgId];
        
        if (state?.mode && ctx.from.id !== ADMIN_ID) {
            await ctx.reply('🔄 Функция в разработке. Скоро будет доступно!');
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
