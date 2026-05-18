const { Markup } = require('telegraf');
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
        throw new Error(
            `GigaChat Auth Error: ${data.message}`
        );
    }

    cachedToken = data.access_token;

    tokenExpiry =
        Date.now() + ((data.expires_at || 3600) - 30) * 1000;

    return cachedToken;
}

async function callGigaChat(
    systemPrompt,
    userPrompt,
    maxTokens = 3000,
    temperature = 0.85
) {

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

                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: userPrompt
                    }
                ],

                max_tokens: maxTokens,
                temperature
            })
        }
    );

    const data = await res.json();

    if (!res.ok) {
        throw new Error(
            `GigaChat API Error: ${data.message}`
        );
    }

    return data.choices[0].message.content;
}

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ VIP CHEF BOT LOADED');

    const userStates = {};

    // =========================
    // SAFE HTML
    // =========================
    function sanitizeHTML(text) {

        if (!text) {
            return '❌ Пустой ответ';
        }

        return text

            .replace(/\*\*/g, '')

            .replace(
                /<b>([^<]+)\*\*/g,
                '<b>$1</b>'
            )

            .replace(
                /\*\*<\/b>/g,
                '</b>'
            )

            .replace(
                /<b>(.*?)$/gm,
                '<b>$1</b>'
            )

            .replace(
                /<([^>]+)$/g,
                ''
            )

            .replace(
                /<\/b><\/b>/g,
                '</b>'
            )

            .replace(/undefined/g, '')
            .replace(/null/g, '');
    }

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
            'карбонара',
            'борщ',
            'салат',
            'суп',
            'котлеты',
            'торт',
            'паста',
            'десерт'
        ];

        if (
            dishKeywords.some(x => lower.includes(x))
        ) {
            return 'dish';
        }

        if (text.includes(',')) {
            return 'ingredients';
        }

        return 'dish';
    }

    // =========================
    // PROMPT
    // =========================
    function buildPrompt(
        requestType,
        ingredients,
        details,
        planType
    ) {

        const isVIP = planType === 'VIP';

        let vipText = '';

        if (isVIP) {

            vipText = `
✨ VIP:
• КБЖУ
• Диетолог
• ПП рекомендации
`;
        }

        const system = `
Ты профессиональный ИИ ШЕФ-ПОВАР.

Структура:

1️⃣ <b>Название блюда</b>

2️⃣ <b>Описание</b>

3️⃣ <b>Ингредиенты</b>

4️⃣ <b>Метод приготовления</b>

5️⃣ <b>Пошаговое приготовление</b>

6️⃣ <b>Советы</b>

7️⃣ <b>Напитки</b>

Используй HTML.
Не используй markdown **

${vipText}
`;

        if (requestType === 'ingredients') {

            return {

                system,

                user: `
Приготовь блюдо ТОЛЬКО из:

${ingredients}

Дополнительно:

${details || 'без ограничений'}
`
            };
        }

        return {

            system,

            user: `
Пользователь хочет рецепт:

${ingredients}

Дополнительно:

${details || 'без ограничений'}
`
        };
    }

    // =========================
    // DB
    // =========================
    async function createUser(
        tgId,
        username,
        firstName
    ) {

        await pool.query(
            `
            INSERT INTO users
            (
                tg_id,
                username,
                first_name,
                free_recipes_used
            )

            VALUES ($1, $2, $3, 0)

            ON CONFLICT (tg_id)
            DO NOTHING
            `,
            [
                tgId,
                username,
                firstName
            ]
        );
    }

    async function getUser(tgId) {

        const { rows } = await pool.query(
            `
            SELECT *
            FROM users
            WHERE tg_id = $1
            `,
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

            SET free_recipes_used =
            free_recipes_used + 1

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
            `
🎯 <b>Пробный лимит закончился</b>

💳 <b>PRO — ${PRO_PRICE}₽</b>
• Безлимит рецептов

💎 <b>VIP — ${VIP_PRICE}₽</b>
• Всё из PRO
• ИИ Диетолог
• Меню
• КБЖУ
• ПП рецепты
`,
            {
                parse_mode: 'HTML',

                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💳 Купить PRO',
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
    function getPaymentInstruction(
        plan,
        amount
    ) {

        return `
💳 <b>Оплата ${plan}</b>

💰 Сумма:
<b>${amount}₽</b>

📱 СБП:
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

        if (ctx.from.id === ADMIN_ID) {
            return;
        }

        const tgId = ctx.from.id;

        await createUser(
            tgId,
            ctx.from.username,
            ctx.from.first_name
        );

        const subscription =
            await hasSubscription(tgId);

        const freeUsed =
            await getFreeRecipesUsed(tgId);

        if (subscription) {

            return ctx.reply(
                `
👨‍🍳 <b>Добро пожаловать!</b>

🔥 Тариф:
<b>${subscription.plan_type}</b>

Напишите блюдо или ингредиенты.
`,
                {
                    parse_mode: 'HTML',

                    reply_markup: {
                        keyboard: [
                            ['🍳 Рецепт'],
                            ['📅 Меню'],
                            ['🥗 Диетолог'],
                            ['💎 Подписка']
                        ],

                        resize_keyboard: true
                    }
                }
            );
        }

        if (freeUsed >= FREE_LIMIT) {
            return sendSubscriptionMenu(ctx);
        }

        const left =
            FREE_LIMIT - freeUsed;

        await ctx.reply(
            `
👨‍🍳 <b>Шеф-Повар AI</b>

🍽 Отправьте:
• ингредиенты
• или название блюда

🎁 Осталось:
<b>${left}</b>
`,
            {
                parse_mode: 'HTML',

                reply_markup: {
                    keyboard: [
                        ['🍳 Рецепт'],
                        ['💎 Подписка']
                    ],

                    resize_keyboard: true
                }
            }
        );
    });

    // =========================
    // BUTTONS
    // =========================
    bot.hears(
        '💎 Подписка',
        async (ctx) => {

            await sendSubscriptionMenu(ctx);
        }
    );

    bot.hears(
        '📅 Меню',
        async (ctx) => {

            await ctx.reply('/weekmenu');
        }
    );

    bot.hears(
        '🥗 Диетолог',
        async (ctx) => {

            await ctx.reply('/diet');
        }
    );

    // =========================
    // PAYMENT FLOW
    // =========================
    bot.action(
        'pay_pro',
        async (ctx) => {

            await ctx.answerCbQuery();

            userStates[ctx.from.id] = {
                payingFor: 'PRO',
                amount: PRO_PRICE
            };

            await ctx.editMessageText(
                getPaymentInstruction(
                    'PRO',
                    PRO_PRICE
                ),
                {
                    parse_mode: 'HTML',

                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🔙 Назад',
                                    callback_data:
                                        'show_subscriptions'
                                }
                            ]
                        ]
                    }
                }
            );
        }
    );

    bot.action(
        'pay_vip',
        async (ctx) => {

            await ctx.answerCbQuery();

            userStates[ctx.from.id] = {
                payingFor: 'VIP',
                amount: VIP_PRICE
            };

            await ctx.editMessageText(
                getPaymentInstruction(
                    'VIP',
                    VIP_PRICE
                ),
                {
                    parse_mode: 'HTML',

                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🔙 Назад',
                                    callback_data:
                                        'show_subscriptions'
                                }
                            ]
                        ]
                    }
                }
            );
        }
    );

    bot.action(
        'show_subscriptions',
        async (ctx) => {

            await ctx.answerCbQuery();

            delete userStates[
                ctx.from.id
            ];

            await sendSubscriptionMenu(ctx);
        }
    );

    // =========================
    // RECEIPT
    // =========================
    bot.on(
        ['photo', 'document'],
        async (ctx) => {

            const tgId = ctx.from.id;

            const state =
                userStates[tgId];

            if (!state?.payingFor) {

                return ctx.reply(
                    '📎 Сначала выберите подписку'
                );
            }

            let fileId;

            if (ctx.message.photo) {

                fileId =
                    ctx.message.photo[
                        ctx.message.photo.length - 1
                    ].file_id;
            }

            if (ctx.message.document) {

                fileId =
                    ctx.message.document.file_id;
            }

            const { rows } =
                await pool.query(
                    `
                    INSERT INTO payments
                    (
                        user_id,
                        amount,
                        receipt_file_id,
                        status,
                        plan_type
                    )

                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        'pending',
                        $4
                    )

                    RETURNING id
                    `,
                    [
                        tgId,
                        state.amount,
                        fileId,
                        state.payingFor
                    ]
                );

            const paymentId =
                rows[0].id;

            await ctx.reply(
                `✅ Чек отправлен #${paymentId}`
            );

            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '✅ Одобрить',
                            callback_data:
                                `approve_${paymentId}`
                        }
                    ],

                    [
                        {
                            text: '❌ Отклонить',
                            callback_data:
                                `reject_${paymentId}`
                        }
                    ]
                ]
            };

            await ctx.telegram.sendMessage(
                ADMIN_ID,

                `
💰 Новая заявка

ID: ${paymentId}

USER: ${tgId}

Тариф:
${state.payingFor}
`,
                {
                    reply_markup: keyboard
                }
            );

            delete userStates[tgId];
        }
    );

    // =========================
    // APPROVE
    // =========================
    bot.action(
        /^approve_(\d+)$/,
        async (ctx) => {

            if (
                ctx.from.id !== ADMIN_ID
            ) {
                return;
            }

            const paymentId =
                ctx.match[1];

            const { rows } =
                await pool.query(
                    `
                    SELECT *

                    FROM payments

                    WHERE id = $1
                    `,
                    [paymentId]
                );

            const payment = rows[0];

            if (!payment) {
                return;
            }

            const expiresAt =
                new Date();

            expiresAt.setDate(
                expiresAt.getDate() + 30
            );

            await pool.query(
                `
                UPDATE subscriptions

                SET is_active = FALSE

                WHERE user_id = $1
                `,
                [payment.user_id]
            );

            await pool.query(
                `
                INSERT INTO subscriptions
                (
                    user_id,
                    is_active,
                    expires_at,
                    plan_type
                )

                VALUES
                (
                    $1,
                    TRUE,
                    $2,
                    $3
                )
                `,
                [
                    payment.user_id,
                    expiresAt,
                    payment.plan_type
                ]
            );

            await pool.query(
                `
                UPDATE payments

                SET status = 'approved'

                WHERE id = $1
                `,
                [paymentId]
            );

            await resetFreeRecipes(
                payment.user_id
            );

            await ctx.answerCbQuery(
                '✅ Одобрено'
            );

            await ctx.editMessageText(
                `✅ Заявка #${paymentId} одобрена`
            );

            await ctx.telegram.sendMessage(
                payment.user_id,

                `
🎉 <b>Подписка активирована</b>

🔥 Тариф:
<b>${payment.plan_type}</b>

📅 До:
${expiresAt.toLocaleDateString('ru-RU')}
`,
                {
                    parse_mode: 'HTML'
                }
            );
        }
    );

    // =========================
    // REJECT
    // =========================
    bot.action(
        /^reject_(\d+)$/,
        async (ctx) => {

            if (
                ctx.from.id !== ADMIN_ID
            ) {
                return;
            }

            const paymentId =
                ctx.match[1];

            await pool.query(
                `
                UPDATE payments

                SET status = 'rejected'

                WHERE id = $1
                `,
                [paymentId]
            );

            await ctx.answerCbQuery(
                '❌ Отклонено'
            );

            await ctx.editMessageText(
                `❌ Заявка #${paymentId} отклонена`
            );
        }
    );

    // =========================
    // WEEK MENU
    // =========================
    bot.command(
        'weekmenu',
        async (ctx) => {

            const subscription =
                await hasSubscription(
                    ctx.from.id
                );

            if (
                !subscription ||
                subscription.plan_type !==
                    'VIP'
            ) {

                return ctx.reply(
                    '🔒 Только VIP'
                );
            }

            userStates[ctx.from.id] = {
                mode: 'weekmenu'
            };

            await ctx.reply(
                `
📅 Укажите:

• количество человек
• период
• бюджет
• тип питания
`
            );
        }
    );

    // =========================
    // DIET
    // =========================
    bot.command(
        'diet',
        async (ctx) => {

            const subscription =
                await hasSubscription(
                    ctx.from.id
                );

            if (
                !subscription ||
                subscription.plan_type !==
                    'VIP'
            ) {

                return ctx.reply(
                    '🔒 Только VIP'
                );
            }

            userStates[ctx.from.id] = {
                mode: 'diet'
            };

            await ctx.reply(
                `
🥗 Укажите:

• рост
• вес
• возраст
• цель
`
            );
        }
    );

    // =========================
    // TEXT
    // =========================
    bot.on(
        'text',
        async (ctx) => {

            const text =
                ctx.message.text.trim();

            if (
                text.startsWith('/')
            ) {
                return;
            }

            const tgId =
                ctx.from.id;

            if (
                tgId === ADMIN_ID
            ) {
                return;
            }

            const state =
                userStates[tgId];

            // =========================
            // WEEK MENU
            // =========================
            if (
                state?.mode ===
                'weekmenu'
            ) {

                const loading =
                    await ctx.reply(
                        '📅 Составляю меню...'
                    );

                try {

                    const result =
                        await callGigaChat(
                            `
Ты профессиональный шеф-повар и нутрициолог.

Составь меню.
`,
                            text,
                            3000,
                            0.8
                        );

                    const safeResult =
                        sanitizeHTML(
                            result
                        );

                    try {

                        await ctx.deleteMessage(
                            loading.message_id
                        );

                    } catch {}

                    await ctx.reply(
                        safeResult,
                        {
                            parse_mode:
                                'HTML'
                        }
                    );

                } catch (e) {

                    console.log(e);

                    await ctx.reply(
                        '❌ Ошибка меню'
                    );
                }

                delete userStates[
                    tgId
                ];

                return;
            }

            // =========================
            // DIET
            // =========================
            if (
                state?.mode ===
                'diet'
            ) {

                const loading =
                    await ctx.reply(
                        '🥗 Анализирую...'
                    );

                try {

                    const result =
                        await callGigaChat(
                            `
Ты профессиональный диетолог.
`,
                            text,
                            3000,
                            0.8
                        );

                    const safeResult =
                        sanitizeHTML(
                            result
                        );

                    try {

                        await ctx.deleteMessage(
                            loading.message_id
                        );

                    } catch {}

                    await ctx.reply(
                        safeResult,
                        {
                            parse_mode:
                                'HTML'
                        }
                    );

                } catch (e) {

                    console.log(e);

                    await ctx.reply(
                        '❌ Ошибка диетолога'
                    );
                }

                delete userStates[
                    tgId
                ];

                return;
            }

            // =========================
            // DETAILS
            // =========================
            if (
                state?.step ===
                'details'
            ) {

                const details = text;

                delete userStates[
                    tgId
                ];

                const loading =
                    await ctx.reply(
                        '👨‍🍳 Готовлю рецепт...'
                    );

                try {

                    const subscription =
                        await hasSubscription(
                            tgId
                        );

                    const planType =
                        subscription?.plan_type ||
                        'FREE';

                    const {
                        system,
                        user
                    } = buildPrompt(
                        state.requestType,
                        state.ingredients,
                        details,
                        planType
                    );

                    const recipe =
                        await callGigaChat(
                            system,
                            user,
                            3000,
                            0.85
                        );

                    const safeRecipe =
                        sanitizeHTML(
                            recipe
                        );

                    try {

                        await ctx.deleteMessage(
                            loading.message_id
                        );

                    } catch {}

                    await ctx.reply(
                        safeRecipe,
                        {
                            parse_mode:
                                'HTML'
                        }
                    );

                    if (
                        !subscription
                    ) {

                        await incrementFreeRecipes(
                            tgId
                        );

                        const used =
                            await getFreeRecipesUsed(
                                tgId
                            );

                        if (
                            used >=
                            FREE_LIMIT
                        ) {

                            await sendSubscriptionMenu(
                                ctx
                            );
                        }
                    }

                } catch (e) {

                    console.log(e);

                    await ctx.reply(
                        '❌ Ошибка генерации рецепта'
                    );
                }

                return;
            }

            // =========================
            // FIRST MESSAGE
            // =========================
            const requestType =
                detectRequestType(
                    text
                );

            userStates[tgId] = {
                requestType,
                ingredients: text,
                step: 'details'
            };

            await ctx.reply(
                `
👨‍🍳 Уточните:

👥 На сколько порций?

🥗 Есть предпочтения?
`
            );
        }
    );

};
