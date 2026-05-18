const crypto = require('crypto');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

const PRO_PRICE = 500;
const VIP_PRICE = 800;
const FREE_LIMIT = 3;

const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';

// =========================
// GIGACHAT API
// =========================
let cachedToken = null;
let tokenExpiry = 0;

async function getGigaToken() {
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    const res = await fetch(
        'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Authorization': `Basic ${GIGA_CREDENTIALS}`,
                'RqUID': crypto.randomUUID()
            },
            body: 'scope=GIGACHAT_API_PERS'
        }
    );

    const data = await res.json();

    if (!res.ok) {
        throw new Error(`GigaChat Auth: ${data.message || res.statusText}`);
    }

    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_at - 30) * 1000;

    return cachedToken;
}

async function callGigaChat(systemPrompt, userPrompt) {
    const token = await getGigaToken();

    const res = await fetch(
        'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                model: 'GigaChat',
                temperature: 0.8,
                max_tokens: 3000,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: userPrompt
                    }
                ]
            })
        }
    );

    const data = await res.json();

    if (!res.ok) {
        throw new Error(`GigaChat API: ${data.message || res.statusText}`);
    }

    return data.choices[0].message.content;
}

// =========================
// CLEAN HTML
// =========================
function cleanHtml(text) {
    if (!text) return '';

    return text
        .replace(/```html/gi, '')
        .replace(/```/g, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<html[\s\S]*?>/gi, '')
        .replace(/<\/html>/gi, '')
        .replace(/<body[\s\S]*?>/gi, '')
        .replace(/<\/body>/gi, '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<h1>/gi, '<b>')
        .replace(/<\/h1>/gi, '</b>\n')
        .replace(/<h2>/gi, '<b>')
        .replace(/<\/h2>/gi, '</b>\n')
        .replace(/<ul>/gi, '')
        .replace(/<\/ul>/gi, '')
        .replace(/<ol.*?>/gi, '')
        .replace(/<\/ol>/gi, '')
        .replace(/<li>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        .replace(/\*\*/g, '')
        .replace(/<br>/gi, '\n')
        .replace(/<br\/>/gi, '\n')
        .replace(/<br \/>/gi, '\n')
        .replace(/&nbsp;/gi, ' ')
        .replace(/<div>/gi, '')
        .replace(/<\/div>/gi, '\n')
        .replace(/class=".*?"/gi, '')
        .replace(/style=".*?"/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// =========================
// EXPORT
// =========================
module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ VIP Chef Bot loaded');

    const userStates = {};

    // =========================
    // REQUEST TYPE
    // =========================
    function detectRequestType(text) {
        const lower = text.toLowerCase();

        const dishKeywords = [
            'рецепт',
            'приготовь',
            'хочу',
            'сделай',
            'как сделать',
            'борщ',
            'салат',
            'суп',
            'паста',
            'карбонара',
            'омлет',
            'плов',
            'котлеты',
            'торт',
            'десерт'
        ];

        if (dishKeywords.some(k => lower.includes(k))) {
            return 'dish';
        }

        if (text.includes(',')) {
            return 'ingredients';
        }

        return 'dish';
    }

    // =========================
    // BUILD PROMPT
    // =========================
    function buildPrompt(requestType, ingredients, details, planType) {

        const isVIP = planType === 'VIP';

        const system = `
Ты элитный ИИ Шеф-Повар.

ВАЖНО:
• Используй ТОЛЬКО Telegram HTML
• Разрешены ТОЛЬКО теги:
<b>, <i>

ЗАПРЕЩЕНО:
❌ <style>
❌ <script>
❌ <h1>
❌ <ul>
❌ <ol>
❌ <li>
❌ markdown **
❌ любые другие html теги

Структура ответа:

<b>🍽 Название блюда</b>

<b>Описание</b>
Описание блюда

<b>Ингредиенты</b>
• ингредиент
• ингредиент

<b>Метод приготовления</b>
Описание

<b>Пошаговое приготовление</b>
1. Шаг
2. Шаг

<b>Советы</b>
Советы

<b>Напитки</b>
Напитки

${isVIP ? 'Добавь КБЖУ.' : ''}
`;

        if (requestType === 'ingredients') {
            return {
                system,
                user: `
Приготовь блюдо ТОЛЬКО из этих ингредиентов:

${ingredients}

Дополнительно:
${details}
`
            };
        }

        return {
            system,
            user: `
Запрос блюда:
${ingredients}

Дополнительно:
${details}
`
        };
    }

    // =========================
    // DB HELPERS
    // =========================
    async function createUser(tgId, username, firstName) {
        await pool.query(
            `
            INSERT INTO users (
                tg_id,
                username,
                first_name,
                free_recipes_used
            )
            VALUES ($1,$2,$3,0)
            ON CONFLICT (tg_id) DO NOTHING
            `,
            [tgId, username, firstName]
        );
    }

    async function getUser(tgId) {
        const { rows } = await pool.query(
            `SELECT * FROM users WHERE tg_id = $1`,
            [tgId]
        );

        return rows[0];
    }

    async function getFreeRecipesUsed(tgId) {
        const user = await getUser(tgId);
        return user?.free_recipes_used || 0;
    }

    async function incrementFreeRecipes(tgId) {
        await pool.query(
            `
            UPDATE users
            SET free_recipes_used = free_recipes_used + 1
            WHERE tg_id = $1
            `,
            [tgId]
        );
    }

    async function resetFreeRecipes(tgId) {
        await pool.query(
            `
            UPDATE users
            SET free_recipes_used = 0
            WHERE tg_id = $1
            `,
            [tgId]
        );
    }

    async function hasSubscription(tgId) {
        const { rows } = await pool.query(
            `
            SELECT *
            FROM subscriptions
            WHERE user_id = $1
            AND is_active = TRUE
            AND expires_at > NOW()
            LIMIT 1
            `,
            [tgId]
        );

        return rows[0];
    }

    // =========================
    // SUB MENU
    // =========================
    async function sendSubscriptionMenu(ctx) {

        return ctx.reply(
            `🎯 <b>Пробный лимит закончился</b>

Выберите подписку:

💳 <b>PRO — ${PRO_PRICE}₽</b>

💎 <b>VIP — ${VIP_PRICE}₽</b>
• ИИ диетолог
• КБЖУ
• Меню на неделю
`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💰 Купить PRO',
                                callback_data: 'pay_pro'
                            }
                        ],
                        [
                            {
                                text: '💎 Купить VIP',
                                callback_data: 'pay_vip'
                            }
                        ]
                    ]
                }
            }
        );
    }

    // =========================
    // PAYMENT TEXT
    // =========================
    function getPaymentInstruction(planType, amount) {

        return `
💳 <b>Оплата ${planType}</b>

Сумма: <b>${amount}₽</b>

📱 Номер:
<code>${SBP_PHONE}</code>

👤 Получатель:
${SBP_RECIPIENT}

После оплаты отправьте чек.
`;
    }

    // =========================
    // START
    // =========================
    bot.start(async (ctx) => {

        if (ctx.from.id === ADMIN_ID) return;

        const tgId = ctx.from.id;

        await createUser(
            tgId,
            ctx.from.username,
            ctx.from.first_name
        );

        const subscription = await hasSubscription(tgId);

        const freeUsed = await getFreeRecipesUsed(tgId);

        if (subscription) {

            return ctx.reply(
                `
👨‍🍳 <b>Добро пожаловать!</b>

🔥 Тариф:
<b>${subscription.plan_type}</b>

Напишите рецепт или ингредиенты.
`,
                {
                    parse_mode: 'HTML'
                }
            );
        }

        if (freeUsed >= FREE_LIMIT) {
            return sendSubscriptionMenu(ctx);
        }

        const left = FREE_LIMIT - freeUsed;

        await ctx.reply(
            `
👨‍🍳 <b>Шеф-Повар AI</b>

🍽 Осталось бесплатных рецептов:
<b>${left}</b>
`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // PAY BUTTONS
    // =========================
    bot.action('pay_pro', async (ctx) => {

        await ctx.answerCbQuery();

        userStates[ctx.from.id] = {
            payingFor: 'PRO',
            amount: PRO_PRICE
        };

        await ctx.editMessageText(
            getPaymentInstruction('PRO', PRO_PRICE),
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔙 Назад',
                                callback_data: 'show_subscriptions'
                            }
                        ]
                    ]
                }
            }
        );
    });

    bot.action('pay_vip', async (ctx) => {

        await ctx.answerCbQuery();

        userStates[ctx.from.id] = {
            payingFor: 'VIP',
            amount: VIP_PRICE
        };

        await ctx.editMessageText(
            getPaymentInstruction('VIP', VIP_PRICE),
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔙 Назад',
                                callback_data: 'show_subscriptions'
                            }
                        ]
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
// RECEIPTS + ADMIN NOTIFY FIX
// =========================
bot.on(['photo', 'document'], async (ctx) => {

    const tgId = ctx.from.id;
    const state = userStates[tgId];

    if (!state?.payingFor) {
        return ctx.reply('📎 Чек принимается только при оплате подписки.');
    }

    let fileId = null;

    if (ctx.message.photo) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    }

    if (ctx.message.document) {
        fileId = ctx.message.document.file_id;
    }

    if (!fileId) return;

    // =========================
    // SAVE PAYMENT
    // =========================
    const { rows } = await pool.query(
        `
        INSERT INTO payments (
            user_id,
            amount,
            receipt_file_id,
            status,
            plan_type
        )
        VALUES ($1,$2,$3,'pending',$4)
        RETURNING id
        `,
        [
            tgId,
            state.amount,
            fileId,
            state.payingFor
        ]
    );

    const paymentId = rows[0].id;

    delete userStates[tgId];

    // =========================
    // USER RESPONSE
    // =========================
    await ctx.reply(
        `✅ <b>Чек получен!</b>\n📋 Заявка #${paymentId}\n⏳ Ожидайте подтверждения`,
        { parse_mode: 'HTML' }
    );

    // =========================
    // GET USER INFO
    // =========================
    const user = await getUser(tgId);

    // =========================
    // ADMIN MESSAGE (FIX HERE)
    // =========================
    const adminCaption =
`🚨 <b>НОВАЯ ЗАЯВКА НА ПОДПИСКУ</b>

📋 Заявка: #${paymentId}
👤 Пользователь: ${user?.first_name || 'Unknown'}
📛 @${user?.username || 'нет'}
🆔 ID: <code>${tgId}</code>

💎 Тариф: <b>${state.payingFor}</b>
💰 Сумма: <b>${state.amount}₽</b>`;

    const adminKeyboard = {
        inline_keyboard: [
            [
                { text: '✅ Одобрить', callback_data: `approve_${paymentId}` }
            ],
            [
                { text: '❌ Отклонить', callback_data: `reject_${paymentId}` }
            ]
        ]
    };

    // =========================
    // SEND TO ADMIN
    // =========================
    try {
        if (ctx.message.photo) {
            await ctx.telegram.sendPhoto(
                ADMIN_ID,
                fileId,
                {
                    caption: adminCaption,
                    parse_mode: 'HTML',
                    reply_markup: adminKeyboard
                }
            );
        } else {
            await ctx.telegram.sendDocument(
                ADMIN_ID,
                fileId,
                {
                    caption: adminCaption,
                    parse_mode: 'HTML',
                    reply_markup: adminKeyboard
                }
            );
        }
    } catch (e) {
        console.error('ADMIN NOTIFY ERROR:', e);
    }
});

    // =========================
    // MAIN TEXT
    // =========================
    bot.on('text', async (ctx) => {

        const text = ctx.message.text?.trim();

        if (!text) return;

        if (text.startsWith('/')) return;

        const tgId = ctx.from.id;

        if (tgId === ADMIN_ID) return;

        await createUser(
            tgId,
            ctx.from.username,
            ctx.from.first_name
        );

        const subscription = await hasSubscription(tgId);

        const freeUsed = await getFreeRecipesUsed(tgId);

        if (!subscription && freeUsed >= FREE_LIMIT) {
            return sendSubscriptionMenu(ctx);
        }

        const state = userStates[tgId];

        // STEP 1
        if (!state) {

            const requestType = detectRequestType(text);

            userStates[tgId] = {
                requestType,
                ingredients: text,
                step: 'details'
            };

            return ctx.reply(
                `
👨‍🍳 Укажите:

👥 Количество порций
🥗 Предпочтения
`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            ['🥗 ПП'],
                            ['🔥 Низкокалорийное'],
                            ['💪 Набор массы']
                        ],
                        resize_keyboard: true
                    }
                }
            );
        }

        // STEP 2
        if (state.step === 'details') {

            delete userStates[tgId];

            const loading = await ctx.reply(
                '👨‍🍳 Готовлю рецепт...'
            );

            try {

                const planType =
                    subscription?.plan_type || 'FREE';

                const prompt = buildPrompt(
                    state.requestType,
                    state.ingredients,
                    text,
                    planType
                );

                let recipe = await callGigaChat(
                    prompt.system,
                    prompt.user
                );

                recipe = cleanHtml(recipe);

                try {
                    await ctx.deleteMessage(
                        loading.message_id
                    );
                } catch {}

                await ctx.reply(
                    recipe,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            keyboard: [
                                ['🍽 Новый рецепт'],
                                ['📅 Меню на неделю'],
                                ['💎 VIP']
                            ],
                            resize_keyboard: true
                        }
                    }
                );

                if (!subscription) {

                    await incrementFreeRecipes(tgId);

                    const newUsed = freeUsed + 1;

                    if (newUsed >= FREE_LIMIT) {
                        await sendSubscriptionMenu(ctx);
                    }
                }

            } catch (err) {

                console.error(err);

                await ctx.reply(
                    `
❌ Ошибка генерации рецепта

${err.message}
`
                );
            }
        }
    });

    // =========================
    // VIP MENU
    // =========================
    bot.command('weekmenu', async (ctx) => {

        const subscription =
            await hasSubscription(ctx.from.id);

        if (
            !subscription ||
            subscription.plan_type !== 'VIP'
        ) {
            return ctx.reply(
                '🔒 Только для VIP'
            );
        }

        await ctx.reply(
            `
📅 Укажите:

• Количество человек
• Период
• Тип питания
`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // DIET
    // =========================
    bot.command('diet', async (ctx) => {

        const subscription =
            await hasSubscription(ctx.from.id);

        if (
            !subscription ||
            subscription.plan_type !== 'VIP'
        ) {
            return ctx.reply(
                '🔒 Только для VIP'
            );
        }

        await ctx.reply(
            `
🥗 Укажите:

• Рост
• Вес
• Возраст
• Цель
`,
            {
                parse_mode: 'HTML'
            }
        );
    });
    // =========================
    // ✅ ADMIN: APPROVE PAYMENT
    // =========================
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        // Проверяем, что нажал админ
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }

        const paymentId = ctx.match[1];
        console.log(`🔄 Админ одобряет заявку #${paymentId}`);

        try {
            // 1. Получаем данные платежа
            const { rows: [payment] } = await pool.query(
                `SELECT * FROM payments WHERE id = $1`,
                [paymentId]
            );

            if (!payment) {
                return ctx.answerCbQuery('❌ Заявка не найдена', { show_alert: true });
            }

            const userId = payment.user_id;
            const planType = payment.plan_type;

            // 2. Деактивируем старые подписки пользователя
            await pool.query(
                `UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1`,
                [userId]
            );

            // 3. Создаём новую активную подписку (30 дней)
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);

            await pool.query(
                `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type)
                 VALUES ($1, TRUE, $2, $3)`,
                [userId, expiresAt, planType]
            );

            // 4. Сбрасываем счётчик бесплатных рецептов
            await pool.query(
                `UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`,
                [userId]
            );

            // 5. Обновляем статус платежа
            await pool.query(                `UPDATE payments SET status = 'approved' WHERE id = $1`,
                [paymentId]
            );

            // 6. Уведомляем админа
            await ctx.answerCbQuery('✅ Подписка активирована');
            await ctx.editMessageCaption(
                `✅ <b>Одобрено</b>\n📋 #${paymentId}\n🔥 ${planType} активирована`,
                { parse_mode: 'HTML' }
            );

            // 7. Уведомляем пользователя
            await ctx.telegram.sendMessage(
                userId,
                `🎉 <b>Подписка активирована!</b>\n\n` +
                `🔥 Тариф: <b>${planType}</b>\n` +
                `📅 Действует до: ${expiresAt.toLocaleDateString('ru-RU')}\n\n` +
                `👨‍🍳 Теперь у тебя полный доступ к Шеф-Повар AI!\n` +
                `${planType === 'VIP' ? '✨ Доступны: /weekmenu — меню, /diet — диетолог' : ''}`,
                { parse_mode: 'HTML' }
            );

            console.log(`✅ Подписка ${planType} активирована для пользователя ${userId}`);

        } catch (err) {
            console.error('❌ APPROVE ERROR:', err);
            await ctx.answerCbQuery('❌ Ошибка при активации', { show_alert: true });
        }
    });

    // =========================
    // ❌ ADMIN: REJECT PAYMENT
    // =========================
    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return ctx.answerCbQuery('🔒 Доступ запрещён', { show_alert: true });
        }

        const paymentId = ctx.match[1];
        console.log(`🔄 Админ отклоняет заявку #${paymentId}`);

        try {
            // 1. Получаем данные платежа
            const { rows: [payment] } = await pool.query(
                `SELECT * FROM payments WHERE id = $1`,
                [paymentId]
            );

            if (!payment) {
                return ctx.answerCbQuery('❌ Заявка не найдена', { show_alert: true });            }

            const userId = payment.user_id;

            // 2. Обновляем статус платежа
            await pool.query(
                `UPDATE payments SET status = 'rejected' WHERE id = $1`,
                [paymentId]
            );

            // 3. Уведомляем админа
            await ctx.answerCbQuery('❌ Отклонено');
            await ctx.editMessageCaption(
                `❌ <b>Отклонено</b>\n📋 #${paymentId}`,
                { parse_mode: 'HTML' }
            );

            // 4. Уведомляем пользователя
            await ctx.telegram.sendMessage(
                userId,
                `❌ <b>Платёж отклонён</b>\n\n` +
                `📋 Заявка #${paymentId}\n\n` +
                `Проверь чек и попробуй отправить снова.\n` +
                `Если проблема не решается — напиши в поддержку.`,
                { parse_mode: 'HTML' }
            );

            console.log(`❌ Заявка #${paymentId} отклонена для пользователя ${userId}`);

        } catch (err) {
            console.error('❌ REJECT ERROR:', err);
            await ctx.answerCbQuery('❌ Ошибка', { show_alert: true });
        }
    });

};
