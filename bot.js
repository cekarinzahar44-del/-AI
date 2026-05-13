require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const { GigaChat } = require('gigachat');

// ── 1. ПРОВЕРКА ПЕРЕМЕННЫХ ──
const BOT_TOKEN = process.env.BOT_TOKEN;
const GIGA_CREDENTIALS = process.env.GIGACHAT_CREDENTIALS;

if (!BOT_TOKEN || !GIGA_CREDENTIALS) {
    console.error('❌ Ошибка: Не заданы BOT_TOKEN или GIGACHAT_CREDENTIALS в переменных окружения!');
    process.exit(1);
}

// ── 2. ИНИЦИАЛИЗАЦИЯ GIGACHAT ──
// SDK автоматически получает и обновляет токен каждые 30 минут
const giga = new GigaChat({
    credentials: GIGA_CREDENTIALS,
    scope: 'GIGACHAT_API_PERS' // Для физических лиц
});

// ── 3. НАСТРОЙКА БОТА ──
const bot = new Telegraf(BOT_TOKEN);

// ── 4. HTTP-СЕРВЕР ДЛЯ ХОСТИНГА (Health Check) ──
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('👨‍ Домашний ШЕФ AI (GigaChat) работает!');
});

app.listen(PORT, () => {
    console.log(`🌐 HTTP-сервер запущен на порту ${PORT}`);
});

// ── 5. КОМАНДА /START ──
bot.start((ctx) => {
    ctx.reply(
        '👋 Привет! Я твой **Домашний ШЕФ AI** на базе GigaChat.\n\n' +
        'Напиши мне список продуктов, которые у тебя есть в холодильнике, ' +
        'а я придумаю вкусное блюдо и напишу подробный рецепт!\n\n' +
        '🥚 *Пример:* курица, картошка, лук, сметана',
        { parse_mode: 'Markdown' }
    );
});

// ── 6. ОБРАБОТКА СООБЩЕНИЙ ──
bot.on('text', async (ctx) => {
    const ingredients = ctx.message.text.trim();
    // Игнорируем другие команды
    if (ingredients.startsWith('/')) return;

    // Показываем статус "печатает..."
    await ctx.replyWithChatAction('typing');

    try {
        // Запрос к GigaChat
        const response = await giga.chat({
            model: 'GigaChat', // Можно заменить на 'GigaChat-Pro' если доступен
            messages: [
                {
                    role: 'system',
                    content: 'Ты профессиональный шеф-повар с многолетним опытом. Твоя задача — придумать вкусное и реалистичное блюдо из предложенных ингредиентов. Отвечай красиво, структурированно, используй Markdown. Обязательно укажи название блюда, точный список ингредиентов с граммовкой и пошаговый рецепт приготовления.'
                },
                {
                    role: 'user',
                    content: `У меня есть эти продукты: ${ingredients}. Что я могу из них приготовить?`
                }
            ],
            max_tokens: 1500,
            temperature: 0.7
        });

        const recipe = response.choices[0].message.content;
        
        await ctx.reply(`👨‍🍳 **Вот идеальный рецепт для тебя:**\n\n${recipe}`, {
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('❌ Ошибка GigaChat:', error.message);
        ctx.reply('😔 Упс! Что-то пошло не так на кухне. Попробуй отправить запрос ещё раз через пару секунд.');
    }
});

// ── 7. ОБРАБОТКА ОШИБОК TELEGRAM ──
bot.catch((err) => {
    console.error('Telegraf error:', err);
});

// ── 8. ЗАПУСК ──
async function start() {
    await bot.launch();
    console.log('✅ Бот успешно запущен и ждёт ингредиенты!');

    // Корректное завершение работы
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));}

start();
