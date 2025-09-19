import type { Env, ElizaChatCompletionRequest, ErrorResponse, AgentResponse } from './types';
import { AuthService } from './services/auth';
import { ProxyService } from './services/proxy';
import { PricingService } from './services/pricing';
import { UsageService } from './services/usage';
import { AgentService } from './services/agent';
import { ElizaTelegramRuntime } from './eliza-telegram-runtime';
import { testTelegramSetup, testTelegramBotToken } from './telegram-test';

/**
 * ElizaOS Overlay Sandbox Worker
 *
 * Proxies requests to ElizaOS Cloud API, validates API keys,
 * calculates sandbox fees, and tracks usage.
 */

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			// Handle CORS preflight
			if (request.method === 'OPTIONS') {
				return handleCors();
			}

			const url = new URL(request.url);
			const path = url.pathname;

			// Route handlers
			switch (path) {
				case '/health':
					return handleHealth(env);

				case '/agent/chat':
					return handleAgentChat(request, env, ctx);

				case '/telegram/start':
					return handleTelegramStart(request, env);

				case '/telegram/stop':
					return handleTelegramStop(request, env);

				case '/telegram/status':
					return handleTelegramStatus(env);

				case '/telegram/test':
					return handleTelegramTest(request, env);

				case '/webhook/telegram':
					return handleTelegramWebhook(request, env);

				default:
					return createErrorResponse(404, 'Not Found', 'Endpoint not found');
			}
		} catch (error) {
			console.error('Worker error:', error);
			return createErrorResponse(500, 'Internal Server Error', 'An unexpected error occurred');
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * Handle CORS preflight requests
 */
function handleCors(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Eliza-Cloud-Key',
			'Access-Control-Max-Age': '86400',
		},
	});
}

/**
 * Handle health check endpoint
 */
async function handleHealth(env: Env): Promise<Response> {
	const telegramRuntime = ElizaTelegramRuntime.getInstance();
	const telegramHealth = await telegramRuntime.healthCheck();

	const health = {
		status: 'ok',
		service: 'eliza-overlay-sandbox',
		components: {
			api: 'healthy',
			database: env.USAGE_DB ? 'connected' : 'not_configured',
			telegram: telegramHealth.healthy ? 'running' : 'stopped',
		},
		telegram: telegramHealth,
	};

	return new Response(JSON.stringify(health), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}


/**
 * Handle agent chat endpoint - main proxy logic
 */
async function handleAgentChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		// Only allow POST requests
		if (request.method !== 'POST') {
			return createErrorResponse(405, 'Method Not Allowed', 'Only POST requests are allowed');
		}

		// Initialize services
		const authService = new AuthService(env);
		const proxyService = new ProxyService(env);
		const pricingService = new PricingService(env);
		const usageService = new UsageService(env);
		const agentService = new AgentService(env);

		// Validate API key
		const authResult = await authService.validateApiKey(request);
		if (!authResult.success) {
			return createErrorResponse(401, 'Unauthorized', authResult.error || 'Invalid API key');
		}

		// Parse and validate request body
		let requestBody: ElizaChatCompletionRequest;
		try {
			requestBody = await request.json() as ElizaChatCompletionRequest;
		} catch (error) {
			return createErrorResponse(400, 'Bad Request', 'Invalid JSON body');
		}

		const validation = proxyService.validateChatRequest(requestBody);
		if (!validation.valid) {
			return createErrorResponse(400, 'Bad Request', validation.error || 'Invalid request');
		}

		// Initialize agent runtime
		await agentService.initialize();

		// Extract session and user information
		const sessionId = usageService.extractSessionId(request) || 'default-session';
		const userId = authResult.keyId; // Use API key ID as user identifier

		// Get user message from request
		const userMessage = requestBody.messages?.length > 0
			? (typeof requestBody.messages[0].content === 'string'
				? requestBody.messages[0].content
				: JSON.stringify(requestBody.messages[0].content))
			: 'Hello';

		// Process message through ElizaOS agent
		const agentResponse = await agentService.processMessage(userMessage, sessionId, userId ?? 'anonymous');

		// Convert agent response to ElizaOS Cloud API format
		const elizaResponse = {
			id: agentResponse.id,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: agentResponse.model,
			provider: 'eliza-sandbox-agent',
			choices: [{
				index: 0,
				message: {
					role: 'assistant',
					content: agentResponse.text,
					tool_calls: [],
				},
				finish_reason: 'stop',
			}],
			usage: {
				prompt_tokens: agentResponse.usage.prompt_tokens,
				completion_tokens: agentResponse.usage.completion_tokens,
				total_tokens: agentResponse.usage.total_tokens,
				prompt_cost: 0, // Will be calculated by pricing service
				completion_cost: 0, // Will be calculated by pricing service
				total_cost: 0, // Will be calculated by pricing service
			},
		};

		// Calculate sandbox fee based on agent response
		const feeCalculation = await pricingService.calculateSandboxFee(
			elizaResponse.model,
			elizaResponse.usage.prompt_tokens,
			elizaResponse.usage.completion_tokens
		);

		// Update usage costs in response
		elizaResponse.usage.prompt_cost = feeCalculation.base_cost_usd * (agentResponse.usage.prompt_tokens / agentResponse.usage.total_tokens);
		elizaResponse.usage.completion_cost = feeCalculation.base_cost_usd * (agentResponse.usage.completion_tokens / agentResponse.usage.total_tokens);
		elizaResponse.usage.total_cost = feeCalculation.total_cost_usd;

		// Record usage (non-blocking)
		const metadata = usageService.createMetadata(request);

		ctx.waitUntil(
			usageService.recordUsage(
				authResult.keyId!,
				sessionId,
				elizaResponse.model,
				elizaResponse.usage,
				feeCalculation,
				elizaResponse.id,
				metadata
			)
		);

		// Return response with sandbox fee headers
		return proxyService.createResponseWithHeaders(
			elizaResponse,
			feeCalculation,
			elizaResponse.id
		);
	} catch (error) {
		console.error('Agent chat error:', error);

		// Handle specific error types
		if (error instanceof Error) {
			if (error.message.includes('ElizaOS Cloud API error')) {
				return createErrorResponse(502, 'Bad Gateway', 'Upstream API error');
			}
			if (error.message.includes('Failed to proxy request')) {
				return createErrorResponse(503, 'Service Unavailable', 'Unable to reach upstream API');
			}
		}

		return createErrorResponse(500, 'Internal Server Error', 'Request processing failed');
	}
}

