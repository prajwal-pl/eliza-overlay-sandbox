# 🤖 ElizaOS Overlay Sandbox Telegram Bot

Complete guide to test your ElizaOS Overlay Sandbox via Telegram.

## 🎯 Quick Setup

### Step 1: Get Your Bot Token
1. Open Telegram and search for `@BotFather`
2. Send `/start` to BotFather
3. Send `/newbot` to create a new bot
4. Choose a name: `ElizaOS Sandbox Test Bot`
5. Choose a username: `your_username_test_bot` (must end with `_bot`)
6. **Copy the Bot Token** (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Step 2: Configure Bot
```bash
# Send to @BotFather to configure your bot:
/setdescription your_username_test_bot
# Description: "Test bot for ElizaOS Overlay Sandbox with 20% fee calculation"

/setabouttext your_username_test_bot
# About: "Powered by ElizaOS Cloud API via Overlay Sandbox"

/setuserpic your_username_test_bot
# Upload a profile picture (optional)
```

### Step 3: Set Environment Variable & Run
```bash
# Set your bot token (replace with your actual token)
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"

# Run the bot
node telegram-bot.js
```

## 🚀 Usage Guide

### Bot Commands
- `/start` - Welcome message and setup info
- `/help` - Show available commands and features
- `/status` - Check sandbox health and configuration
- Any other message - Chat with ElizaOS via your sandbox

### Expected Response Format
```
🤖 ElizaOS Response
[AI response content here]

📊 Usage & Fees
• Tokens: 15 → 42
• Base Cost: $0.000234
• Sandbox Fee: $0.000047 (20.0%)
• Total Cost: $0.000281
• Response Time: 1234ms
• Request ID: abc123-def456
```

## 🔧 Current Configuration

**Your Sandbox Details:**
- **URL**: `https://eliza-overlay-sandbox.samarth-gugnani30.workers.dev`
- **API Key**: `eliza_55bd7b416baf9d1061053c150c312a506d5740d7a3ad5eefc0fd61e14454bc37`
- **Model**: `gpt-4o-mini`
- **Fee Rate**: 20%
- **Max Tokens**: 300 per response

## 🧪 Testing Scenarios

### 1. Basic Chat Test
Send: `Hello! Can you help me with something?`
Expected: Normal chat response with fee breakdown

### 2. Long Response Test
Send: `Can you write a detailed explanation of machine learning?`
Expected: Longer response with higher token usage and proportional fees

### 3. Fee Calculation Verification
Send: `What's 2+2?`
Expected: Short response with minimal fees, verify 20% fee rate

### 4. Session Tracking Test
Send multiple messages in sequence to verify session continuity via `session=telegram_[chat_id]`

## 🐛 Troubleshooting

### Bot Not Responding
```bash
# Check if bot token is set
echo $TELEGRAM_BOT_TOKEN

# Check sandbox health
curl https://eliza-overlay-sandbox.samarth-gugnani30.workers.dev/health

# Run bot with debug output
node telegram-bot.js
```

### Common Issues
1. **"Bot authentication failed"** - Check your `TELEGRAM_BOT_TOKEN`
2. **"Sandbox error (401)"** - API key validation issue (should not happen with current setup)
3. **"Sandbox error (502)"** - Upstream ElizaOS API issue (should not happen with current setup)
4. **No response** - Check internet connection and bot token

### Log Output
The bot shows detailed logs:
```
🤖 ElizaOS Telegram Bot initialized
🎯 Sandbox URL: https://eliza-overlay-sandbox.samarth-gugnani30.workers.dev
🔑 Using API Key: eliza_55bd7b416baf9d...
🚀 Starting ElizaOS Telegram bot...
✅ Bot connected: @your_username_test_bot
📛 Bot name: ElizaOS Sandbox Test Bot
🔄 Starting message polling...
👤 John (12345): Hello there!
📤 Sending to sandbox: Hello there!...
📨 Response received (2341ms) - Cost: $0.000281
```

## 📊 Expected Test Results

### Successful Test Run
- ✅ Bot connects and shows username
- ✅ `/start` shows welcome message with sandbox details
- ✅ `/status` shows sandbox online with correct service name
- ✅ Chat messages return ElizaOS responses
- ✅ Fee calculations show 20% sandbox fee
- ✅ Response times are reasonable (2-10 seconds)
- ✅ Token usage is displayed correctly
- ✅ Request IDs are generated

### Fee Calculation Examples
For a typical response:
- Prompt tokens: ~15-20
- Completion tokens: ~30-50
- Base cost: ~$0.0002-0.0005
- Platform fee: ~$0.00004-0.0001 (20% of base)
- Total cost: ~$0.00024-0.0006

## 🔍 Advanced Features

The bot includes:
- **Session Management**: Each chat gets unique session ID
- **Real-time Fee Calculation**: Live 20% fee display
- **Error Handling**: Graceful error messages
- **Response Time Tracking**: Performance monitoring
- **Usage Statistics**: Token count display
- **Request ID Tracking**: For debugging and audit

## 🚦 Status Indicators

Bot will show:
- 🟢 Online - Sandbox healthy and responding
- 🟡 Slow - Responses taking >5 seconds
- 🔴 Error - Sandbox or API issues
- ⚪ Offline - Bot disconnected

This setup provides complete testing of your ElizaOS Overlay Sandbox functionality through an easy-to-use Telegram interface!