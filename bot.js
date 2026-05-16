const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');
const axios = require('axios');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;

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
            lowerText.includes('приготовить') || 
            lowerText.includes('как сделать') ||            lowerText.includes('как приготовить')) {
            
            const match = lowerText.match(/(?:рецепт|приготовить|сделать)\s+(.+)/i);
            if (match && match[1]) {
                return { type: 'dish', dish: match[1].trim() };
            }
        }
        
        return { type: 'ingredients', ingredients: text };
    }

    // ===== ОЧИСТКА НАЗВАНИЯ =====
    function cleanDishName(name) {
        return name
            .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
            .replace(/[\u{2600}-\u{26FF}]/gu, '')
            .replace(/[\u{2700}-\u{27BF}]/gu, '')
            .replace(/[\*\_\`\[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ===== МНОГОУРОВНЕВЫЙ ПОИСК ФОТО =====
    async function findFoodPhoto(dishName, ingredients) {
        const cleanName = cleanDishName(dishName);
        console.log(`🔍 Ищем фото для: "${cleanName}"`);
        
        let photoUrl = null;
        
        // 1️⃣ Pexels API
        if (!photoUrl) {
            photoUrl = await searchPexels(cleanName);
        }
        
        // 2️⃣ Unsplash
        if (!photoUrl) {
            photoUrl = await searchUnsplash(cleanName);
        }
        
        // 3️⃣ Pinterest (если есть токен)
        if (!photoUrl && process.env.PINTEREST_ACCESS_TOKEN) {
            photoUrl = await searchPinterest(cleanName);
        }
        
        // 4️⃣ Fallback база
        if (!photoUrl) {
            photoUrl = getFallbackPhoto(cleanName);
        }
        
        return photoUrl;    }

    // ===== 1. PEXELS =====
    async function searchPexels(query) {
        try {
            const PEXELS_KEY = process.env.PEXELS_API_KEY;
            if (!PEXELS_KEY) return null;
            
            const searchTerms = [
                query + ' food dish',
                query + ' recipe',
                query + ' cooking',
                'delicious ' + query
            ];
            
            for (const term of searchTerms) {
                const res = await axios.get(
                    `https://api.pexels.com/v1/search?query=${encodeURIComponent(term)}&per_page=3`,
                    { 
                        headers: { 'Authorization': PEXELS_KEY },
                        timeout: 3000
                    }
                );
                
                if (res.data.photos && res.data.photos.length > 0) {
                    const randomPhoto = res.data.photos[Math.floor(Math.random() * res.data.photos.length)];
                    console.log(`✅ Pexels нашёл: ${randomPhoto.src.large}`);
                    return randomPhoto.src.large;
                }
            }
            
            return null;
        } catch (err) {
            console.log('❌ Pexels не нашёл');
            return null;
        }
    }

    // ===== 2. UNSPLASH =====
    async function searchUnsplash(query) {
        try {
            const searchTerms = [
                query + '+food',
                query + '+dish',
                query + '+recipe'
            ];
            
            for (const term of searchTerms) {
                const imageUrl = `https://source.unsplash.com/600x400/?${term}`;
                const res = await axios.head(imageUrl, { timeout: 3000 });                if (res.status === 200) {
                    console.log(`✅ Unsplash нашёл: ${imageUrl}`);
                    return imageUrl;
                }
            }
            
            return null;
        } catch (err) {
            console.log('❌ Unsplash не нашёл');
            return null;
        }
    }

    // ===== 3. PINTEREST =====
    async function searchPinterest(query) {
        try {
            const PINTEREST_TOKEN = process.env.PINTEREST_ACCESS_TOKEN;
            if (!PINTEREST_TOKEN) return null;
            
            const res = await axios.get(
                `https://api.pinterest.com/v5/pins?query=${encodeURIComponent(query + ' food')}&per_page=3`,
                { 
                    headers: { 'Authorization': `Bearer ${PINTEREST_TOKEN}` },
                    timeout: 5000
                }
            );
            
            if (res.data.items && res.data.items.length > 0) {
                const imageUrl = res.data.items[0].media?.images?.['600x']?.url;
                if (imageUrl) {
                    console.log(`✅ Pinterest нашёл: ${imageUrl}`);
                    return imageUrl;
                }
            }
            
            return null;
        } catch (err) {
            console.log('❌ Pinterest не нашёл');
            return null;
        }
    }

    // ===== 4. FALLBACK БАЗА =====
    function getFallbackPhoto(dishName) {
        const cleanName = cleanDishName(dishName).toLowerCase();
        
        const fallbackImages = {
            'паста': 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg?auto=compress&cs=tinysrgb&w=600',
            'спагетти': 'https://images.pexels.com/photos/2069355/pexels-photo-2069355.jpeg?auto=compress&cs=tinysrgb&w=600',
            'карбонара': 'https://images.pexels.com/photos/1633571/pexels-photo-1633571.jpeg?auto=compress&cs=tinysrgb&w=600',            'болоньезе': 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg?auto=compress&cs=tinysrgb&w=600',
            'лазанья': 'https://images.pexels.com/photos/2456514/pexels-photo-2456514.jpeg?auto=compress&cs=tinysrgb&w=600',
            'пицца': 'https://images.pexels.com/photos/846175/pexels-photo-846175.jpeg?auto=compress&cs=tinysrgb&w=600',
            'борщ': 'https://images.pexels.com/photos/539451/pexels-photo-539451.jpeg?auto=compress&cs=tinysrgb&w=600',
            'пельмени': 'https://images.pexels.com/photos/3577503/pexels-photo-3577503.jpeg?auto=compress&cs=tinysrgb&w=600',
            'блины': 'https://images.pexels.com/photos/2211435/pexels-photo-2211435.jpeg?auto=compress&cs=tinysrgb&w=600',
            'куриц': 'https://images.pexels.com/photos/2871757/pexels-photo-2871757.jpeg?auto=compress&cs=tinysrgb&w=600',
            'мяс': 'https://images.pexels.com/photos/1600412/pexels-photo-1600412.jpeg?auto=compress&cs=tinysrgb&w=600',
            'говядин': 'https://images.pexels.com/photos/1600412/pexels-photo-1600412.jpeg?auto=compress&cs=tinysrgb&w=600',
            'рыб': 'https://images.pexels.com/photos/1267320/pexels-photo-1267320.jpeg?auto=compress&cs=tinysrgb&w=600',
            'салат': 'https://images.pexels.com/photos/1640772/pexels-photo-1640772.jpeg?auto=compress&cs=tinysrgb&w=600',
            'овощ': 'https://images.pexels.com/photos/1640772/pexels-photo-1640772.jpeg?auto=compress&cs=tinysrgb&w=600',
            'суп': 'https://images.pexels.com/photos/539451/pexels-photo-539451.jpeg?auto=compress&cs=tinysrgb&w=600',
            'яиц': 'https://images.pexels.com/photos/162710/pexels-photo-162710.jpeg?auto=compress&cs=tinysrgb&w=600',
            'омлет': 'https://images.pexels.com/photos/162710/pexels-photo-162710.jpeg?auto=compress&cs=tinysrgb&w=600',
            'рис': 'https://images.pexels.com/photos/1134215/pexels-photo-1134215.jpeg?auto=compress&cs=tinysrgb&w=600',
            'гречк': 'https://images.pexels.com/photos/1134215/pexels-photo-1134215.jpeg?auto=compress&cs=tinysrgb&w=600',
            'картофел': 'https://images.pexels.com/photos/5409015/pexels-photo-5409015.jpeg?auto=compress&cs=tinysrgb&w=600',
            'торт': 'https://images.pexels.com/photos/1920173/pexels-photo-1920173.jpeg?auto=compress&cs=tinysrgb&w=600',
            'десерт': 'https://images.pexels.com/photos/1558616/pexels-photo-1558616.jpeg?auto=compress&cs=tinysrgb&w=600',
            'бургер': 'https://images.pexels.com/photos/1633571/pexels-photo-1633571.jpeg?auto=compress&cs=tinysrgb&w=600',
            'суши': 'https://images.pexels.com/photos/3577503/pexels-photo-3577503.jpeg?auto=compress&cs=tinysrgb&w=600',
            'default': 'https://images.pexels.com/photos/33242/cooking-food-ingredient-kitchen.jpg?auto=compress&cs=tinysrgb&w=600'
        };
        
        for (const [key, url] of Object.entries(fallbackImages)) {
            if (cleanName.includes(key)) {
                console.log(`📎 Fallback для: ${key}`);
                return url;
            }
        }
        
        console.log('📎 Используем дефолтное фото');
        return fallbackImages['default'];
    }

    // ===== ОТПРАВКА ФОТО =====
    async function sendPhotoWithRetry(ctx, photoUrl, caption, maxRetries = 2) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await ctx.replyWithPhoto(photoUrl, { caption, parse_mode: 'HTML' });
                return true;
            } catch (err) {
                if (i === maxRetries - 1) return false;
                await new Promise(resolve => setTimeout(resolve, 1000));
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
        let msg = '👋 Привет! Я Домашний Шеф 🍳\n\n';
        msg += '🎯 Я могу:\n';
        msg += '1️⃣ Найти рецепт конкретного блюда (например: "паста карбонара")\n';
        msg += '2️⃣ Придумать рецепт из твоих продуктов (например: "яйца помидоры бекон")\n\n';        msg += `🎁 ${FREE_LIMIT} бесплатных рецептов\n`;
        msg += `📸 Каждый рецепт с фото!\n\n`;
        
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
        
        if (!hasSub && freeUsed >= FREE_LIMIT) {
            return ctx.reply(
                `🔒 Лимит исчерпан!\n\n` +
                `Вы использовали все ${FREE_LIMIT} бесплатных рецепта.\n\n` +
                `🌟 PRO Подписка — ${SUB_PRICE}₽/месяц`,
                { 
                    reply_markup: Markup.inlineKeyboard([
                        Markup.button.callback('💳 Оформить подписку', 'pay_subscribe')
                    ])
                }
            );
        }
        
        const query = detectQueryType(text);
        let loadingMsg, recipe, dishName;
        
        try {
            if (query.type === 'dish') {                dishName = query.dish;
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
1. Используй ТОЛЬКО перечисленные продукты (можно базовые: соль, перец, масло)
2. Не добавляй ингредиенты, которых нет в списке
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
                    ],
                    max_tokens: 1800,
                    temperature: 0.9
                });
                
                recipe = response.choices[0].message.content;
            }
            
            try {
                await ctx.deleteMessage(loadingMsg.message_id);
            } catch (e) {}
            
            await ctx.reply(recipe);
            
            // Ищем фото с 4 уровнями поиска!            const photoMsg = await ctx.reply('📸 Подбираю фото...');
            
            const photoUrl = await findFoodPhoto(dishName, text);
            
            try {
                await ctx.deleteMessage(photoMsg.message_id);
            } catch (e) {}
            
            const caption = `📸 ${dishName}\nПриятного аппетита! 😋`;
            const sent = await sendPhotoWithRetry(ctx, photoUrl, caption);
            
            if (!sent) {
                await ctx.reply('📸 Фото не загрузилось, но рецепт отличный! 😊');
            }
            
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

    // ===== ОПЛАТА =====
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        
        const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
        const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
        
        const paymentMsg = 
            `💳 Оплата PRO подписки — ${SUB_PRICE}₽/месяц\n\n` +
            `1️⃣ Переведите ${SUB_PRICE}₽ по СБП:\n` +
            `📱 Номер: ${SBP_PHONE}\n` +
            `👤 Получатель: ${SBP_RECIPIENT}\n\n` +
            `2️⃣ Пришлите чек сюда\n\n` +
            `⏱ Активация в течение 5 минут.`;

        ctx.reply(paymentMsg);
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
                `✅ Чек получен!\n\n` +
                `📋 Заявка #${paymentId}\n` +
                `⏱ Активация в течение 5 минут`
            );
            
            if (ADMIN_ID) {
                try {
                    const currentUser = await getUser(tgId);
                    const fileLink = await ctx.telegram.getFileLink(fileId);
                    
                    const adminMsg = 
                        `🔔 Новая оплата!\n\n` +
                        `📋 Заявка #${paymentId}\n\n` +
                        `👤 ${currentUser?.first_name || 'Unknown'} (@${currentUser?.username || 'нет'})\n` +
                        `💰 ${SUB_PRICE}₽\n\n` +
                        `📎 Чек: ${fileLink}`;
                    
                    await ctx.telegram.sendMessage(ADMIN_ID, adminMsg, {                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ Подтвердить', callback_data: `approve_${paymentId}` },
                                    { text: '❌ Отклонить', callback_data: `reject_${paymentId}` }
                                ]
                            ]
                        }
                    });
                    
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