/**
 * Handle Telegram bot start endpoint
 */
async function handleTelegramStart(request: Request, env: Env): Promise<Response> {
	try {
		if (request.method !== 'POST') {
			return createErrorResponse(405, 'Method Not Allowed', 'Only POST requests are allowed');
		}

		// Validate API key
		const authService = new AuthService(env);
		const authResult = await authService.validateApiKey(request);
		if (!authResult.success) {
			return createErrorResponse(401, 'Unauthorized', authResult.error || 'Invalid API key');
		}

		// Parse request body for Telegram bot token
		let requestBody: { telegramBotToken: string };
		try {
			requestBody = await request.json() as { telegramBotToken: string };
		} catch (error) {
			return createErrorResponse(400, 'Bad Request', 'Invalid JSON body. Expected: {"telegramBotToken": "..."}');
		}

		if (!requestBody.telegramBotToken) {
			return createErrorResponse(400, 'Bad Request', 'telegramBotToken is required');
		}

		// Initialize and start Telegram runtime
		const telegramRuntime = ElizaTelegramRuntime.getInstance();

		await telegramRuntime.initialize({
			env,
			telegramBotToken: requestBody.telegramBotToken,
		});

		await telegramRuntime.start();

		// Add token to my-project/.env for persistence
		await ElizaTelegramRuntime.ensureTelegramToken(env, requestBody.telegramBotToken);

		return new Response(JSON.stringify({
			success: true,
			message: 'ElizaOS Telegram bot started successfully',
			status: telegramRuntime.getStatus(),
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

	} catch (error: any) {
		console.error('Telegram start error:', error);
		return createErrorResponse(500, 'Internal Server Error', error.message || 'Failed to start Telegram bot');
	}
}

/**
 * Handle Telegram bot stop endpoint
 */
async function handleTelegramStop(request: Request, env: Env): Promise<Response> {
	try {
		if (request.method !== 'POST') {
			return createErrorResponse(405, 'Method Not Allowed', 'Only POST requests are allowed');
		}

		// Validate API key
		const authService = new AuthService(env);
		const authResult = await authService.validateApiKey(request);
		if (!authResult.success) {
			return createErrorResponse(401, 'Unauthorized', authResult.error || 'Invalid API key');
		}

		// Stop Telegram runtime
		const telegramRuntime = ElizaTelegramRuntime.getInstance();
		await telegramRuntime.stop();

		return new Response(JSON.stringify({
			success: true,
			message: 'ElizaOS Telegram bot stopped successfully',
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

	} catch (error: any) {
		console.error('Telegram stop error:', error);
		return createErrorResponse(500, 'Internal Server Error', error.message || 'Failed to stop Telegram bot');
	}
}

/**
 * Handle Telegram status endpoint
 */
async function handleTelegramStatus(env: Env): Promise<Response> {
	try {
		const telegramRuntime = ElizaTelegramRuntime.getInstance();
		const status = telegramRuntime.getStatus();
		const healthCheck = await telegramRuntime.healthCheck();

		return new Response(JSON.stringify({
			status,
			health: healthCheck,
			instructions: {
				start: 'POST /telegram/start with {"telegramBotToken": "your-token"}',
				stop: 'POST /telegram/stop',
				status: 'GET /telegram/status',
				test: 'POST /telegram/test with {"telegramBotToken": "your-token"}',
			},
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

	} catch (error: any) {
		console.error('Telegram status error:', error);
		return createErrorResponse(500, 'Internal Server Error', error.message || 'Failed to get Telegram status');
	}
}

/**
 * Handle Telegram test endpoint - comprehensive testing without full initialization
 */
async function handleTelegramTest(request: Request, env: Env): Promise<Response> {
	try {
		if (request.method !== 'POST') {
			return createErrorResponse(405, 'Method Not Allowed', 'Only POST requests are allowed');
		}

		// Parse request body for Telegram bot token
		let requestBody: { telegramBotToken: string };
		try {
			requestBody = await request.json() as { telegramBotToken: string };
		} catch (error) {
			return createErrorResponse(400, 'Bad Request', 'Invalid JSON body. Expected: {"telegramBotToken": "..."}');
		}

		if (!requestBody.telegramBotToken) {
			return createErrorResponse(400, 'Bad Request', 'telegramBotToken is required');
		}

		console.log('🧪 Running comprehensive Telegram integration tests...');

		// Run all tests
		const setupTest = await testTelegramSetup(env, requestBody.telegramBotToken);
		const tokenTest = await testTelegramBotToken(requestBody.telegramBotToken);

		const allTestsResults = {
			setupTest,
			tokenTest,
			overall: {
				success: setupTest.success && tokenTest.valid,
				readyForDeployment: setupTest.success && tokenTest.valid,
				nextSteps: setupTest.success && tokenTest.valid
					? ['Deploy to Cloudflare Workers', 'Initialize ElizaOS runtime', 'Start Telegram bot']
					: ['Fix configuration issues', 'Retry tests'],
			},
		};

		return new Response(JSON.stringify({
			success: allTestsResults.overall.success,
			message: allTestsResults.overall.success
				? '🎉 All tests passed! Ready for ElizaOS Telegram integration'
				: '❌ Some tests failed. Check details for issues.',
			results: allTestsResults,
			timestamp: new Date().toISOString(),
		}), {
			status: allTestsResults.overall.success ? 200 : 400,
			headers: { 'Content-Type': 'application/json' },
		});

	} catch (error: any) {
		console.error('Telegram test error:', error);
		return createErrorResponse(500, 'Internal Server Error', error.message || 'Failed to run Telegram tests');
	}
}

/**
 * Handle Telegram webhook - process incoming messages
 */
async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
	try {
		if (request.method !== 'POST') {
			return createErrorResponse(405, 'Method Not Allowed', 'Only POST requests are allowed');
		}

		console.log('📨 Received Telegram webhook');

		// Parse Telegram update
		let update: any;
		try {
			update = await request.json();
		} catch (error) {
			console.error('Failed to parse webhook JSON:', error);
			return new Response('OK', { status: 200 }); // Always return 200 to Telegram
		}

		console.log('📋 Telegram update:', JSON.stringify(update, null, 2));

		// Extract message
		const message = update.message;
		if (!message || !message.text) {
			console.log('⚠️  No text message found in update');
			return new Response('OK', { status: 200 });
		}

		const chatId = message.chat.id;
		const userMessage = message.text;
		const userId = message.from.id.toString();

		console.log(`👤 User ${userId} in chat ${chatId}: "${userMessage}"`);

		// Initialize Telegram runtime if not already done
		const telegramRuntime = ElizaTelegramRuntime.getInstance();
		if (!telegramRuntime.getRuntime()) {
			console.log('🔄 Initializing Telegram runtime for webhook...');
			try {
				await telegramRuntime.initialize({
					env,
					telegramBotToken: env.TELEGRAM_BOT_TOKEN || '8376370504:AAHKBNlBUdhjwpIFYap5ddNGHMsCYCvFauc',
				});
				console.log('✅ Telegram runtime initialized for webhook');
			} catch (error) {
				console.error('❌ Failed to initialize runtime in webhook:', error);
				// Continue anyway - AgentService has its own initialization
			}
		}

		// Process message through agent service
		const agentService = new AgentService(env);
		await agentService.initialize();

		const sessionId = `tg-${chatId}`;
		console.log(`🔄 Processing message through ElizaOS agent...`);

		const agentResponse = await agentService.processMessage(userMessage, sessionId, userId);

		console.log('🤖 Agent response:', agentResponse);

		// Send response back to Telegram
		const telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				chat_id: chatId,
				text: agentResponse.text,
				parse_mode: 'Markdown'
			}),
		});

		const telegramResult = await telegramResponse.json();
		console.log('📤 Telegram API response:', telegramResult);

		if (!telegramResponse.ok) {
			console.error('❌ Failed to send message to Telegram:', telegramResult);
		} else {
			console.log('✅ Message sent successfully to Telegram');
		}

		// Always return 200 to Telegram
		return new Response('OK', { status: 200 });

	} catch (error: any) {
		console.error('❌ Webhook error:', error);
		// Always return 200 to Telegram to avoid retries
		return new Response('OK', { status: 200 });
	}
}

/**
 * Create standardized error response
 */
function createErrorResponse(status: number, error: string, message: string): Response {
	const errorResponse: ErrorResponse = {
		error: {
			message,
			type: error.toLowerCase().replace(/\s+/g, '_'),
			code: status.toString(),
		},
	};

	return new Response(JSON.stringify(errorResponse), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}