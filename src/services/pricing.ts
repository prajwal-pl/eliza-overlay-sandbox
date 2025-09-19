import type { Env, PricingData, ModelPricing, SandboxFeeCalculation } from '../types';

export class PricingService {
  private pricingCache: PricingData | null = null;
  private cacheExpiry = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private env: Env) {}

  /**
   * Calculate sandbox fee based on usage and model
   */
  async calculateSandboxFee(
    model: string,
    promptTokens: number,
    completionTokens: number
  ): Promise<SandboxFeeCalculation> {
    try {
      const pricing = await this.getModelPricing(model);

      if (!pricing) {
        // If no pricing found, return zero costs
        return {
          base_cost_usd: 0,
          platform_fee_usd: 0,
          total_cost_usd: 0,
        };
      }

      const promptCost = (promptTokens / 1000) * pricing.input_per_1k_usd;
      const completionCost = (completionTokens / 1000) * pricing.output_per_1k_usd;
      const baseCost = promptCost + completionCost;

      const feeRate = parseFloat(this.env.SANDBOX_FEE_RATE);
      const platformFee = baseCost * feeRate;
      const totalCost = baseCost + platformFee;

      return {
        base_cost_usd: this.round4(baseCost),
        platform_fee_usd: this.round4(platformFee),
        total_cost_usd: this.round4(totalCost),
      };
    } catch (error) {
      console.error('Fee calculation error:', error);
      return {
        base_cost_usd: 0,
        platform_fee_usd: 0,
        total_cost_usd: 0,
      };
    }
  }

  /**
   * Get pricing for a specific model (with D1 override support)
   */
  private async getModelPricing(model: string): Promise<ModelPricing | null> {
    try {
      // Check for D1 override first
      const override = await this.env.USAGE_DB
        .prepare('SELECT input_per_1k_usd, output_per_1k_usd FROM pricing_overrides WHERE model = ? LIMIT 1')
        .bind(model)
        .first<{ input_per_1k_usd: number; output_per_1k_usd: number }>();

      if (override) {
        return {
          input_per_1k_usd: override.input_per_1k_usd,
          output_per_1k_usd: override.output_per_1k_usd,
        };
      }

      // Fall back to KV pricing
      const defaultPricing = await this.getDefaultPricing();
      return defaultPricing[model] || null;
    } catch (error) {
      console.error('Error getting model pricing:', error);
      return null;
    }
  }

  /**
   * Load default pricing from KV (with caching)
   */
  private async getDefaultPricing(): Promise<PricingData> {
    const now = Date.now();

    if (this.pricingCache && now < this.cacheExpiry) {
      return this.pricingCache;
    }

    try {
      const pricingJson = await this.env.PRICING.get('PRICING_V1');
      if (!pricingJson) {
        console.warn('No default pricing found in KV');
        return {};
      }

      this.pricingCache = JSON.parse(pricingJson) as PricingData;
      this.cacheExpiry = now + this.CACHE_TTL_MS;

      return this.pricingCache;
    } catch (error) {
      console.error('Error loading default pricing:', error);
      return {};
    }
  }

  /**
   * Round to 4 decimal places for USD precision
   */
  private round4(value: number): number {
    return Math.round(value * 10000) / 10000;
  }
}