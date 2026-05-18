const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';

const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ Bot module loaded');

    // ===== БАЗА ИЗВЕСТНЫХ БЛЮД =====
    const knownDishes = [
        'паста карбонара', 'карбонара', 'спагетти карбонара',
        'борщ', 'красный борщ', 'украинский борщ',
        'пицца', 'пицца маргарита', 'пицца пепперони',
        'салат цезарь', 'цезарь',
        'пельмени', 'вареники',
        'блины', 'блинчики',
        'оливье', 'салат оливье',
        'гречка', 'гречневая каша',
        'плов', 'узбекский плов',
        'котлеты', 'мясные котлеты',
        'суп', 'куриный суп', 'гороховый суп',
        'омлет', 'яичница',
        'паста болоньезе', 'болоньезе', 'спагетти болоньезе',
        'лазанья',
        'суши', 'роллы',
        'бургер', 'гамбургер',
        'шашлык',
        'торт', 'медовик', 'наполеон',
        'печенье', 'пряники'
    ];

    // ===== ОПРЕДЕЛЕНИЕ ТИПА ЗАПРОСА =====
    function detectQueryType(text) {
        const lowerText = text.toLowerCase().trim();
        
        for (const dish of knownDishes) {
            if (lowerText.includes(dish)) {
                return { type: 'dish', dish: dish };
            }
        }
        
        if (lowerText.includes('рецепт') || 
            lowerText.includes('приготовить') ||             lowerText.includes('как сделать') ||
            lowerText.includes('как приготовить')) {
            
            const match = lowerText.match(/(?:рецепт|приготовить|сделать)\s+(.+)/i);
            if (match && match[1]) {
                return { type: 'dish', dish: match[1].trim() };
            }
        }
        
        return { type: 'ingredients', ingredients: text };
    }

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
    // ===== /start =====
    bot.start(async (ctx) => {
        if (ctx.from.id === ADMIN_ID) return;

        const tgId = ctx.from.id;
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const sub = await getSubscription(tgId);
        let msg = '👋 Привет! Я Домашний Шеф 🍳\n\n';
        msg += '🎯 Я могу:\n';
        msg += '1️⃣ Найти рецепт конкретного блюда (например: "паста карбонара")\n';
        msg += '2️⃣ Придумать рецепт из твоих продуктов (например: "яйца помидоры бекон")\n\n';
        msg += `🎁 ${FREE_LIMIT} бесплатных рецептов\n\n`;
        
        if (sub) {
            const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
            msg += `✅ PRO Подписка активна!\n`;
            msg += `📅 До: ${new Date(sub.expires_at).toLocaleDateString('ru-RU')}\n`;
            msg += `⏳ Осталось дней: ${daysLeft}`;
        } else {
            const freeUsed = await getFreeRecipesUsed(tgId);
            msg += `📊 Использовано: ${freeUsed} из ${FREE_LIMIT}`;
        }
        
        ctx.reply(msg);
    });

    // ===== ОБРАБОТКА ЗАПРОСОВ =====
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const tgId = ctx.from.id;
        
        if (text.startsWith('/')) return;
        
        if (tgId === ADMIN_ID) {
            return ctx.reply('🔒 Режим администратора\nИспользуйте кнопки меню.');
        }
        
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const hasSub = await hasActiveSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);
        
        // ===== ПРОВЕРКА ЛИМИТА С КНОПКОЙ ОПЛАТЫ =====
        if (!hasSub && freeUsed >= FREE_LIMIT) {
            return ctx.reply(
                `🔒 <b>Пробная версия завершена!</b>\n\n` +
                `Вы использовали все ${FREE_LIMIT} бесплатных рецепта.\n\n` +
                `📅 Подписка на месяц — <b>${SUB_PRICE}₽</b>\n` +
                `✅ Неограниченные рецепты`,                { 
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        Markup.button.callback('💳 Оформить подписку — 500₽', 'pay_subscribe')
                    ])
                }
            );
        }
        
        const query = detectQueryType(text);
        let loadingMsg, recipe, dishName;
        
        try {
            if (query.type === 'dish') {
                dishName = query.dish;
                loadingMsg = await ctx.reply(`🍽️ Ищу рецепт: ${dishName}...\n⏱ 1-2 минуты`);
                
                const response = await giga.chat({
                    model: 'GigaChat',
                    messages: [
                        { 
                            role: 'system', 
                            content: `Ты — профессиональный шеф-повар. Создаёшь ПОДРОБНЫЕ рецепты известных блюд.

СТРУКТУРА:

🍽️ НАЗВАНИЕ БЛЮДА (флаг страны) ✨

Эмоциональное описание (2-3 предложения) 💖

 ИНГРЕДИЕНТЫ:

🍜 ингредиент — количество (пояснение)
🥚 ингредиент — количество (пояснение)


👨‍ ШАГИ ПРИГОТОВЛЕНИЯ:

1️⃣ Название шага 🔪 (3-5 минут)
Описание этапа! 😋
- Подробное действие 📏
- Важные нюансы 💡

2️⃣ Название шага 🔥 (5-7 минут)
Почему это важно! 🤤
- Действие 1 ✨
- Действие 2 

(минимум 5-6 шагов с ТОЧНЫМ временем!)

🎯 СОВЕТЫ ШЕФА:
💡 Совет 1
💡 Совет 2
💡 Совет 3


📊 ПИЩЕВАЯ ЦЕННОСТЬ (на порцию):
🔥 Калории: ~X ккал
🥩 Белки: X г
🌾 Углеводы: X г
🧈 Жиры: X г

🍷 ИДЕАЛЬНАЯ ПАРА: напиток

⏱ ОБЩЕЕ ВРЕМЯ: X минут
📊 СЛОЖНОСТЬ: ⭐⭐☆☆☆
👥 ПОРЦИЙ: X персоны


ВАЖНО:
- НИКАКИХ ** (звёздочек)!
- ТОЧНОЕ время для каждого шага
- Много эмодзи
- Конкретные количества`
                        },
                        { 
                            role: 'user', 
                            content: `Дай классический рецепт: ${dishName}` 
                        }
                    ],
                    max_tokens: 2000,
                    temperature: 0.85
                });
                
                recipe = response.choices[0].message.content;
                
            } else {
                dishName = 'Блюдо из твоих продуктов';
                loadingMsg = await ctx.reply(`🛒 Создаю рецепт из: ${text}...\n✨ Магия начинается!`);
                
                const response = await giga.chat({
                    model: 'GigaChat',
                    messages: [
                        { 
                            role: 'system', 
                            content: `Ты — креативный шеф-повар. Создаёшь рецепты ТОЛЬКО из указанных продуктов.

ПРАВИЛА:
1. Используй ТОЛЬКО перечисленные продукты (можно базовые: соль, перец, масло)2. Не добавляй ингредиенты, которых нет в списке
3. Если продуктов мало — предложи простое блюдо

СТРУКТУРА:

🍽️ НАЗВАНИЕ БЛЮДА ✨

Описание (почему это вкусно!) 💖

🛒 ТВОИ ПРОДУКТЫ:

🍜 продукт 1 — количество
🥚 продукт 2 — количество


👨‍🍳 ПРИГОТОВЛЕНИЕ:

1️⃣ Название шага 🔪 (X минут)
- Что делаем 📏
- Детали 💡

2️⃣ Название шага 🔥 (X минут)
- Продолжаем ✨

(4-5 шагов с временем!)


🎯 СОВЕТЫ:
💡 Совет 1
💡 Совет 2


📊 ПИЩЕВАЯ ЦЕННОСТЬ:
🔥 Калории: ~X ккал

⏱ ВРЕМЯ: X минут
📊 СЛОЖНОСТЬ: ⭐⭐☆☆☆
👥 ПОРЦИЙ: X


ВАЖНО:
- ТОЛЬКО указанные продукты!
- Без звёздочек **
- Время для каждого шага`
                        },
                        { 
                            role: 'user', 
                            content: `Придумай рецепт из этих продуктов: ${text}. Используй только их (можно соль, перец, масло)!` 
                        }
                    ],                    max_tokens: 1800,
                    temperature: 0.9
                });
                
                recipe = response.choices[0].message.content;
            }
            
            try {
                await ctx.deleteMessage(loadingMsg.message_id);
            } catch (e) {}
            
            // Отправляем рецепт
            await ctx.reply(recipe);
            
            // Считаем рецепты
            if (!hasSub) {
                await incrementFreeRecipes(tgId);
                const left = FREE_LIMIT - (freeUsed + 1);
                if (left > 0) {
                    await ctx.reply(`🎁 Осталось бесплатных рецептов: ${left}`);
                }
            }
            
        } catch (e) {
            console.error('Error:', e);
            try {
                await ctx.deleteMessage(loadingMsg.message_id);
            } catch (err) {}
            ctx.reply('❌ Ошибка генерации рецепта\nПопробуйте позже.');
        }
    });

    // ===== КНОПКА ОПЛАТЫ =====
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        
        const paymentMsg = 
            `💳 <b>Оплата подписки — ${SUB_PRICE}₽ / месяц</b>\n\n` +
            `1️⃣ Переведите <b>${SUB_PRICE}₽</b> по СБП:\n` +
            `📱 Номер: <code>${SBP_PHONE}</code>\n` +
            `👤 Получатель: ${SBP_RECIPIENT}\n` +
            `🏦 Банки: 🟢 Сбер,  ВТБ, 🟡 Т-банк\n\n` +
            `2️⃣ После оплаты пришлите сюда <b>чек</b> (скриншот или PDF).\n\n` +
            `⏱ Подписка активируется в течение 5 минут после проверки.`;

        ctx.reply(paymentMsg, { parse_mode: 'HTML' });
    });

    // ===== ПРИЁМ ЧЕКОВ =====
    bot.on(['photo', 'document'], async (ctx) => {        const tgId = ctx.from.id;
        const user = await getUser(tgId);
        
        if (!user) {
            await createUser(tgId, ctx.from.username, ctx.from.first_name);
        }
        
        let fileId;
        if (ctx.message.photo) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        } else if (ctx.message.document) {
            if (!ctx.message.document.mime_type?.startsWith('image/') && 
                ctx.message.document.mime_type !== 'application/pdf') {
                return;
            }
            fileId = ctx.message.document.file_id;
        }
        
        if (!fileId) return;
        
        try {
            const { rows } = await pool.query(
                `INSERT INTO payments (user_id, amount, receipt_file_id) 
                 VALUES ($1, $2, $3) RETURNING id`,
                [tgId, SUB_PRICE, fileId]
            );
            
            const paymentId = rows[0].id;
            
            await ctx.reply(
                `✅ <b>Чек получен!</b>\n\n` +
                `📋 <b>Заявка #${paymentId}</b> принята в обработку\n` +
                `⏱ Активация в течение 5 минут`,
                { parse_mode: 'HTML' }
            );
            
            // Уведомление админу
            if (ADMIN_ID) {
                try {
                    const currentUser = await getUser(tgId);
                    const fileLink = await ctx.telegram.getFileLink(fileId);
                    
                    const adminMsg = 
                        `🔔 <b>Новая оплата!</b>\n\n` +
                        `📋 <b>Заявка #${paymentId}</b>\n\n` +
                        `👤 <b>Пользователь:</b> ${currentUser?.first_name || 'Unknown'} (@${currentUser?.username || 'нет'})\n` +
                        `🆔 <b>TG ID:</b> <code>${tgId}</code>\n` +
                        `💰 <b>Сумма:</b> ${SUB_PRICE}₽\n\n` +
                        `📎 <b>Чек:</b> <a href="${fileLink}">Открыть файл</a>\n\n` +
                        `<i>Нажмите кнопку для подтверждения</i>`;                    
                    await ctx.telegram.sendMessage(ADMIN_ID, adminMsg, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ Подтвердить', callback_data: `approve_${paymentId}` },
                                    { text: '❌ Отклонить', callback_data: `reject_${paymentId}` }
                                ]
                            ]
                        }
                    });
                    
                    console.log(`✅ Уведомление админу (чек #${paymentId})`);
                    
                } catch (notifyErr) {
                    console.error('Notify error:', notifyErr.message);
                }
            }
            
        } catch (err) {
            console.error('Check error:', err);
            ctx.reply('❌ Ошибка обработки чека.');
        }
    });

};
