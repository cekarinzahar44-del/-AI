const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
require('dotenv').config();

// ── 1. ПРОВЕРКА БЕЗОПАСНОСТИ ──
if (!process.env.BOT_TOKEN || !process.env.DEEPSEEK_API_KEY) {
    console.error('❌ Ошибка: Проверь файл .env или переменные на хостинге!');
    process.exit(1);
}

// ── 2. НАСТРОЙКА AI (DeepSeek) ──
// DeepSeek совместим с OpenAI, меняем только baseURL
const openai = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com'
});

// ── 3. ЗАПУСК БОТА ──
const bot = new Telegraf(process.env.BOT_TOKEN);

console.log('👨‍ Бот Домашний ШЕФ запускается...');

// Команда /start
bot.start((ctx) => {
    ctx.reply(
        '👋 Привет! Я твой **Домашний ШЕФ AI**.\n\n' +
        'Напиши мне список продуктов, которые у тебя есть в холодильнике, ' +
        'а я придумаю вкусное блюдо и напишу подробный рецепт!\n\n' +
        '🥚 *Пример:* яйца, молоко, сыр, помидоры',
        { parse_mode: 'Markdown' }
    );
});

// Обработка текста (ингредиентов)
bot.on('text', async (ctx) => {
    const ingredients = ctx.message.text;
    
    // Проверка, чтобы не реагировать на команды
    if (ingredients.startsWith('/')) return;

    // Отправляем статус "печатает..."
    await ctx.replyWithChatAction('typing');

    try {
        // Запрос к DeepSeek
        const completion = await openai.chat.completions.create({
            model: "deepseek-chat",
            messages: [
                { 
                    role: "system", 
                    content: "Ты профессиональный шеф-повар. Твоя задача — придумать вкусное блюдо из предложенных ингредиентов. Ответь красиво, используя Markdown." 
                },
                { 
                    role: "user", 
                    content: `У меня есть эти ингредиенты: ${ingredients}. Что я могу приготовить? Напиши название блюда, список продуктов (с количествами) и пошаговый рецепт.` 
                }
            ],
            max_tokens: 1000,
            temperature: 0.7
        });

        const recipe = completion.choices[0].message.content;

        // Отправляем рецепт пользователю
        await ctx.reply(`👨‍ **Вот что я придумал:**\n\n${recipe}`, { 
            parse_mode: 'Markdown' 
        });

    } catch (error) {
        console.error('AI Error:', error);
        ctx.reply('😔 Ой, что-то сломалось на кухне. Попробуй позже!');
    }
});

// Запуск
bot.launch();
console.log('✅ Бот работает и ждет ингредиенты!');

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
