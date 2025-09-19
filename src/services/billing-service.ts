import { v4 as uuidv4 } from 'uuid';
import { Env, ElizaUsage, UsageEvent, SandboxFeeCalculation } from '../types';

export interface BillingContext {
  sessionId: string;
  userId: string;
  chatId: string;
  message: string;
  timestamp: number;
}

export interface BillingResult {
  requestId: string;
  baseCost: number;
  sandboxFee: number;
  totalCost: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export class BillingService {
  constructor(
    private env: Env,
    private keyId: string
  ) {}

  /**
   * Calculate sandbox fees based on ElizaOS usage
   */
  calculateSandboxFee(baseCostUsd: number): SandboxFeeCalculation {
    const feeRate = parseFloat(this.env.SANDBOX_FEE_RATE || '0.20'); // 20% default
    const platformFee = baseCostUsd * feeRate;
    const totalCost = baseCostUsd + platformFee;

    return {
      base_cost_usd: baseCostUsd,
      platform_fee_usd: platformFee,
      total_cost_usd: totalCost,
    };
  }

  /**
   * Track message processing with billing
   */
  async trackMessageProcessing(
    context: BillingContext,
    usage: ElizaUsage,
    model: string = 'eliza-agent'
  ): Promise<BillingResult> {
    const requestId = uuidv4();
    const baseCost = usage.total_cost;
    const feeCalculation = this.calculateSandboxFee(baseCost);

    // Store usage event in D1 database
    await this.logUsageEvent({
      id: requestId,
      ts: context.timestamp,
      cloud_key_id: this.keyId,
      session_id: context.sessionId,
      model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      base_cost_usd: feeCalculation.base_cost_usd,
      platform_fee_usd: feeCalculation.platform_fee_usd,
      total_cost_usd: feeCalculation.total_cost_usd,
      request_id: requestId,
      meta: JSON.stringify({
        userId: context.userId,
        chatId: context.chatId,
        messageLength: context.message.length,
        source: 'telegram-plugin',
      }),
    });

    return {
      requestId,
      baseCost: feeCalculation.base_cost_usd,
      sandboxFee: feeCalculation.platform_fee_usd,
      totalCost: feeCalculation.total_cost_usd,
      tokens: {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      },
    };
  }

  /**
   * Store usage event in D1 database
   */
  private async logUsageEvent(event: UsageEvent): Promise<void> {
    try {
      const stmt = this.env.USAGE_DB.prepare(`
        INSERT INTO usage_events (
          id, ts, cloud_key_id, session_id, model,
          prompt_tokens, completion_tokens,
          base_cost_usd, platform_fee_usd, total_cost_usd,
          request_id, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      await stmt
        .bind(
          event.id,
          event.ts,
          event.cloud_key_id,
          event.session_id,
          event.model,
          event.prompt_tokens,
          event.completion_tokens,
          event.base_cost_usd,
          event.platform_fee_usd,
          event.total_cost_usd,
          event.request_id,
          event.meta
        )
        .run();

      console.log('📊 Usage event logged:', {
        requestId: event.request_id,
        sessionId: event.session_id?.slice(-8),
        tokens: event.prompt_tokens && event.completion_tokens ?
          event.prompt_tokens + event.completion_tokens : 0,
        cost: `$${event.total_cost_usd?.toFixed(6)}`,
      });
    } catch (error) {
      console.error('❌ Failed to log usage event:', error);
      throw error;
    }
  }

  /**
   * Get usage statistics for a session
   */
  async getSessionStats(sessionId: string): Promise<{
    totalMessages: number;
    totalCost: number;
    totalTokens: number;
  }> {
    try {
      const result = await this.env.USAGE_DB.prepare(`
        SELECT
          COUNT(*) as total_messages,
          COALESCE(SUM(total_cost_usd), 0) as total_cost,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens
        FROM usage_events
        WHERE session_id = ? AND cloud_key_id = ?
      `).bind(sessionId, this.keyId).first();

      return {
        totalMessages: Number(result?.total_messages) || 0,
        totalCost: Number(result?.total_cost) || 0,
        totalTokens: Number(result?.total_tokens) || 0,
      };
    } catch (error) {
      console.error('❌ Failed to get session stats:', error);
      return {
        totalMessages: 0,
        totalCost: 0,
        totalTokens: 0,
      };
    }
  }

  /**
   * Create billing context from Telegram message
   */
  static createBillingContext(
    message: string,
    userId: string | number,
    chatId: string | number,
    sessionId?: string
  ): BillingContext {
    return {
      sessionId: sessionId || `tg-${chatId}-${userId}`,
      userId: userId.toString(),
      chatId: chatId.toString(),
      message,
      timestamp: Date.now(),
    };
  }
}