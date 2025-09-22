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
			switch (true) {
				case path === '/health':
					return handleHealth(env);

				case path === '/agent/chat':
					return handleAgentChat(request, env, ctx);

				case path === '/telegram/start':
					return handleTelegramStart(request, env);

				case path === '/telegram/stop':
					return handleTelegramStop(request, env);

				case path === '/telegram/status':
					return handleTelegramStatus(env);

				case path === '/telegram/test':
					return handleTelegramTest(request, env);

				case path === '/webhook/telegram':
					return handleTelegramWebhook(request, env);

				// ElizaOS API endpoints
				case path.startsWith('/api/'):
					return handleElizaOSAPI(request, env, ctx);

				default:
					// Serve frontend for all other paths
					return handleFrontendServing(request, env);
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
 * Split long text into chunks that fit within Telegram's message limit
 */
function splitTelegramMessage(text: string, maxLength: number = 4000): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const chunks: string[] = [];
	let currentChunk = '';

	// Split by paragraphs first (double newlines)
	const paragraphs = text.split('\n\n');

	for (const paragraph of paragraphs) {
		// If adding this paragraph would exceed the limit
		if (currentChunk.length + paragraph.length + 2 > maxLength) {
			// If current chunk has content, save it
			if (currentChunk.trim()) {
				chunks.push(currentChunk.trim());
				currentChunk = '';
			}

			// If the paragraph itself is too long, split by sentences
			if (paragraph.length > maxLength) {
				const sentences = paragraph.split(/[.!?]\s+/);
				for (const sentence of sentences) {
					const sentenceWithPunctuation = sentence.includes('.') || sentence.includes('!') || sentence.includes('?')
						? sentence
						: sentence + '.';

					if (currentChunk.length + sentenceWithPunctuation.length + 1 > maxLength) {
						if (currentChunk.trim()) {
							chunks.push(currentChunk.trim());
							currentChunk = '';
						}

						// If even a single sentence is too long, split by words
						if (sentenceWithPunctuation.length > maxLength) {
							const words = sentenceWithPunctuation.split(' ');
							for (const word of words) {
								if (currentChunk.length + word.length + 1 > maxLength) {
									if (currentChunk.trim()) {
										chunks.push(currentChunk.trim());
										currentChunk = '';
									}
								}
								currentChunk += (currentChunk ? ' ' : '') + word;
							}
						} else {
							currentChunk = sentenceWithPunctuation;
						}
					} else {
						currentChunk += (currentChunk ? ' ' : '') + sentenceWithPunctuation;
					}
				}
			} else {
				currentChunk = paragraph;
			}
		} else {
			currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
		}
	}

	// Add any remaining content
	if (currentChunk.trim()) {
		chunks.push(currentChunk.trim());
	}

	return chunks.filter(chunk => chunk.trim().length > 0);
}

/**
 * Send a message to Telegram, splitting it into multiple messages if too long
 */
async function sendTelegramMessage(
	chatId: number,
	text: string,
	telegramBotToken: string
): Promise<{ success: boolean; error?: string }> {
	const chunks = splitTelegramMessage(text);

	console.log(`📝 Splitting message into ${chunks.length} chunks`);

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const isLastChunk = i === chunks.length - 1;

		// Add part indicator for multi-part messages
		const messageText = chunks.length > 1
			? `${chunk}\n\n${isLastChunk ? '✅ End' : `(${i + 1}/${chunks.length})`}`
			: chunk;

		console.log(`📤 Sending chunk ${i + 1}/${chunks.length} (${messageText.length} chars)`);

		try {
			const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					chat_id: chatId,
					text: messageText,
					parse_mode: 'Markdown'
				}),
			});

			const result = await response.json();

			if (!response.ok) {
				console.error(`❌ Failed to send chunk ${i + 1}:`, result);
				return { success: false, error: result.description || 'Failed to send message chunk' };
			}

			console.log(`✅ Chunk ${i + 1} sent successfully`);

			// Small delay between messages to avoid rate limiting
			if (i < chunks.length - 1) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}

		} catch (error) {
			console.error(`❌ Error sending chunk ${i + 1}:`, error);
			return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
		}
	}

	return { success: true };
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
		console.log(`📏 Response length: ${agentResponse.text.length} characters`);

		// Send response back to Telegram with message splitting
		const telegramBotToken = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '8376370504:AAHKBNlBUdhjwpIFYap5ddNGHMsCYCvFauc';
		const sendResult = await sendTelegramMessage(chatId, agentResponse.text, telegramBotToken);

		if (!sendResult.success) {
			console.error('❌ Failed to send message to Telegram:', sendResult.error);
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
 * Handle ElizaOS API endpoints
 */
async function handleElizaOSAPI(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// Initialize services
		const agentService = new AgentService(env);
		await agentService.initialize();

		console.log(`🔗 ElizaOS API: ${method} ${path}`);

		// Parse path segments
		const pathParts = path.split('/').filter(p => p !== '' && p !== 'api');
		const [module, ...rest] = pathParts;

		switch (module) {
			case 'server':
				return handleServerAPI(rest, method, request, env);

			case 'agents':
				return handleAgentsAPI(rest, method, request, env, agentService);

			case 'messaging':
				return handleMessagingAPI(rest, method, request, env, agentService);

			case 'memory':
				return handleMemoryAPI(rest, method, request, env, agentService);

			case 'audio':
				return handleAudioAPI(rest, method, request, env, agentService);

			case 'media':
				return handleMediaAPI(rest, method, request, env);

			case 'system':
				return handleSystemAPI(rest, method, request, env);

			default:
				return createElizaResponse(404, false, null, 'API endpoint not found');
		}
	} catch (error) {
		console.error('ElizaOS API error:', error);
		return createElizaResponse(500, false, null, 'Internal server error');
	}
}

