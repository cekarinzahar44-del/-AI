const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');
const axios = require('axios');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;

const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ Bot module loaded');

    // ===== ОЧИСТКА НАЗВАНИЯ =====
    function cleanDishName(name) {
        return name
            .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
            .replace(/[\u{2600}-\u{26FF}]/gu, '')
            .replace(/[\u{2700}-\u{27BF}]/gu, '')
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
            .replace(/[\*\_\`\[\]]/g, '')
            .replace(/[✨⭐🍽️🍳🥘🍲🧄🌶️🫒🍅🍚✅⚠️️📊🔍📸]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ===== ПОИСК ФОТО =====
    async function searchFoodPhoto(dishName) {
        try {
            const PEXELS_KEY = process.env.PEXELS_API_KEY;
            
            if (!PEXELS_KEY || PEXELS_KEY === 'your_pexels_api_key_here') {
                return null;
            }
            
            const cleanName = cleanDishName(dishName);
            console.log(`🔍 Searching: "${cleanName}"`);
            
            if (!cleanName || cleanName.length < 3) return null;
            
            const res = await axios.get(
                `https://api.pexels.com/v1/search?query=${encodeURIComponent(cleanName + ' food dish')}&per_page=1`,
                { 
                    headers: { 'Authorization': PEXELS_KEY, 'User-Agent': 'HomeChefBot/1.0' },
                    timeout: 5000
                }
            );            
            if (res.data.photos && res.data.photos.length > 0) {
                return res.data.photos[0].src.large;
            }
            
            return null;
        } catch (err) {
            console.error('Pexels error:', err.message);
            return null;
        }
    }

    // ===== ЗАПАСНЫЕ ФОТО =====
    function getFallbackPhoto(dishName) {
        const cleanName = cleanDishName(dishName).toLowerCase();
        
        const fallbackImages = {
            'паста': 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg?auto=compress&cs=tinysrgb&w=600',
            'спагетти': 'https://images.pexels.com/photos/2069355/pexels-photo-2069355.jpeg?auto=compress&cs=tinysrgb&w=600',
            'карбонара': 'https://images.pexels.com/photos/1633571/pexels-photo-1633571.jpeg?auto=compress&cs=tinysrgb&w=600',
            'болоньеза': 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg?auto=compress&cs=tinysrgb&w=600',
            'куриц': 'https://images.pexels.com/photos/2871757/pexels-photo-2871757.jpeg?auto=compress&cs=tinysrgb&w=600',
            'мяс': 'https://images.pexels.com/photos/1600412/pexels-photo-1600412.jpeg?auto=compress&cs=tinysrgb&w=600',
            'рыб': 'https://images.pexels.com/photos/1267320/pexels-photo-1267320.jpeg?auto=compress&cs=tinysrgb&w=600',
            'суп': 'https://images.pexels.com/photos/539451/pexels-photo-539451.jpeg?auto=compress&cs=tinysrgb&w=600',
            'салат': 'https://images.pexels.com/photos/1640772/pexels-photo-1640772.jpeg?auto=compress&cs=tinysrgb&w=600',
            'пицц': 'https://images.pexels.com/photos/846175/pexels-photo-846175.jpeg?auto=compress&cs=tinysrgb&w=600',
            'десерт': 'https://images.pexels.com/photos/1558616/pexels-photo-1558616.jpeg?auto=compress&cs=tinysrgb&w=600',
            'торт': 'https://images.pexels.com/photos/1920173/pexels-photo-1920173.jpeg?auto=compress&cs=tinysrgb&w=600',
            'яиц': 'https://images.pexels.com/photos/162710/pexels-photo-162710.jpeg?auto=compress&cs=tinysrgb&w=600',
            'рис': 'https://images.pexels.com/photos/1134215/pexels-photo-1134215.jpeg?auto=compress&cs=tinysrgb&w=600',
            'овощ': 'https://images.pexels.com/photos/1640772/pexels-photo-1640772.jpeg?auto=compress&cs=tinysrgb&w=600'
        };
        
        for (const [key, url] of Object.entries(fallbackImages)) {
            if (cleanName.includes(key)) return url;
        }
        
        return 'https://images.pexels.com/photos/33242/cooking-food-ingredient-kitchen.jpg?auto=compress&cs=tinysrgb&w=600';
    }

    // ===== ОТПРАВКА ФОТО =====
    async function sendPhotoWithRetry(ctx, photoUrl, caption, maxRetries = 2) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await ctx.replyWithPhoto(photoUrl, { caption, parse_mode: 'HTML' });
                return true;
            } catch (err) {
                console.error(`Photo attempt ${i + 1} failed:`, err.message);
                if (i === maxRetries - 1) return false;                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return false;
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

    // ===== ЗАПРОС РЕЦЕПТА С ИДЕАЛЬНЫМ ОФОРМЛЕНИЕМ =====
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
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
                `✅ Неограниченные рецепты\n📸 Красивые фото блюд`,
                { 
                    parse_mode: 'HTML', 
                    reply_markup: Markup.inlineKeyboard([
                        Markup.button.callback('💳 Оформить подписку', 'pay_subscribe')
                    ])
                }            );
        }
        
        const loadingMsg = await ctx.reply('👨‍🍳 <b>Создаю рецепт...</b>\n✨ Подбираю идеальное сочетание', { parse_mode: 'HTML' });
        
        try {
            // ===== УЛУЧШЕННЫЙ ПРОМПТ =====
            const response = await giga.chat({
                model: 'GigaChat',
                messages: [
                    { 
                        role: 'system', 
                        content: `Ты — профессиональный шеф-повар и кулинарный блогер с талантом создавать аппетитные описания!

Твоя задача — создать ПОДРОБНЫЙ, ЭМОЦИОНАЛЬНЫЙ и КРАСИВО ОФОРМЛЕННЫЙ рецепт.

СТРОГАЯ СТРУКТУРА:

🍽️ НАЗВАНИЕ БЛЮДА (с флагом страны) ✨

Эмоциональное описание блюда (2-3 предложения, чтобы слюнки текли!) 💖

                  ИНГРЕДИЕНТЫ:

🍜 ингредиент 1 — количество (дополнительная информация)
🥚 ингредиент 2 — количество (дополнительная информация)
🧀 ингредиент 3 — количество (дополнительная информация)
(и так далее, каждый с эмодзи)


👨‍🍳 ШАГИ ПРИГОТОВЛЕНИЯ:

1️⃣ Название шага 🔪
Эмоциональное описание этапа! 😋
- Подробное действие 1 📏
- Подробное действие 2 🥚
- Важные детали 💡

2️⃣ Название шага 🔥
Описание почему это важно! 🤤
- Действие с деталями ✨
- На что обратить внимание ⚠️

3️⃣ Название шага 🍜
Продолжай в том же духе...
(минимум 4-6 шагов)


🎯 СОВЕТЫ ШЕФА:
💡 Полезный совет 1💡 Полезный совет 2
💡 Полезный совет 3
💡 Полезный совет 4


ПИЩЕВАЯ ЦЕННОСТЬ (на порцию):
🔥 Калории: ~X ккал
🥩 Белки: X г
🌾 Углеводы: X г
🧈 Жиры: X г

🍷 ИДЕАЛЬНАЯ ПАРА: описание напитка

⏱ ОБЩЕЕ ВРЕМЯ: X минут
📊 СЛОЖНОСТЬ: ⭐⭐☆☆☆ (Легко/Средняя/Сложная)
👥 ПОРЦИЙ: X персоны


ПРАВИЛА:
1. Используй МНОГО эмодзи в каждом разделе
2. Делай описания эмоциональными и аппетитными
3. Давай конкретные количества (граммы, штуки, ложки)
4. Добавляй пояснения в скобках
5. Каждый шаг должен иметь название и подзаголовок
6. Используй маркеры (-) для деталей в шагах
7. Пиши живым, вдохновляющим языком
8. Добавляй важные предупреждения ⚠️
9. В советах давай реальные профессиональные хитрости
10. Указывай точное время и калории`
                    },
                    { 
                        role: 'user', 
                        content: `Создай ШИКАРНЫЙ рецепт из этих продуктов: ${text}

Оформи его ПОДРОБНО и КРАСИВО как описано выше! Сделай так, чтобы сразу захотелось готовить! 🔥` 
                    }
                ],
                max_tokens: 2000,
                temperature: 0.9
            });
            
            let recipe = response.choices[0].message.content;
            
            // Извлекаем название
            let dishName = 'Блюдо';
            const nameMatch = recipe.match(/🍽️\s*([^\n]+)/);
            if (nameMatch && nameMatch[1]) {
                dishName = cleanDishName(nameMatch[1]);
            }
                        try {
                await ctx.deleteMessage(loadingMsg.message_id);
            } catch (e) {}
            
            // Отправляем рецепт
            await ctx.reply(recipe, { parse_mode: 'HTML' });
            
            // Ищем фото
            const photoMsg = await ctx.reply('📸 <b>Подбираю фото блюда...</b>', { parse_mode: 'HTML' });
            
            let photoUrl = await searchFoodPhoto(dishName);
            if (!photoUrl) photoUrl = await searchFoodPhoto(text);
            if (!photoUrl) photoUrl = getFallbackPhoto(dishName);
            
            try {
                await ctx.deleteMessage(photoMsg.message_id);
            } catch (e) {}
            
            const caption = `📸 <b>${dishName}</b>\nПриятного аппетита! 😋`;
            const sent = await sendPhotoWithRetry(ctx, photoUrl, caption);
            
            if (!sent) {
                await ctx.reply('📸 Фото не загрузилось, но рецепт отличный! 😊');
            }
            
            // Считаем рецепты
            if (!hasSub) {
                await incrementFreeRecipes(tgId);
                const left = FREE_LIMIT - (freeUsed + 1);
                if (left > 0) {
                    await ctx.reply(`🎁 Осталось бесплатных рецептов: <b>${left}</b>`, { parse_mode: 'HTML' });
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

    // ===== ОПЛАТА =====
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        
        const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
        const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
                const paymentMsg = 
            `💳 <b>Оплата PRO подписки — ${SUB_PRICE}₽/месяц</b>\n\n` +
            `1️⃣ Переведите <b>${SUB_PRICE}₽</b> по СБП:\n` +
            `📱 Номер: <code>${SBP_PHONE}</code>\n` +
            `👤 Получатель: ${SBP_RECIPIENT}\n\n` +
            `2️⃣ Пришлите <b>чек</b> сюда\n\n` +
            `⏱ Активация в течение 5 минут.`;

        ctx.reply(paymentMsg, { parse_mode: 'HTML' });
    });

    // ===== ЧЕКИ =====
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
                `INSERT INTO payments (user_id, amount, receipt_file_id) 
                 VALUES ($1, $2, $3) RETURNING id`,
                [tgId, SUB_PRICE, fileId]
            );
            
            const paymentId = rows[0].id;
            
            await ctx.reply(
                `✅ <b>Чек получен!</b>\n\n` +
                `📋 Заявка #${paymentId}\n` +
                `⏱ Активация в течение 5 минут`,
                { parse_mode: 'HTML' }
            );
            
            if (ADMIN_ID) {                try {
                    const currentUser = await getUser(tgId);
                    const fileLink = await ctx.telegram.getFileLink(fileId);
                    
                    const adminMsg = 
                        `🔔 <b>Новая оплата!</b>\n\n` +
                        `📋 Заявка #${paymentId}\n\n` +
                        `👤 ${currentUser?.first_name || 'Unknown'} (@${currentUser?.username || 'нет'})\n` +
                        `💰 ${SUB_PRICE}₽\n\n` +
                        `📎 <a href="${fileLink}">Открыть чек</a>`;
                    
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
