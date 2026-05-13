require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http'); // Встроенный модуль Node.js, не требует установки
const { GigaChat } = require('gigachat');

// ── 1. ПРОВЕРКА ПЕРЕМЕННЫХ ──
const BOT_TOKEN = process.env.BOT_TOKEN;
const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

if (!BOT_TOKEN || !GIGA_CREDENTIALS) {
    console.error('❌ Ошибка: Не заданы BOT_TOKEN или GIGACHAT_CREDENTIALS');
    process.exit(1);
}

// ── 2. ИНИЦИАЛИЗАЦИЯ GIGACHAT ──
const giga = new GigaChat({
    credentials: GIGA_CREDENTIALS,
    scope: 'GIGACHAT_API_PERS'
});

// ── 3. НАСТРОЙКА БОТА ──
const bot = new Telegraf(BOT_TOKEN);

// ── 4. HTTP-СЕРВЕР ДЛЯ ХОСТИНГА (БЕЗ EXPRESS) ──
// Создаем простой сервер на встроенном модуле http
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('👨‍🍳 Домашний ШЕФ AI работает!');
});

server.listen(PORT, () => {
    console.log(`🌐 HTTP-сервер запущен на порту ${PORT}`);
});

// ── 5. КОМАНДА /START ──
bot.start((ctx) => {
    ctx.reply(
        '👋 Привет! Я твой **Домашний ШЕФ AI** на базе GigaChat.\n\n' +
        'Напиши мне список продуктов, а я придумаю вкусное блюдо!\n\n' +
        '🥚 *Пример:* курица, картошка, лук, сметана',
        { parse_mode: 'Markdown' }
    );
});

// ── 6. ОБРАБОТКА СООБЩЕНИЙ ──
bot.on('text', async (ctx) => {
    const ingredients = ctx.message.text.trim();
    if (ingredients.startsWith('/')) return;

    await ctx.replyWithChatAction('typing');

    try {
        const response = await giga.chat({
            model: 'GigaChat', 
            messages: [
                { role: 'system', content: 'Ты профессиональный шеф-повар. Придумывай вкусные блюда из предложенных ингредиентов. Отвечай красиво, используй Markdown.' },
                { role: 'user', content: `У меня есть: ${ingredients}. Что приготовить? Напиши название, пропорции и рецепт.` }
            ],
            max_tokens: 1500,
            temperature: 0.7
        });

        const recipe = response.choices[0].message.content;
        await ctx.reply(`👨‍ **Вот идеальный рецепт:**\n\n${recipe}`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('❌ Ошибка GigaChat:', error.message);
        ctx.reply('😔 Упс! Что-то пошло не так на кухне. Попробуй позже.');
    }
});

bot.catch((err) => {
    console.error('Telegraf error:', err);
});

async function start() {
    await bot.launch();
    console.log('✅ Бот запущен и ждет ингредиенты!');

    process.once('SIGINT', () => {
        bot.stop('SIGINT');
        server.close();
    });
    process.once('SIGTERM', () => {
        bot.stop('SIGTERM');
        server.close();
    });
}

start();
