import type { Env, UsageEvent, ElizaUsage, SandboxFeeCalculation } from '../types';

export class UsageService {
  constructor(private env: Env) {}

  /**
   * Record usage event to D1
   */
  async recordUsage(
    keyId: string,
    sessionId: string | null,
    model: string,
    usage: ElizaUsage,
    feeCalculation: SandboxFeeCalculation,
    requestId: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    try {
      const usageEvent: Partial<UsageEvent> = {
        id: requestId,
        ts: Math.floor(Date.now() / 1000),
        cloud_key_id: keyId,
        session_id: sessionId,
        model: model,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        base_cost_usd: feeCalculation.base_cost_usd,
        platform_fee_usd: feeCalculation.platform_fee_usd,
        total_cost_usd: feeCalculation.total_cost_usd,
        request_id: requestId,
        meta: metadata ? JSON.stringify(metadata) : null,
      };

      // Insert into D1
      const result = await this.env.USAGE_DB
        .prepare(`
          INSERT INTO usage_events (
            id, ts, cloud_key_id, session_id, model,
            prompt_tokens, completion_tokens,
            base_cost_usd, platform_fee_usd, total_cost_usd,
            request_id, meta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          usageEvent.id,
          usageEvent.ts,
          usageEvent.cloud_key_id,
          usageEvent.session_id,
          usageEvent.model,
          usageEvent.prompt_tokens,
          usageEvent.completion_tokens,
          usageEvent.base_cost_usd,
          usageEvent.platform_fee_usd,
          usageEvent.total_cost_usd,
          usageEvent.request_id,
          usageEvent.meta
        )
        .run();

      console.log('Usage event recorded successfully:', result.success);
    } catch (error) {
      console.error('Usage recording setup error:', error);
    }
  }

  /**
   * Extract session ID from request URL
   */
  extractSessionId(request: Request): string | null {
    try {
      const url = new URL(request.url);
      return url.searchParams.get('session');
    } catch {
      return null;
    }
  }

  /**
   * Create request metadata for tracking
   */
  createMetadata(request: Request): Record<string, any> {
    return {
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      userAgent: request.headers.get('User-Agent') || 'unknown',
      country: request.headers.get('CF-IPCountry') || 'unknown',
      timestamp: new Date().toISOString(),
    };
  }
}