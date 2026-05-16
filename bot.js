const { Markup } = require('telegraf');
const { GigaChat } = require('gigachat');

const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;
const SUB_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE) || 500;
const FREE_LIMIT = 3;

const giga = new GigaChat({ credentials: GIGA_CREDENTIALS, scope: 'GIGACHAT_API_PERS' });

module.exports = (bot, pool, ADMIN_ID) => {

    console.log('✅ Bot module loaded');

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
    // ===== /start ДЛЯ ПОЛЬЗОВАТЕЛЯ =====
    bot.start(async (ctx) => {
        // Если это админ, пропускаем (admin.js уже обработал)
        if (ctx.from.id === ADMIN_ID) return;

        const tgId = ctx.from.id;
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const sub = await getSubscription(tgId);
        let msg = '👋 Привет! Я <b>Домашний Шеф</b> 🍳\n\n';
        msg += 'Напиши продукты, которые есть дома, и я придумаю рецепт!\n';
        msg += `🎁 У тебя <b>${FREE_LIMIT} бесплатных рецепта</b>.\n\n`;
        
        if (sub) {
            const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000);
            msg += `✅ <b>Подписка активна!</b>\n`;
            msg += `📅 До: ${new Date(sub.expires_at).toLocaleDateString('ru-RU')}\n`;
            msg += `⏳ Осталось дней: <b>${daysLeft}</b>`;
        } else {
            const freeUsed = await getFreeRecipesUsed(tgId);
            msg += `📊 Использовано: <b>${freeUsed} из ${FREE_LIMIT}</b>`;
        }
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    // ===== ЗАПРОС РЕЦЕПТА =====
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const tgId = ctx.from.id;
        
        if (text.startsWith('/')) return;
        
        // Админ не генерирует рецепты текстом
        if (tgId === ADMIN_ID) {
            return ctx.reply('🔒 Вы в режиме администратора.\nИспользуйте кнопки меню.');
        }
        
        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        
        const hasSub = await hasActiveSubscription(tgId);
        const freeUsed = await getFreeRecipesUsed(tgId);
        
        if (!hasSub && freeUsed >= FREE_LIMIT) {
            return ctx.reply(
                `🔒 <b>Пробная версия завершена!</b>\n\n` +
                `Вы использовали все ${FREE_LIMIT} бесплатных рецепта.\n\n` +
                `📅 Подписка на месяц — <b>${SUB_PRICE}₽</b>\n` +
                `✅ Неограниченные рецепты`,                { 
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
                messages: [
                    { role: 'system', content: 'Ты профессиональный повар. Дай подробный рецепт из указанных продуктов. Укажи ингредиенты и шаги приготовления.' },
                    { role: 'user', content: `Продукты: ${text}` }
                ],
                max_tokens: 1500
            });
            
            const recipe = response.choices[0].message.content;
            await ctx.reply(recipe, { parse_mode: 'HTML' });
            
            if (!hasSub) {
                await incrementFreeRecipes(tgId);
                const newCount = freeUsed + 1;
                if (newCount < FREE_LIMIT) {
                    await ctx.reply(`🎁 Осталось бесплатных рецептов: <b>${FREE_LIMIT - newCount}</b>`, { parse_mode: 'HTML' });
                }
            }
        } catch (e) {
            console.error('GigaChat error:', e);
            ctx.reply('❌ Ошибка генерации: ' + e.message);
        }
    });

    // ===== КНОПКА ОПЛАТЫ =====
    bot.action('pay_subscribe', async (ctx) => {
        await ctx.answerCbQuery();
        
        const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
        const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
        
        const paymentMsg = 
            `💳 <b>Оплата подписки — ${SUB_PRICE}₽ / месяц</b>\n\n` +
            `1️⃣ Переведите <b>${SUB_PRICE}₽</b> по СБП:\n` +
            `📱 Номер: <code>${SBP_PHONE}</code>\n` +
            `👤 Получатель: ${SBP_RECIPIENT}\n` +
            `🏦 Банки: 🟢 Сбер,  ВТБ, 🟡 Т-банк\n\n` +            `2️⃣ После оплаты пришлите сюда <b>чек</b> (скриншот или PDF).\n\n` +
            `⏱ Подписка активируется в течение 5 минут после проверки.`;

        ctx.reply(paymentMsg, { 
            parse_mode: 'HTML'
        });
    });

    // ===== ПРИЁМ ЧЕКОВ (С КНОПКАМИ ДЛЯ АДМИНА) =====
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id;
        const user = await getUser(tgId);
        
        if (!user) {
            await createUser(tgId, ctx.from.username, ctx.from.first_name);
        }
        
        // Получаем fileId
        let fileId;
        if (ctx.message.photo) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        } else if (ctx.message.document) {
            if (!ctx.message.document.mime_type?.startsWith('image/') && 
                ctx.message.document.mime_type !== 'application/pdf') {
                return; // Не картинка и не PDF
            }
            fileId = ctx.message.document.file_id;
        }
        
        if (!fileId) return;
        
        try {
            // Сохраняем платёж в БД
            const { rows } = await pool.query(
                `INSERT INTO payments (user_id, amount, receipt_file_id, receipt_caption) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [tgId, SUB_PRICE, fileId, ctx.message.caption || '']
            );
            
            const paymentId = rows[0].id;
            
            // Ответ пользователю
            await ctx.reply(
                `✅ <b>Чек получен!</b>\n\n` +
                `Ваша заявка <b>#${paymentId}</b> принята в обработку.\n` +
                `Администратор проверит оплату и активирует подписку.\n\n` +
                `⏱ Обычно это занимает до 5 минут.`,
                { parse_mode: 'HTML' }
            );
                        // === ОТПРАВКА УВЕДОМЛЕНИЯ АДМИНУ С КНОПКАМИ ===
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
                        `<i>Нажмите кнопку для подтверждения или отклонения</i>`;
                    
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
                    
                    console.log(`✅ Уведомление админу отправлено (чек #${paymentId})`);
                    
                } catch (notifyErr) {
                    console.error('❌ Ошибка отправки уведомления админу:', notifyErr.message);
                }
            }
            
        } catch (err) {
            console.error('❌ Ошибка обработки чека:', err);
            ctx.reply('❌ Произошла ошибка при обработке чека. Попробуйте позже.');
        }
    });

};
