#!/usr/bin/env node

/**
 * Telegram Bot for ElizaOS Overlay Sandbox Testing
 *
 * This bot sends user messages to your ElizaOS Overlay Sandbox
 * and returns responses with fee calculations displayed.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ELIZA_SANDBOX_URL = 'https://eliza-overlay-sandbox.samarth-gugnani30.workers.dev';
const ELIZA_API_KEY = 'eliza_55bd7b416baf9d1061053c150c312a506d5740d7a3ad5eefc0fd61e14454bc37';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ Please set TELEGRAM_BOT_TOKEN environment variable');
  process.exit(1);
}

class TelegramElizaBot {
  constructor() {
    this.baseUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
    this.offset = 0;
    console.log('🤖 ElizaOS Telegram Bot initialized');
    console.log(`🎯 Sandbox URL: ${ELIZA_SANDBOX_URL}`);
    console.log(`🔑 Using API Key: ${ELIZA_API_KEY.substring(0, 20)}...`);
  }

  async sendMessage(chatId, text, parseMode = 'Markdown') {
    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: parseMode
        })
      });

      if (!response.ok) {
        console.error('❌ Telegram API error:', await response.text());
      }
    } catch (error) {
      console.error('❌ Error sending message:', error.message);
    }
  }

  async callElizaSandbox(userMessage, chatId) {
    try {
      console.log(`📤 Sending to sandbox: ${userMessage.substring(0, 50)}...`);

      const startTime = Date.now();
      const response = await fetch(`${ELIZA_SANDBOX_URL}/agent/chat?session=telegram_${chatId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eliza-Cloud-Key': ELIZA_API_KEY,
          'User-Agent': 'TelegramBot/1.0'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'user', content: userMessage }
          ],
          max_tokens: 300,
          temperature: 0.7
        })
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Sandbox error (${response.status}): ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();

      // Extract fee information from headers
      const baseCost = parseFloat(response.headers.get('x-eliza-sandbox-base-cost-usd') || '0');
      const platformFee = parseFloat(response.headers.get('x-eliza-sandbox-fee-usd') || '0');
      const totalCost = parseFloat(response.headers.get('x-eliza-sandbox-total-usd') || '0');
      const requestId = response.headers.get('x-eliza-cloud-request-id') || 'N/A';

      console.log(`📨 Response received (${responseTime}ms) - Cost: $${totalCost}`);

      return {
        content: data.choices[0]?.message?.content || 'No response received',
        usage: data.usage,
        model: data.model,
        requestId,
        fees: {
          baseCost,
          platformFee,
          totalCost
        },
        responseTime
      };

    } catch (error) {
      console.error('❌ Sandbox error:', error.message);
      return {
        error: error.message,
        content: `Sorry, I encountered an error: ${error.message}`
      };
    }
  }

  formatResponse(elizaResponse) {
    if (elizaResponse.error) {
      return `❌ *Error*\n${elizaResponse.content}`;
    }

    const feeRate = elizaResponse.fees.baseCost > 0
      ? ((elizaResponse.fees.platformFee / elizaResponse.fees.baseCost) * 100).toFixed(1)
      : '0.0';

    return `🤖 *ElizaOS Response*\n${elizaResponse.content}\n\n` +
           `📊 *Usage & Fees*\n` +
           `• Tokens: ${elizaResponse.usage?.prompt_tokens || 0} → ${elizaResponse.usage?.completion_tokens || 0}\n` +
           `• Base Cost: $${elizaResponse.fees.baseCost.toFixed(6)}\n` +
           `• Sandbox Fee: $${elizaResponse.fees.platformFee.toFixed(6)} (${feeRate}%)\n` +
           `• Total Cost: $${elizaResponse.fees.totalCost.toFixed(6)}\n` +
           `• Response Time: ${elizaResponse.responseTime}ms\n` +
           `• Request ID: \`${elizaResponse.requestId}\``;
  }

  async handleMessage(message) {
    const chatId = message.chat.id;
    const userText = message.text;
    const userName = message.from.first_name || 'User';

    if (userText === '/start') {
      await this.sendMessage(chatId,
        `👋 *Welcome to ElizaOS Sandbox Bot!*\n\n` +
        `This bot connects to the ElizaOS Overlay Sandbox with 20% fee calculation.\n\n` +
        `🎯 *Sandbox URL:* ${ELIZA_SANDBOX_URL}\n` +
        `💰 *Fee Rate:* 20%\n` +
        `🤖 *Model:* gpt-4o-mini\n\n` +
        `Just send me any message and I'll show you the response with detailed fee breakdown!`
      );
      return;
    }

    if (userText === '/help') {
      await this.sendMessage(chatId,
        `🆘 *Help - ElizaOS Sandbox Bot*\n\n` +
        `*Commands:*\n` +
        `• \`/start\` - Show welcome message\n` +
        `• \`/help\` - Show this help\n` +
        `• \`/status\` - Check sandbox status\n\n` +
        `*Features:*\n` +
        `• Real-time ElizaOS chat responses\n` +
        `• 20% sandbox fee calculation\n` +
        `• Token usage tracking\n` +
        `• Response time measurement\n\n` +
        `Just send any message to chat!`
      );
      return;
    }

    if (userText === '/status') {
      try {
        const healthResponse = await fetch(`${ELIZA_SANDBOX_URL}/health`);
        const healthData = await healthResponse.json();

        await this.sendMessage(chatId,
          `📊 *Sandbox Status*\n\n` +
          `🟢 Status: ${healthData.status === 'ok' ? 'Online' : 'Offline'}\n` +
          `🏷️ Service: ${healthData.service}\n` +
          `🌐 URL: ${ELIZA_SANDBOX_URL}\n` +
          `🔑 API Key: ${ELIZA_API_KEY.substring(0, 12)}...\n` +
          `💰 Fee Rate: 20%`
        );
      } catch (error) {
        await this.sendMessage(chatId, `❌ *Status Check Failed*\n${error.message}`);
      }
      return;
    }

    // Handle regular chat messages
    console.log(`👤 ${userName} (${chatId}): ${userText}`);

    // Send "typing" indicator
    await fetch(`${this.baseUrl}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action: 'typing'
      })
    });

    // Get response from ElizaOS Sandbox
    const elizaResponse = await this.callElizaSandbox(userText, chatId);
    const formattedResponse = this.formatResponse(elizaResponse);

    await this.sendMessage(chatId, formattedResponse);
  }

  async getUpdates() {
    try {
      const response = await fetch(`${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=30`);
      const data = await response.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          this.offset = update.update_id + 1;

          if (update.message && update.message.text) {
            await this.handleMessage(update.message);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error getting updates:', error.message);
    }
  }

  async start() {
    console.log('🚀 Starting ElizaOS Telegram bot...');

    // Test connection
    try {
      const response = await fetch(`${this.baseUrl}/getMe`);
      const botInfo = await response.json();

      if (botInfo.ok) {
        console.log(`✅ Bot connected: @${botInfo.result.username}`);
        console.log(`📛 Bot name: ${botInfo.result.first_name}`);
      } else {
        throw new Error('Bot authentication failed');
      }
    } catch (error) {
      console.error('❌ Bot connection failed:', error.message);
      process.exit(1);
    }

    // Start polling
    console.log('🔄 Starting message polling...');
    while (true) {
      await this.getUpdates();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Start the bot
if (require.main === module) {
  const bot = new TelegramElizaBot();
  bot.start().catch(console.error);
}

module.exports = TelegramElizaBot;