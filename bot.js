require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http'); // ВНИМАНИЕ: Здесь HTTP, а не express!
const { GigaChat } = require('gigachat');

// 1. Проверка переменных
const BOT_TOKEN = process.env.BOT_TOKEN;
const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

if (!BOT_TOKEN || !GIGA_CREDENTIALS) {
    console.error('❌ Ошибка: Не заданы переменные!');
    process.exit(1);
}

// 2. Настройка GigaChat
const giga = new GigaChat({
    credentials: GIGA_CREDENTIALS,
    scope: 'GIGACHAT_API_PERS'
});

// 3. Настройка Бота
const bot = new Telegraf(BOT_TOKEN);

// 4. Сервер (Встроенный, без express)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
});

server.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

// 5. Команда /start
bot.start((ctx) => {
    ctx.reply('👋 Привет! Я Шеф-повар. Напиши продукты!');
});

// 6. Обработка текста
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    await ctx.replyWithChatAction('typing');

    try {
        const response = await giga.chat({
            model: 'GigaChat', 
            messages: [
                { role: 'system', content: 'Ты повар. Дай рецепт из продуктов.' },
                { role: 'user', content: `Продукты: ${text}` }
            ],
            max_tokens: 1000
        });
        ctx.reply(response.choices[0].message.content);
    } catch (e) {
        ctx.reply('Ошибка: ' + e.message);
    }
});

bot.launch();
console.log('✅ Bot started');
