import type { Env, ElizaChatCompletionRequest, ErrorResponse, AgentResponse } from './types';
import { AuthService } from './services/auth';
import { ProxyService } from './services/proxy';
import { PricingService } from './services/pricing';
import { UsageService } from './services/usage';
import { AgentService } from './services/agent';

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
					return handleHealth();

				case '/agent/chat':
					return handleAgentChat(request, env, ctx);

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
function handleHealth(): Response {
	return new Response(JSON.stringify({ status: 'ok', service: 'eliza-overlay-sandbox' }), {
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
		const sessionId = usageService.extractSessionId(request);
		const userId = authResult.keyId; // Use API key ID as user identifier

		// Get user message from request
		const userMessage = requestBody.messages?.length > 0
			? (typeof requestBody.messages[0].content === 'string'
				? requestBody.messages[0].content
				: JSON.stringify(requestBody.messages[0].content))
			: 'Hello';

		// Process message through ElizaOS agent
		const agentResponse = await agentService.processMessage(userMessage, sessionId, userId);

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