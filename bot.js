const { Telegraf, Markup } = require('telegraf');
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

async function callGigaChat(systemPrompt, userPrompt) {
    const token = await getGigaToken();
    const res = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
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
                { role: 'system', content: systemPrompt },                { role: 'user', content: userPrompt }
            ]
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`GigaChat API: ${data.message || res.statusText}`);
    return data.choices[0].message.content;
}

// =========================
// CLEAN HTML + AUTO-FIX
// =========================
function cleanHtml(text) {
    if (!text) return '';
    let safeText = text
        .replace(/```html/gi, '').replace(/```/g, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<html[\s\S]*?>/gi, '').replace(/<\/html>/gi, '')
        .replace(/<body[\s\S]*?>/gi, '').replace(/<\/body>/gi, '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<h1>/gi, '<b>').replace(/<\/h1>/gi, '</b>\n')
        .replace(/<h2>/gi, '<b>').replace(/<\/h2>/gi, '</b>\n')
        .replace(/<ul>/gi, '').replace(/<\/ul>/gi, '')
        .replace(/<ol.*?>/gi, '').replace(/<\/ol>/gi, '')
        .replace(/<li>/gi, '• ').replace(/<\/li>/gi, '\n')
        .replace(/\*\*/g, '')
        .replace(/<br>/gi, '\n').replace(/<br\/>/gi, '\n').replace(/<br \/>/gi, '\n')
        .replace(/&nbsp;/gi, ' ')
        .replace(/<div>/gi, '').replace(/<\/div>/gi, '\n')
        .replace(/class=".*?"/gi, '').replace(/style=".*?"/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    
    const open = (safeText.match(/<b>/g) || []).length;
    const close = (safeText.match(/<\/b>/g) || []).length;
    if (open > close) safeText += '</b>'.repeat(open - close);
    
    return safeText;
}

// =========================
// EXPORT MODULE
// =========================
module.exports = (bot, pool, ADMIN_ID) => {
    console.log('✅ VIP Chef Bot loaded');
    const userStates = {};

    // =========================
    // 📖 STEP PARSER
    // =========================    function parseSteps(fullText) {
        if (!fullText) return ['Текст рецепта не получен.'];
        const stepRegex = /(?:Шаг\s*\d+[\.:\s\-]*)|(?:^\d+\.\s)/gim;
        const parts = fullText.split(stepRegex).filter(p => p.trim().length > 5);
        if (parts.length >= 2) return parts.map(p => p.trim());
        const fallback = fullText.split(/\n\s*\n/).filter(p => p.trim().length > 10);
        return fallback.length >= 2 ? fallback : [fullText];
    }

    // =========================
    // 📖 SEND STEP MESSAGE
    // =========================
    async function sendStepMessage(ctx, tgId) {
        const state = userStates[tgId];
        if (!state || state.mode !== 'step_recipe') return;

        const stepText = state.steps[state.currentStep];
        const progress = `📖 <b>${state.title}</b>\n⏳ Шаг ${state.currentStep + 1} из ${state.total}`;

        const keyboard = { inline_keyboard: [] };

        const firstRow = [];
        if (state.currentStep === 0) {
            firstRow.push({ text: '⏮ Начало', callback_data: 'step_start' });
        } else {
            firstRow.push({ text: '⬅️ Назад', callback_data: `step_${state.currentStep - 1}` });
        }
        
        if (state.currentStep === state.total - 1) {
            firstRow.push({ text: '🏁 Готово', callback_data: 'step_done' });
        } else {
            firstRow.push({ text: 'Далее ➡️', callback_data: `step_${state.currentStep + 1}` });
        }
        keyboard.inline_keyboard.push(firstRow);

        keyboard.inline_keyboard.push([
            { text: '📜 Весь рецепт', callback_data: 'step_full_recipe' },
            { text: '🗑 Закрыть', callback_data: 'step_close_recipe' }
        ]);

        try {
            if (ctx.update?.callback_query) {
                await ctx.editMessageText(`${progress}\n\n${stepText}`, { parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                await ctx.reply(`${progress}\n\n${stepText}`, { parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (e) {
            console.error('Send step error:', e);
            await ctx.reply(`${progress}\n\n${stepText}`, { parse_mode: 'HTML', reply_markup: keyboard });
        }    }

    // =========================
    // REQUEST TYPE
    // =========================
    function detectRequestType(text) {
        const lower = text.toLowerCase();
        const dishKeywords = ['рецепт', 'приготовь', 'хочу', 'сделай', 'как сделать', 'борщ', 'салат', 'суп', 'паста', 'карбонара', 'омлет', 'плов', 'котлеты', 'торт', 'десерт'];
        if (dishKeywords.some(k => lower.includes(k))) return 'dish';
        if (text.includes(',')) return 'ingredients';
        return 'dish';
    }

    // =========================
    // BUILD PROMPT
    // =========================
    function buildPrompt(requestType, ingredients, details, planType) {
        const isVIP = planType === 'VIP';
        const system = `
Ты элитный ИИ Шеф-Повар с 20-летним опытом.

ТВОЯ ЗАДАЧА: Создавать ПОДРОБНЫЕ рецепты с точными инструкциями.

❗ ВАЖНО - КАЖДЫЙ ШАГ ДОЛЖЕН СОДЕРЖАТЬ:
⏱ ВРЕМЯ | 🌡 ТЕМПЕРАТУРА | 🍳 СПОСОБ | 📏 ПРОПОРЦИИ

СТРУКТУРА:
<b>🍽 Название блюда</b>
<b>📝 Описание</b> (2-3 предложения)
<b>🛒 Ингредиенты</b> (• продукт — количество)
<b>⏱ Общее время</b> (Подготовка / Приготовление / Всего)
<b>🔥 Метод</b> (Жарка/Варка/Запекание)
<b>👨‍🍳 Пошаговое приготовление</b>
<b>Шаг 1:</b> ⏱ X мин | 🌡 °C | Описание
<b>Шаг 2:</b> ⏱ X мин | 🌡 °C | Описание
...
<b>💡 Советы шефа</b>
<b>🍷 Напитки</b> (🍷 + 🧃)
${isVIP ? '<b>📊 КБЖУ:</b> Ккал/Б/Ж/У' : ''}

ПРАВИЛА:
✅ Только <b> для жирного
✅ Каждый шаг с ⏱ и 
✅ Эмодзи для наглядности
❌ НЕ используй ** (markdown)
`;
        if (requestType === 'ingredients') {
            return { system, user: `Блюдо ТОЛЬКО из: ${ingredients}\nДоп: ${details || 'нет'}` };
        }
        return { system, user: `Рецепт: ${ingredients}\nДоп: ${details || 'нет'}` };    }

    // =========================
    // DB HELPERS
    // =========================
    async function createUser(tgId, username, firstName) {
        await pool.query(`INSERT INTO users (tg_id, username, first_name, free_recipes_used) VALUES ($1,$2,$3,0) ON CONFLICT (tg_id) DO NOTHING`, [tgId, username, firstName]);
    }
    async function getUser(tgId) { const { rows } = await pool.query(`SELECT * FROM users WHERE tg_id = $1`, [tgId]); return rows[0]; }
    async function getFreeRecipesUsed(tgId) { const u = await getUser(tgId); return u?.free_recipes_used || 0; }
    async function incrementFreeRecipes(tgId) { await pool.query(`UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id = $1`, [tgId]); }
    async function resetFreeRecipes(tgId) { await pool.query(`UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`, [tgId]); }
    async function hasSubscription(tgId) { const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW() LIMIT 1`, [tgId]); return rows[0]; }

    // =========================
    // SUB MENU
    // =========================
    async function sendSubscriptionMenu(ctx) {
        return ctx.reply(`🎯 <b>Пробный лимит закончился</b>\n\n💳 <b>PRO — ${PRO_PRICE}₽</b>\n\n💎 <b>VIP — ${VIP_PRICE}₽</b>\n• ИИ диетолог\n• КБЖУ\n• Меню`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '💰 Купить PRO', callback_data: 'pay_pro' }], [{ text: '💎 Купить VIP', callback_data: 'pay_vip' }]] }
        });
    }

    function getPaymentInstruction(planType, amount) {
        return `💳 <b>Оплата ${planType}</b>\n\nСумма: <b>${amount}₽</b>\n📱 <code>${SBP_PHONE}</code>\n👤 ${SBP_RECIPIENT}\n\nПосле оплаты отправьте чек.`;
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
        if (subscription) return ctx.reply(`👨‍🍳 <b>Добро пожаловать!</b>\n🔥 Тариф: <b>${subscription.plan_type}</b>\n\nНапишите рецепт.`, { parse_mode: 'HTML' });
        if (freeUsed >= FREE_LIMIT) return sendSubscriptionMenu(ctx);
        await ctx.reply(`👨‍🍳 <b>Шеф-Повар AI</b>\n\n🍽 Осталось: <b>${FREE_LIMIT - freeUsed}</b>`, { parse_mode: 'HTML' });
    });

    // =========================
    // PAY BUTTONS
    // =========================
    bot.action('pay_pro', async (ctx) => {
        await ctx.answerCbQuery();
        userStates[ctx.from.id] = { payingFor: 'PRO', amount: PRO_PRICE };
        await ctx.editMessageText(getPaymentInstruction('PRO', PRO_PRICE), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'show_subscriptions' }]] } });
    });    bot.action('pay_vip', async (ctx) => {
        await ctx.answerCbQuery();
        userStates[ctx.from.id] = { payingFor: 'VIP', amount: VIP_PRICE };
        await ctx.editMessageText(getPaymentInstruction('VIP', VIP_PRICE), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'show_subscriptions' }]] } });
    });
    bot.action('show_subscriptions', async (ctx) => {
        await ctx.answerCbQuery(); delete userStates[ctx.from.id]; await sendSubscriptionMenu(ctx);
    });

    // =========================
    // RECEIPTS
    // =========================
    bot.on(['photo', 'document'], async (ctx) => {
        const tgId = ctx.from.id; const state = userStates[tgId];
        if (!state?.payingFor) return ctx.reply('📎 Чек — только при оплате.');
        let fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length-1].file_id : ctx.message.document?.file_id;
        if (!fileId) return;
        const { rows } = await pool.query(`INSERT INTO payments (user_id, amount, receipt_file_id, status, plan_type) VALUES ($1,$2,$3,'pending',$4) RETURNING id`, [tgId, state.amount, fileId, state.payingFor]);
        const paymentId = rows[0].id; delete userStates[tgId];
        await ctx.reply(`✅ <b>Чек принят!</b>\n📋 #${paymentId}`, { parse_mode: 'HTML' });
        const user = await getUser(tgId);
        const caption = `🚨 Заявка #${paymentId}\n👤 ${user?.first_name}\n💎 ${state.payingFor} | 💰 ${state.amount}₽`;
        const keyboard = { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `approve_${paymentId}` }], [{ text: '❌ Отклонить', callback_data: `reject_${paymentId}` }]] };
        try {
            if (ctx.message.photo) await ctx.telegram.sendPhoto(ADMIN_ID, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
            else await ctx.telegram.sendDocument(ADMIN_ID, fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
        } catch(e) { console.error('ADMIN ERROR:', e); }
    });

    // =========================
    // MAIN TEXT + STEP MODE
    // =========================
    bot.on('text', async (ctx) => {
        const text = ctx.message.text?.trim();
        if (!text || text.startsWith('/')) return;
        const tgId = ctx.from.id;
        if (tgId === ADMIN_ID) return;

        const adminKey = `admin_reject_${ADMIN_ID}`;
        if (userStates[adminKey]) {
            const pid = userStates[adminKey].paymentId;
            delete userStates[adminKey];
            await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [pid]);
            await ctx.reply(`❌ #${pid} отклонена`);
            try { const { rows: [p] } = await pool.query(`SELECT user_id FROM payments WHERE id = $1`, [pid]); await ctx.telegram.sendMessage(p.user_id, `❌ Отклонено.\nПричина: ${text}`); } catch(e){}
            return;
        }

        await createUser(tgId, ctx.from.username, ctx.from.first_name);
        const subscription = await hasSubscription(tgId);        const freeUsed = await getFreeRecipesUsed(tgId);
        if (!subscription && freeUsed >= FREE_LIMIT) return sendSubscriptionMenu(ctx);

        const state = userStates[tgId];

        if (!state) {
            userStates[tgId] = { requestType: detectRequestType(text), ingredients: text, step: 'details' };
            return ctx.reply(`👨‍🍳 Укажите:\n👥 Порций?\n🥗 Предпочтения?`, { parse_mode: 'HTML', reply_markup: { keyboard: [['🥗 ПП'], ['🔥 Быстро'], ['💰 Бюджетно']], resize_keyboard: true } });
        }

        if (state.step === 'details') {
            delete userStates[tgId];
            const loading = await ctx.reply('👨‍ Готовлю...');
            try {
                const planType = subscription?.plan_type || 'FREE';
                const prompt = buildPrompt(state.requestType, state.ingredients, text, planType);
                let recipe = await callGigaChat(prompt.system, prompt.user);
                recipe = cleanHtml(recipe);
                try { await ctx.deleteMessage(loading.message_id); } catch {}

                const steps = parseSteps(recipe);
                const titleMatch = recipe.match(/<b>.*?[🍽🍰].*?<\/b>/i);
                const title = titleMatch ? titleMatch[0].replace(/<\/?b>/g, '') : 'Твой рецепт';

                userStates[tgId] = { mode: 'step_recipe', steps: steps.map(s => cleanHtml(s)), currentStep: 0, title, total: steps.length };
                console.log(`📖 Step mode activated for ${tgId}: ${steps.length} steps`);
                await sendStepMessage(ctx, tgId);

                if (!subscription) {
                    await incrementFreeRecipes(tgId);
                    if (getFreeRecipesUsed(tgId) >= FREE_LIMIT) await sendSubscriptionMenu(ctx);
                }
            } catch (err) {
                try { await ctx.deleteMessage(loading.message_id); } catch {}
                console.error('GigaChat error:', err);
                await ctx.reply('❌ Ошибка генерации. Попробуй позже.');
            }
        }
    });

    // =========================
    // 📖 STEP NAVIGATION (С ЛОГИРОВАНИЕМ)
    // =========================
    bot.action(/step_(.+)/, async (ctx) => {
        const action = ctx.match[1];
        const tgId = ctx.from.id;
        const state = userStates[tgId];
        
        console.log(`🔘 Кнопка нажата: step_${action}, user: ${tgId}, state:`, state?.mode);
        if (!state || state.mode !== 'step_recipe') {
            console.log('❌ Режим step_recipe не активен');
            return ctx.answerCbQuery('⚠️ Режим не активен. Запросите рецепт заново.');
        }

        if (/^\d+$/.test(action)) {
            const stepNum = parseInt(action);
            if (stepNum >= 0 && stepNum < state.total) {
                state.currentStep = stepNum;
                await sendStepMessage(ctx, tgId);
            }
            return ctx.answerCbQuery();
        }

        switch(action) {
            case 'full_recipe':
                const full = state.steps.join('\n\n---\n\n');
                await ctx.editMessageText(`📜 <b>${state.title}</b>\n\n${cleanHtml(full)}`, { parse_mode: 'HTML' });
                delete userStates[tgId];
                return ctx.answerCbQuery('📜 Показан полный рецепт');
                
            case 'close_recipe':
                delete userStates[tgId];
                return ctx.editMessageText('✅ Режим закрыт. Напиши новый запрос.', { reply_markup: { remove_keyboard: true } });
                
            case 'start':
            case 'done':
                await sendStepMessage(ctx, tgId);
                return ctx.answerCbQuery();
                
            default:
                console.log('❓ Неизвестное действие:', action);
                return ctx.answerCbQuery('⚠️ Неизвестное действие');
        }
    });

    // =========================
    // VIP COMMANDS
    // =========================
    bot.command('weekmenu', async (ctx) => {
        const sub = await hasSubscription(ctx.from.id);
        if (!sub || sub.plan_type !== 'VIP') return ctx.reply('🔒 Только VIP');
        ctx.reply('📅 Меню (в разработке)', { parse_mode: 'HTML' });
    });
    bot.command('diet', async (ctx) => {
        const sub = await hasSubscription(ctx.from.id);
        if (!sub || sub.plan_type !== 'VIP') return ctx.reply('🔒 Только VIP');
        ctx.reply('🥗 Диетолог (в разработке)', { parse_mode: 'HTML' });
    });
    // =========================
    // ✅ ADMIN: APPROVE
    // =========================
    bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
        const paymentId = ctx.match[1];
        try {
            const { rows: [payment] } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
            if (!payment) return ctx.answerCbQuery('❌', { show_alert: true });
            const userId = payment.user_id, planType = payment.plan_type;
            await pool.query(`UPDATE subscriptions SET is_active = FALSE WHERE user_id = $1`, [userId]);
            const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 30);
            await pool.query(`INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) VALUES ($1, TRUE, $2, $3)`, [userId, expiresAt, planType]);
            await pool.query(`UPDATE users SET free_recipes_used = 0 WHERE tg_id = $1`, [userId]);
            await pool.query(`UPDATE payments SET status = 'approved' WHERE id = $1`, [paymentId]);
            await ctx.answerCbQuery('✅');
            await ctx.editMessageCaption(`✅ #${paymentId}\n🔥 ${planType}`, { parse_mode: 'HTML' });
            await ctx.telegram.sendMessage(userId, `🎉 <b>${planType} активирована!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`, { parse_mode: 'HTML' });
        } catch(e) { await ctx.answerCbQuery('❌', { show_alert: true }); }
    });

    // =========================
    // ❌ ADMIN: REJECT
    // =========================
    bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
        const paymentId = ctx.match[1];
        try {
            const { rows: [payment] } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
            if (!payment) return ctx.answerCbQuery('❌', { show_alert: true });
            await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]);
            await ctx.answerCbQuery('❌');
            await ctx.editMessageCaption(`❌ #${paymentId}`, { parse_mode: 'HTML' });
            await ctx.telegram.sendMessage(payment.user_id, `❌ Отклонено.\n📋 #${paymentId}`, { parse_mode: 'HTML' });
        } catch(e) { await ctx.answerCbQuery('❌', { show_alert: true }); }
    });

};
