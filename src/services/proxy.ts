import type {
  Env,
  ElizaChatCompletionRequest,
  ElizaChatCompletionResponse,
  SandboxFeeCalculation
} from '../types';
import { createJsonResponseWithCors } from '../utils/cors';

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
   * Create response with sandbox fee headers and CORS support
   */
  createResponseWithHeaders(
    elizaResponse: ElizaChatCompletionResponse,
    feeCalculation: SandboxFeeCalculation,
    requestId?: string
  ): Response {
    // Prepare sandbox fee headers
    const customHeaders: Record<string, string> = {
      'X-Eliza-Sandbox-Base-Cost-USD': feeCalculation.base_cost_usd.toString(),
      'X-Eliza-Sandbox-Fee-USD': feeCalculation.platform_fee_usd.toString(),
      'X-Eliza-Sandbox-Total-USD': feeCalculation.total_cost_usd.toString(),
    };

    // Add request ID header if available
    if (requestId || elizaResponse.id) {
      customHeaders['X-Eliza-Cloud-Request-Id'] = requestId || elizaResponse.id;
    }

    return createJsonResponseWithCors(
      elizaResponse,
      {
        status: 200,
        headers: customHeaders
      }
    );
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