/**
 * Handle Server API endpoints
 */
async function handleServerAPI(pathParts: string[], method: string, request: Request, env: Env): Promise<Response> {
	const [endpoint] = pathParts;

	switch (endpoint) {
		case 'ping':
			if (method === 'GET') {
				return createElizaResponse(200, true, {
					pong: true,
					timestamp: Date.now()
				});
			}
			break;

		case 'status':
			if (method === 'GET') {
				return createElizaResponse(200, true, {
					status: 'ok',
					agentCount: 1, // We have one agent running
					timestamp: new Date().toISOString()
				});
			}
			break;

		case 'health':
			if (method === 'GET') {
				return createElizaResponse(200, true, {
					status: 'OK',
					version: '1.5.10',
					timestamp: new Date().toISOString(),
					dependencies: {
						agents: 'healthy'
					}
				});
			}
			break;

		case 'hello':
			if (method === 'GET') {
				return createElizaResponse(200, true, {
					message: 'Hello from ElizaOS!',
					timestamp: new Date().toISOString()
				});
			}
			break;
	}

	return createElizaResponse(404, false, null, 'Server endpoint not found');
}

/**
 * Handle Agents API endpoints
 */
async function handleAgentsAPI(pathParts: string[], method: string, request: Request, env: Env, agentService: AgentService): Promise<Response> {
	if (pathParts.length === 0) {
		// GET /api/agents - List all agents
		if (method === 'GET') {
			return createElizaResponse(200, true, {
				agents: [{
					id: 'eliza-overlay-agent',
					name: 'Eliza (ElizaOS)',
					characterName: 'Eliza (ElizaOS)',
					bio: 'ElizaOS agent running in Cloudflare Workers',
					status: 'active'
				}]
			});
		}
	}

	const [agentId, submodule, ...subParts] = pathParts;

	if (agentId && !submodule) {
		// GET /api/agents/:agentId - Get specific agent
		if (method === 'GET') {
			return createElizaResponse(200, true, {
				id: agentId,
				enabled: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				name: 'Eliza (ElizaOS)',
				username: 'eliza',
				system: 'ElizaOS agent running in Cloudflare Workers environment',
				bio: ['ElizaOS agent', 'Running in Cloudflare Workers', 'Provides AI assistance'],
				messageExamples: [],
				postExamples: [],
				topics: ['general assistance', 'AI conversation'],
				adjectives: [],
				knowledge: [],
				plugins: ['@elizaos/plugin-bootstrap', '@elizaos/plugin-sql'],
				settings: {
					avatar: 'https://elizaos.github.io/eliza-avatars/Eliza/portrait.png',
					secrets: {}
				},
				style: {
					all: ['Be helpful and conversational'],
					chat: ['Engage naturally'],
					post: ['Share insights']
				},
				status: 'active'
			});
		}
	}

	if (submodule === 'rooms') {
		// GET /api/agents/:agentId/rooms - Get agent rooms
		if (method === 'GET') {
			return createElizaResponse(200, true, {
				rooms: [{
					id: 'default-room',
					agentId: agentId,
					source: 'cloudflare_worker',
					type: 'GROUP',
					serverId: '00000000-0000-0000-0000-000000000000',
					worldId: 'default-world',
					name: 'Default Chat Room',
					metadata: null,
					channelId: 'default-channel',
					createdAt: new Date().toISOString()
				}]
			});
		}
	}

	return createElizaResponse(404, false, null, 'Agent endpoint not found');
}

/**
 * Handle Messaging API endpoints
 */
