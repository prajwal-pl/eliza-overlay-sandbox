import type {
  Env,
  ElizaChatCompletionRequest,
  ElizaChatCompletionResponse,
  SandboxFeeCalculation
} from '../types';

export class ProxyService {
  constructor(private env: Env) {}

  /**
   * Forward request to ElizaOS Cloud API
   */
  async forwardRequest(
    request: Request,
    body: ElizaChatCompletionRequest,
    validatedApiKey: string
  ): Promise<ElizaChatCompletionResponse> {
    const elizaUrl = `${this.env.ELIZA_BASE_URL}/chat/completions`;

    // Forward headers with validated API key as Bearer token
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${validatedApiKey}`);
    headers.set('User-Agent', 'ElizaOverlaySandbox/1.0');

    // Add any additional headers that might be relevant
    const relevantHeaders = ['X-Eliza-Cloud-Key', 'X-Request-ID'];
    relevantHeaders.forEach(headerName => {
      const value = request.headers.get(headerName);
      if (value) {
        headers.set(headerName, value);
      }
    });

    try {
      const response = await fetch(elizaUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`ElizaOS Cloud API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as ElizaChatCompletionResponse;
      return data;
    } catch (error) {
      console.error('Proxy request failed:', error);
      throw new Error(`Failed to proxy request: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create response with sandbox fee headers
   */
  createResponseWithHeaders(
    elizaResponse: ElizaChatCompletionResponse,
    feeCalculation: SandboxFeeCalculation,
    requestId?: string
  ): Response {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');

    // CORS headers
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Eliza-Cloud-Key');
    headers.set('Access-Control-Expose-Headers', 'X-Eliza-Sandbox-Base-Cost-USD, X-Eliza-Sandbox-Fee-USD, X-Eliza-Sandbox-Total-USD, X-Eliza-Cloud-Request-Id');

    // Sandbox fee headers
    headers.set('X-Eliza-Sandbox-Base-Cost-USD', feeCalculation.base_cost_usd.toString());
    headers.set('X-Eliza-Sandbox-Fee-USD', feeCalculation.platform_fee_usd.toString());
    headers.set('X-Eliza-Sandbox-Total-USD', feeCalculation.total_cost_usd.toString());

    // Request ID header
    if (requestId || elizaResponse.id) {
      headers.set('X-Eliza-Cloud-Request-Id', requestId || elizaResponse.id);
    }

    return new Response(JSON.stringify(elizaResponse), {
      status: 200,
      headers,
    });
  }

  /**
   * Validate chat completion request body
   */
  validateChatRequest(body: any): { valid: boolean; error?: string } {
    if (!body || typeof body !== 'object') {
      return { valid: false, error: 'Request body must be a JSON object' };
    }

    if (!body.model || typeof body.model !== 'string') {
      return { valid: false, error: 'Missing or invalid model field' };
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return { valid: false, error: 'Messages must be a non-empty array' };
    }

    // Validate message structure
    for (const message of body.messages) {
      if (!message.role || !message.content) {
        return { valid: false, error: 'Each message must have role and content fields' };
      }
    }

    return { valid: true };
  }
}