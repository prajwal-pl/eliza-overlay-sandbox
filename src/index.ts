import type { Env, ElizaChatCompletionRequest, ErrorResponse } from './types';
import { AuthService } from './services/auth';
import { ProxyService } from './services/proxy';
import { PricingService } from './services/pricing';
import { UsageService } from './services/usage';

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

		// Forward request to ElizaOS Cloud with validated API key
		const elizaResponse = await proxyService.forwardRequest(request, requestBody, authResult.apiKey!);

		// Calculate sandbox fee
		const feeCalculation = await pricingService.calculateSandboxFee(
			elizaResponse.model,
			elizaResponse.usage.prompt_tokens,
			elizaResponse.usage.completion_tokens
		);

		// Record usage (non-blocking)
		const sessionId = usageService.extractSessionId(request);
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