async function handleMessagingAPI(pathParts: string[], method: string, request: Request, env: Env, agentService: AgentService): Promise<Response> {
	const [submodule, ...rest] = pathParts;

	switch (submodule) {
		case 'central-servers':
			if (method === 'GET') {
				return createElizaResponse(200, true, {
					servers: [{
						id: '00000000-0000-0000-0000-000000000000',
						name: 'Default Server',
						sourceType: 'cloudflare_worker',
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}]
				});
			}
			break;

		case 'submit':
			if (method === 'POST') {
				// Handle message submission
				const body = await request.json();
				const { text, agentId, roomId, userId } = body;

				if (!text) {
					return createElizaResponse(400, false, null, 'Message text is required');
				}

				try {
					const sessionId = roomId || 'default-session';
					const response = await agentService.processMessage(text, sessionId, userId || 'anonymous');

					return createElizaResponse(200, true, {
						id: response.id,
						content: response.text,
						agentId: agentId || 'eliza-overlay-agent',
						roomId: sessionId,
						timestamp: new Date().toISOString()
					});
				} catch (error) {
					console.error('Message processing error:', error);
					return createElizaResponse(500, false, null, 'Failed to process message');
				}
			}
			break;
	}

	// Handle central-servers/:serverId/channels
	if (pathParts[0] === 'central-servers' && pathParts[2] === 'channels') {
		if (method === 'GET') {
			return createElizaResponse(200, true, {
				channels: [{
					id: 'default-channel',
					messageServerId: '00000000-0000-0000-0000-000000000000',
					name: 'Default Channel',
					type: 'GROUP',
					metadata: {
						forAgent: 'eliza-overlay-agent',
						createdAt: new Date().toISOString()
					},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				}]
			});
		}
	}

	return createElizaResponse(404, false, null, 'Messaging endpoint not found');
}

/**
 * Handle Memory API endpoints
 */
async function handleMemoryAPI(pathParts: string[], method: string, request: Request, env: Env, agentService: AgentService): Promise<Response> {
	return createElizaResponse(200, true, { memories: [] });
}

/**
 * Handle Audio API endpoints
 */
async function handleAudioAPI(pathParts: string[], method: string, request: Request, env: Env, agentService: AgentService): Promise<Response> {
	return createElizaResponse(501, false, null, 'Audio API not implemented in this environment');
}

/**
 * Handle Media API endpoints
 */
async function handleMediaAPI(pathParts: string[], method: string, request: Request, env: Env): Promise<Response> {
	return createElizaResponse(501, false, null, 'Media API not implemented in this environment');
}

/**
 * Handle System API endpoints
 */
async function handleSystemAPI(pathParts: string[], method: string, request: Request, env: Env): Promise<Response> {
	const [endpoint] = pathParts;

	if (endpoint === 'version' && method === 'GET') {
		return createElizaResponse(200, true, {
			version: '1.5.10',
			environment: 'cloudflare-worker',
			timestamp: new Date().toISOString()
		});
	}

	return createElizaResponse(404, false, null, 'System endpoint not found');
}

/**
 * Create standardized ElizaOS API response
 */
function createElizaResponse(status: number, success: boolean, data: any = null, error: string | null = null): Response {
	const responseBody = success
		? { success: true, data }
		: { success: false, error };

	return new Response(JSON.stringify(responseBody), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-KEY'
		}
	});
}

/**
 * Handle frontend serving with dynamic configuration injection
 */
async function handleFrontendServing(request: Request, env: Env): Promise<Response> {
	try {
		const url = new URL(request.url);

		// For the root path, serve index.html with injected configuration
		if (url.pathname === '/' || url.pathname === '/index.html') {
			return serveFrontendWithConfig(env);
		}

		// For all other paths, try to serve static assets
		if (env.ASSETS) {
			const assetResponse = await env.ASSETS.fetch(request);
			if (assetResponse.status !== 404) {
				return assetResponse;
			}
		}

		// If asset not found, serve index.html for SPA routing
		return serveFrontendWithConfig(env);
	} catch (error) {
		console.error('Frontend serving error:', error);
		return createErrorResponse(500, 'Internal Server Error', 'Failed to serve frontend');
	}
}

/**
 * Serve frontend index.html with injected ElizaOS configuration
 */
async function serveFrontendWithConfig(env: Env): Promise<Response> {
	try {
		let htmlResponse;

		// Try to fetch from assets first
		if (env.ASSETS) {
			htmlResponse = await env.ASSETS.fetch('/index.html');
		}

		// If no assets or not found, create a basic HTML response
		if (!htmlResponse || htmlResponse.status === 404) {
			const fallbackHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ElizaOS Agent Interface</title>
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
</body>
</html>`;

			htmlResponse = new Response(fallbackHtml, {
				headers: { 'Content-Type': 'text/html' }
			});
		}

		let htmlText = await htmlResponse.text();

		// Inject ElizaOS configuration
		const config = {
			agentId: env.AGENT_ID || 'eliza-overlay-agent',
			apiBase: env.ELIZAOS_BASE_URL || 'https://eliza-cloud-private-production.up.railway.app/api/v1',
			environment: 'production',
			workerUrl: new URL(request.url).origin
		};

		// Inject config script before any existing scripts
		htmlText = htmlText.replace(
			'<script',
			`<script>
				window.ELIZA_CONFIG = ${JSON.stringify(config)};
				console.log('ElizaOS Config loaded:', window.ELIZA_CONFIG);
			</script>
			<script`
		);

		return new Response(htmlText, {
			headers: {
				'Content-Type': 'text/html',
				'Cache-Control': 'no-cache'
			}
		});
	} catch (error) {
		console.error('Config injection error:', error);
		return createErrorResponse(500, 'Internal Server Error', 'Failed to serve frontend with config');
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