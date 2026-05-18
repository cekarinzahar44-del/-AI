const { Telegraf, Markup } = require('telegraf');
const { GigaChat } = require('gigachat');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

const PRO_PRICE = 500;
const VIP_PRICE = 990;

const FREE_LIMIT = 3;

const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';

const giga = new GigaChat({
    credentials: GIGA_CREDENTIALS,
    scope: 'GIGACHAT_API_PERS'
});

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ VIP Chef Bot loaded');

    // =========================
    // USER STATES
    // =========================

    const userStates = {};

    // =========================
    // HELPER FUNCTIONS
    // =========================

    async function createUser(tgId, username, firstName) {

        await pool.query(
            `INSERT INTO users
            (tg_id, username, first_name, free_recipes_used)
            VALUES ($1, $2, $3, 0)
            ON CONFLICT (tg_id) DO NOTHING`,
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
            `UPDATE users
             SET free_recipes_used = free_recipes_used + 1
             WHERE tg_id = $1`,
            [tgId]
        );
    }

    async function hasSubscription(tgId) {

        const { rows } = await pool.query(
            `SELECT * FROM subscriptions
             WHERE user_id = $1
             AND is_active = TRUE
             AND expires_at > NOW()
             LIMIT 1`,
            [tgId]
        );

        return rows[0];
    }

    async function sendSubscriptionMenu(ctx) {

        return ctx.reply(
            `🔒 <b>Пробные рецепты закончились!</b>

👨‍🍳 Оформите подписку и получите полный доступ к AI ШЕФ-ПОВАРУ

✅ Безлимитные рецепты
📅 Меню на неделю
🥗 AI Диетолог
🍷 Подбор напитков
👨‍🍳 Premium советы шефа`,
            {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            `💳 PRO — ${PRO_PRICE}₽`,
                            'buy_pro'
                        )
                    ],
                    [
                        Markup.button.callback(
                            `👑 VIP — ${VIP_PRICE}₽`,
                            'buy_vip'
                        )
                    ]
                ])
            }
        );
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

        // =========================
        // АКТИВНАЯ ПОДПИСКА
        // =========================

        if (subscription) {

            return ctx.reply(
                `👨‍🍳 <b>Добро пожаловать обратно!</b>

🔥 Ваш тариф:
<b>${subscription.plan_type}</b>

🎯 Назовите ингредиенты
или спросите рецепт любого блюда.`,
                {
                    parse_mode: 'HTML'
                }
            );
        }

        // =========================
        // ЛИМИТ ЗАКОНЧЕН
        // =========================

        if (freeUsed >= FREE_LIMIT) {

            return ctx.reply(
                `👨‍🍳 <b>Здравствуйте, ${ctx.from.first_name}!</b>

Рады, что вы вернулись ❤️

🔒 Ваши бесплатные рецепты закончились.

Оформите подписку и получите полный доступ к AI ШЕФ-ПОВАРУ 👇`,
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [
                            Markup.button.callback(
                                `💳 Оформить подписку`,
                                'show_subscriptions'
                            )
                        ]
                    ])
                }
            );
        }

        // =========================
        // НОВЫЙ ПОЛЬЗОВАТЕЛЬ
        // =========================

        const left = FREE_LIMIT - freeUsed;

        await ctx.reply(
            `👨‍🍳 <b>Я ваш Домашний ШЕФ-ПОВАР!</b>

Добро пожаловать 🍽

🎯 Назовите свои ингредиенты
или спросите рецепт любого блюда.

🎁 Бесплатных рецептов осталось:
<b>${left}</b>`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // SHOW SUBSCRIPTIONS
    // =========================

    bot.action('show_subscriptions', async (ctx) => {

        await ctx.answerCbQuery();

        return sendSubscriptionMenu(ctx);
    });

    // =========================
    // PRO
    // =========================

    bot.action('buy_pro', async (ctx) => {

        await ctx.answerCbQuery();

        await ctx.reply(
            `💳 <b>PRO ПОДПИСКА — ${PRO_PRICE}₽</b>

✅ Безлимитные рецепты
🍽 Все блюда
👨‍🍳 AI ШЕФ-ПОВАР

1️⃣ Оплатите ${PRO_PRICE}₽ по СБП

📱 <code>${SBP_PHONE}</code>
👤 ${SBP_RECIPIENT}

2️⃣ Отправьте чек (фото или PDF)

⏱ Активация 5 минут`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // VIP
    // =========================

    bot.action('buy_vip', async (ctx) => {

        await ctx.answerCbQuery();

        await ctx.reply(
            `👑 <b>VIP ПОДПИСКА — ${VIP_PRICE}₽</b>

🔥 Включает:

🥗 AI Диетолог
📅 Меню на неделю
🍷 Подбор напитков
👨‍🍳 Подробные советы шефа
👨‍👩‍👧‍👦 Расчёт порций
🍽 Premium рецепты

1️⃣ Оплатите ${VIP_PRICE}₽ по СБП

📱 <code>${SBP_PHONE}</code>
👤 ${SBP_RECIPIENT}

2️⃣ Отправьте чек (фото или PDF)

⏱ Активация 5 минут`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // WEEK MENU
    // =========================

    bot.command('weekmenu', async (ctx) => {

        userStates[ctx.from.id] = {
            mode: 'weekmenu'
        };

        await ctx.reply(
            `📅 <b>Меню на неделю</b>

Напишите:

👨‍👩‍👧‍👦 Сколько человек
💰 Бюджет
🥗 Тип питания

Например:

2 человека
5000₽
ПП`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // AI DIETOLOGIST
    // =========================

    bot.command('diet', async (ctx) => {

        userStates[ctx.from.id] = {
            mode: 'diet'
        };

        await ctx.reply(
            `🥗 <b>AI Диетолог</b>

Напишите:

• рост
• вес
• возраст
• цель

Например:

180 см
85 кг
похудение`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // RECEIPTS
    // =========================

    bot.on(['photo', 'document'], async (ctx) => {

        const tgId = ctx.from.id;

        let fileId;

        let planType = 'PRO';

        if (ctx.message.caption?.includes('VIP')) {
            planType = 'VIP';
        }

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

        if (!fileId) return;

        const amount =
            planType === 'VIP'
                ? VIP_PRICE
                : PRO_PRICE;

        const { rows } = await pool.query(
            `INSERT INTO payments
            (user_id, amount, receipt_file_id, status, plan_type)
            VALUES ($1, $2, $3, 'pending', $4)
            RETURNING id`,
            [
                tgId,
                amount,
                fileId,
                planType
            ]
        );

        const paymentId = rows[0].id;

        await ctx.reply(
            `✅ <b>Чек получен!</b>

📋 Заявка #${paymentId}
отправлена на проверку.

⏱ Обычно это занимает 5 минут.`,
            {
                parse_mode: 'HTML'
            }
        );

        const user = await getUser(tgId);

        const caption =
            `🔔 <b>Новая оплата</b>

👤 Пользователь:
${user?.first_name || 'Unknown'}

📛 Username:
@${user?.username || 'нет'}

🆔 ID:
<code>${tgId}</code>

💎 Тариф:
${planType}

💰 Сумма:
${amount}₽

📋 Заявка:
#${paymentId}`;

        // PHOTO

        if (ctx.message.photo) {

            await ctx.telegram.sendPhoto(
                ADMIN_ID,
                fileId,
                {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '✅ Подтвердить',
                                    callback_data:
                                        `approve_${paymentId}`
                                },
                                {
                                    text: '❌ Отклонить',
                                    callback_data:
                                        `reject_${paymentId}`
                                }
                            ]
                        ]
                    }
                }
            );

        } else {

            // PDF

            await ctx.telegram.sendDocument(
                ADMIN_ID,
                fileId,
                {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '✅ Подтвердить',
                                    callback_data:
                                        `approve_${paymentId}`
                                },
                                {
                                    text: '❌ Отклонить',
                                    callback_data:
                                        `reject_${paymentId}`
                                }
                            ]
                        ]
                    }
                }
            );
        }
    });

    // =========================
    // APPROVE PAYMENT
    // =========================

    bot.action(/^approve_(\\d+)$/, async (ctx) => {

        const paymentId = ctx.match[1];

        const paymentResult = await pool.query(
            `SELECT * FROM payments
             WHERE id = $1`,
            [paymentId]
        );

        const payment =
            paymentResult.rows[0];

        if (!payment) {
            return;
        }

        const expiresAt = new Date();

        expiresAt.setDate(
            expiresAt.getDate() + 30
        );

        await pool.query(
            `UPDATE subscriptions
             SET is_active = FALSE
             WHERE user_id = $1`,
            [payment.user_id]
        );

        await pool.query(
            `INSERT INTO subscriptions
            (user_id, is_active, expires_at, plan_type)
            VALUES ($1, TRUE, $2, $3)`,
            [
                payment.user_id,
                expiresAt,
                payment.plan_type
            ]
        );

        await pool.query(
            `UPDATE payments
             SET status = 'approved'
             WHERE id = $1`,
            [paymentId]
        );

        await ctx.answerCbQuery(
            'Подписка активирована'
        );

        await ctx.editMessageCaption(
            `✅ <b>Оплата подтверждена</b>

📋 Заявка #${paymentId}

🔥 Подписка активирована`,
            {
                parse_mode: 'HTML'
            }
        );

        await ctx.telegram.sendMessage(
            payment.user_id,
            `🎉 <b>Подписка активирована!</b>

🔥 Тариф:
<b>${payment.plan_type}</b>

👨‍🍳 Добро пожаловать в VIP ШЕФ-ПОВАРА!`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // REJECT PAYMENT
    // =========================

    bot.action(/^reject_(\\d+)$/, async (ctx) => {

        const paymentId = ctx.match[1];

        const paymentResult = await pool.query(
            `SELECT * FROM payments
             WHERE id = $1`,
            [paymentId]
        );

        const payment =
            paymentResult.rows[0];

        if (!payment) return;

        await pool.query(
            `UPDATE payments
             SET status = 'rejected'
             WHERE id = $1`,
            [paymentId]
        );

        await ctx.answerCbQuery(
            'Платёж отклонён'
        );

        await ctx.editMessageCaption(
            `❌ <b>Оплата отклонена</b>

📋 Заявка #${paymentId}`,
            {
                parse_mode: 'HTML'
            }
        );

        await ctx.telegram.sendMessage(
            payment.user_id,
            `❌ <b>Платёж отклонён</b>

Проверьте чек и попробуйте снова.`,
            {
                parse_mode: 'HTML'
            }
        );
    });

    // =========================
    // MAIN TEXT
    // =========================

    bot.on('text', async (ctx) => {

        const text =
            ctx.message.text.trim();

        if (text.startsWith('/')) {
            return;
        }

        const tgId = ctx.from.id;

        if (tgId === ADMIN_ID) {
            return;
        }

        await createUser(
            tgId,
            ctx.from.username,
            ctx.from.first_name
        );

        const subscription =
            await hasSubscription(tgId);

        const freeUsed =
            await getFreeRecipesUsed(tgId);

        // =========================
        // FREE LIMIT
        // =========================

        if (
            !subscription &&
            freeUsed >= FREE_LIMIT
        ) {
            return sendSubscriptionMenu(ctx);
        }

        // =========================
        // QUESTIONS BEFORE RECIPE
        // =========================

        if (!userStates[tgId]) {

            userStates[tgId] = {
                ingredients: text,
                step: 'details'
            };

            return ctx.reply(
                `👨‍🍳 Для идеального рецепта ответьте:

👥 На сколько человек?
📅 На сколько дней?
🥗 Тип питания?

Например:

2 человека
2 дня
ПП`
            );
        }

        // =========================
        // DETAILS
        // =========================

        if (
            userStates[tgId]?.step === 'details'
        ) {

            const request =
                userStates[tgId];

            request.details = text;

            delete userStates[tgId];

            const loading =
                await ctx.reply(
                    '👨‍🍳 Готовлю VIP рецепт...'
                );

            try {

                const response =
                    await giga.chat({

                        model: 'GigaChat',

                        messages: [
                            {
                                role: 'system',
                                content:
`Ты элитный AI ШЕФ-ПОВАР и AI ДИЕТОЛОГ.

Создавай дорогие premium рецепты.

ОБЯЗАТЕЛЬНО:

🍽 Название блюда
💖 Описание
👨‍👩‍👧‍👦 Порции
📅 На сколько дней
🔥 Калории
🥩 Белки
🌾 Углеводы
🧈 Жиры

🛒 Ингредиенты

👨‍🍳 Подробные шаги:
⏱ Время
🌡 Температура
💡 Советы
❌ Ошибки новичков

🍷 Идеальный напиток
🍰 Десерт
🥗 Гарнир

📦 Как хранить
🔥 Как разогревать

🥗 Советы AI диетолога

Используй эмодзи.
Без **`
                            },
                            {
                                role: 'user',
                                content:
`Запрос:
${request.ingredients}

Условия:
${request.details}`
                            }
                        ],

                        max_tokens: 2500,
                        temperature: 0.9
                    });

                try {
                    await ctx.deleteMessage(
                        loading.message_id
                    );
                } catch (e) {}

                const recipe =
                    response.choices[0]
                        .message.content;

                await ctx.reply(recipe);

                // =========================
                // FREE LIMIT++
                // =========================

                if (!subscription) {

                    await incrementFreeRecipes(
                        tgId
                    );

                    const used =
                        freeUsed + 1;

                    const left =
                        FREE_LIMIT - used;

                    if (left > 0) {

                        await ctx.reply(
                            `🎁 Бесплатных рецептов осталось:
${left}`
                        );

                    } else {

                        await sendSubscriptionMenu(
                            ctx
                        );
                    }
                }

            } catch (err) {

                console.error(err);

                await ctx.reply(
                    '❌ Ошибка генерации рецепта'
                );
            }
        }
    });
};
