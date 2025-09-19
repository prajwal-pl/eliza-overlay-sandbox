// ElizaOS Cloud API Types
export interface ElizaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content: string | object[];
}

export interface ElizaChatCompletionRequest {
  model: string;
  messages: ElizaMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: object[];
  tool_choice?: string | object;
}

export interface ElizaUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cost: number;
  completion_cost: number;
  total_cost: number;
}

export interface ElizaChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  provider?: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls: object[];
    };
    finish_reason: string;
  }[];
  usage: ElizaUsage;
}

// Database Types
export interface CloudApiKey {
  id: string;
  key: string;
  label: string | null;
  created_at: number;
}

export interface PricingOverride {
  model: string;
  input_per_1k_usd: number;
  output_per_1k_usd: number;
}

export interface UsageEvent {
  id: string;
  ts: number;
  cloud_key_id: string;
  session_id: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  base_cost_usd: number | null;
  platform_fee_usd: number | null;
  total_cost_usd: number | null;
  request_id: string | null;
  meta: string | null; // JSON string
}

// Pricing Types
export interface ModelPricing {
  input_per_1k_usd: number;
  output_per_1k_usd: number;
}

export interface PricingData {
  [model: string]: ModelPricing;
}

// Worker Environment
export interface Env {
  USAGE_DB: D1Database;
  PRICING: KVNamespace;
  ELIZA_BASE_URL: string;
  SANDBOX_FEE_RATE: string;
}

// Utility Types
export interface SandboxFeeCalculation {
  base_cost_usd: number;
  platform_fee_usd: number;
  total_cost_usd: number;
}

export interface AuthResult {
  success: boolean;
  keyId?: string;
  apiKey?: string;
  error?: string;
}

export interface ProxyResponse extends ElizaChatCompletionResponse {
  // Original response is unchanged
}

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}