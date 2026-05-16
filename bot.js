const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');
const axios = require('axios');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;

const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ Bot module loaded');

    // ===== ПОИСК ФОТО ПО НАЗВАНИЮ БЛЮДА =====
    async function searchFoodPhoto(dishName) {
        try {
            const PEXELS_KEY = process.env.PEXELS_API_KEY;
            
            if (!PEXELS_KEY) {
                console.log('⚠️ PEXELS_API_KEY not set');
                return null;
            }
            
            // Очищаем название от лишних символов
            const cleanDishName = dishName
                .replace(/[🍽️🍳🥘🍝🍲🥞🧀🥓🧄🌶️🫒🍅🥕🥔🍚🍜✨✅⚠️️📊]/g, '')
                .replace(/[\*\_]/g, '')
                .trim();
            
            console.log(`🔍 Searching photo for: "${cleanDishName}"`);
            
            // Запрос к Pexels API
            const res = await axios.get(
                `https://api.pexels.com/v1/search?query=${encodeURIComponent(cleanDishName + ' dish food')}&per_page=3`,
                { 
                    headers: { 'Authorization': PEXELS_KEY },
                    timeout: 5000
                }
            );
            
            if (res.data.photos && res.data.photos.length > 0) {
                // Выбираем случайное фото из первых 3
                const randomPhoto = res.data.photos[Math.floor(Math.random() * res.data.photos.length)];
                return randomPhoto.src.large;
            }
            
            return null;
            
        } catch (err) {            console.error('Photo search error:', err.message);
            return null;
        }
    }

    // ===== ЗАПАСНЫЕ ФОТО (если Pexels не нашёл) =====
    function getFallbackPhoto(dishName) {
        const fallbackImages = {
            'паста': 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg',
            'спагетти': 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg',
            'карбонара': 'https://images.pexels.com/photos/1633571/pexels-photo-1633571.jpeg',
            'куриц': 'https://images.pexels.com/photos/2871757/pexels-photo-2871757.jpeg',
            'мяс': 'https://images.pexels.com/photos/1600412/pexels-photo-1600412.jpeg',
            'рыб': 'https://images.pexels.com/photos/1267320/pexels-photo-1267320.jpeg',
            'суп': 'https://images.pexels.com/photos/539451/pexels-photo-539451.jpeg',
            'салат': 'https://images.pexels.com/photos/1640772/pexels-photo-1640772.jpeg',
            'пицц': 'https://images.pexels.com/photos/846175/pexels-photo-846175.jpeg',
            'десерт': 'https://images.pexels.com/photos/1558616/pexels-photo-1558616.jpeg',
            'торт': 'https://images.pexels.com/photos/1920173/pexels-photo-1920173.jpeg'
        };
        
        const lowerName = dishName.toLowerCase();
        for (const [key, url] of Object.entries(fallbackImages)) {
            if (lowerName.includes(key)) {
                return url;
            }
        }
        
        // Дефолтное фото еды
        return 'https://images.pexels.com/photos/33242/cooking-food-ingredient-kitchen.jpg';
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
        );        return rows.length > 0;
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

    // ===== /start ДЛЯ ПОЛЬЗОВАТЕЛЯ =====
    bot.start(async (ctx) => {
        if (ctx.from.id === ADMIN_ID) return;

        const tgId = ctx.from.id;
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const sub = await getSubscription(tgId);
        let msg = '👋 <b>Привет! Я Домашний Шеф</b> 🍳\n\n';
        msg += '🎯 <b>Напиши продукты</b>, которые есть дома,\n';
        msg += 'и я создам для тебя <b>шикарный рецепт</b>! 😋\n\n';
        msg += `🎁 <b>${FREE_LIMIT} бесплатных рецепта</b>\n`;
        msg += `📸 Каждый рецепт с красивым фото!\n\n`;
        
        if (sub) {
            const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
            msg += `✅ <b>PRO Подписка активна!</b>\n`;
            msg += `📅 До: ${new Date(sub.expires_at).toLocaleDateString('ru-RU')}\n`;
            msg += `⏳ Осталось дней: <b>${daysLeft}</b>\n`;
            msg += `🌟 <b>Неограниченные рецепты!</b>`;
        } else {
            const freeUsed = await getFreeRecipesUsed(tgId);
            msg += `📊 Использовано: <b>${freeUsed} из ${FREE_LIMIT}</b>`;
        }
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    // ===== ЗАПРОС РЕЦЕПТА С ФОТО =====
    bot.on('text', async (ctx) => {        const text = ctx.message.text.trim();
        const tgId = ctx.from.id;
        
        if (text.startsWith('/')) return;
        
        if (tgId === ADMIN_ID) {
            return ctx.reply('🔒 <b>Режим администратора</b>\nИспользуйте кнопки меню.', { parse_mode: 'HTML' });
        }
        
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const hasSub = await hasActiveSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);
        
        if (!hasSub && freeUsed >= FREE_LIMIT) {
            return ctx.reply(
                `🔒 <b>Лимит исчерпан!</b>\n\n` +
                `Вы использовали все ${FREE_LIMIT} бесплатных рецепта.\n\n` +
                `🌟 <b>PRO Подписка — ${SUB_PRICE}₽/месяц</b>\n` +
                `✅ Неограниченные рецепты\n` +
                `📸 Красивые фото блюд\n` +
                `💡 Советы шеф-повара`,
                { 
                    parse_mode: 'HTML', 
                    reply_markup: Markup.inlineKeyboard([
                        Markup.button.callback('💳 Оформить подписку', 'pay_subscribe')
                    ])
                }
            );
        }
        
        // Показываем, что работаем
        const loadingMsg = await ctx.reply('👨‍🍳 <b>Создаю рецепт...</b>\n🔍 Подбираю идеальное сочетание', { parse_mode: 'HTML' });
        
        try {
            // Генерируем рецепт
            const response = await giga.chat({
                model: 'GigaChat',
                messages: [
                    { 
                        role: 'system', 
                        content: `Ты профессиональный шеф-повар и кулинарный блогер. 
Создавай рецепты в КРАСИВОМ формате с эмодзи.

СТРУКТУРА:
🍽️ <НАЗВАНИЕ БЛЮДА> <флаг страны>
✨ <описание>

🛒 <b>ИНГРЕДИЕНТЫ:</b>
✅ <ингредиент> — <количество>
👨‍🍳 <b>ПРИГОТОВЛЕНИЕ:</b>
1️⃣ <шаг>

💡 <b>СОВЕТЫ ШЕФА:</b>
⚠️ <совет>

⏱️ <b>Время:</b> X минут
📊 <b>Сложность:</b> Легко/Средне/Сложно
🔥 <b>Калории:</b> ~X ккал`
                    },
                    { 
                        role: 'user', 
                        content: `Создай рецепт из: ${text}. Оформи красиво!` 
                    }
                ],
                max_tokens: 1500,
                temperature: 0.8
            });
            
            let recipe = response.choices[0].message.content;
            
            // Извлекаем название блюда (первая строка после эмодзи тарелки)
            let dishName = '';
            const nameMatch = recipe.match(/🍽️\s*([^\n]+)/);
            if (nameMatch && nameMatch[1]) {
                dishName = nameMatch[1].trim();
                console.log(`📝 Dish name: ${dishName}`);
            } else {
                // Если не нашли, используем первые слова
                dishName = recipe.split('\n')[0].replace(/[🍽️✨]/g, '').trim();
            }
            
            // Удаляем сообщение "создаю рецепт"
            try {
                await ctx.deleteMessage(loadingMsg.message_id);
            } catch (e) {}
            
            // Отправляем рецепт
            await ctx.reply(recipe, { parse_mode: 'HTML' });
            
            // Ищем и отправляем фото ПО НАЗВАНИЮ БЛЮДА
            const loadingPhotoMsg = await ctx.reply('📸 <b>Подбираю фото блюда...</b>', { parse_mode: 'HTML' });
            
            let photoUrl = await searchFoodPhoto(dishName);
            
            if (!photoUrl) {
                // Пробуем по ингредиентам
                photoUrl = await searchFoodPhoto(text);
            }            
            if (!photoUrl) {
                // Запасной вариант
                photoUrl = getFallbackPhoto(dishName || text);
            }
            
            try {
                await ctx.deleteMessage(loadingPhotoMsg.message_id);
            } catch (e) {}
            
            await ctx.replyWithPhoto(photoUrl, {
                caption: `📸 <b>${dishName || 'Ваше блюдо'}</b>\nПриятного аппетита! 😋`,
                parse_mode: 'HTML'
            });
            
            // Считаем бесплатные рецепты
            if (!hasSub) {
                await incrementFreeRecipes(tgId);
                const left = FREE_LIMIT - (freeUsed + 1);
                if (left > 0) {
                    await ctx.reply(
                        `🎁 <b>Осталось бесплатных рецептов: ${left}</b>`,
                        { parse_mode: 'HTML' }
                    );
                }
            }
            
        } catch (e) {
            console.error('GigaChat error:', e);
            try {
                await ctx.deleteMessage(loadingMsg.message_id);
            } catch (err) {}
            ctx.reply('❌ <b>Ошибка генерации рецепта</b>\nПопробуйте позже.', { parse_mode: 'HTML' });
        }
    });

    // ===== КНОПКА ОПЛАТЫ =====
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        
        const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
        const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
        
        const paymentMsg = 
            `💳 <b>Оплата PRO подписки — ${SUB_PRICE}₽/месяц</b>\n\n` +
            `🌟 <b>Что вы получаете:</b>\n` +
            `✅ Неограниченные рецепты\n` +
            `📸 Красивые фото блюд\n` +
            `💡 Советы шеф-повара\n` +
            `⚡ Приоритетная поддержка\n\n` +            `1️⃣ <b>Переведите ${SUB_PRICE}₽ по СБП:</b>\n` +
            `📱 Номер: <code>${SBP_PHONE}</code>\n` +
            `👤 Получатель: ${SBP_RECIPIENT}\n` +
            `🏦 Банки: 🟢 Сбер,  ВТБ, 🟡 Т-банк\n\n` +
            `2️⃣ <b>После оплаты пришлите чек</b> (скриншот или PDF)\n\n` +
            `⏱ Подписка активируется в течение 5 минут.`;

        ctx.reply(paymentMsg, { parse_mode: 'HTML' });
    });

    // ===== ПРИЁМ ЧЕКОВ =====
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id;
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
                `INSERT INTO payments (user_id, amount, receipt_file_id, receipt_caption) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [tgId, SUB_PRICE, fileId, ctx.message.caption || '']
            );
            
            const paymentId = rows[0].id;
            
            await ctx.reply(
                `✅ <b>Чек получен!</b>\n\n` +
                `📋 <b>Заявка #${paymentId}</b> принята\n` +
                `⏱ Активация в течение 5 минут`,
                { parse_mode: 'HTML' }
            );
            
            if (ADMIN_ID) {
                try {                    const currentUser = await getUser(tgId);
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
                    console.error('❌ Ошибка уведомления:', notifyErr.message);
                }
            }
            
        } catch (err) {
            console.error('❌ Ошибка чека:', err);
            ctx.reply('❌ Ошибка обработки чека.');
        }
    });

};
