-- Keys table (allow-list for sandbox)
CREATE TABLE IF NOT EXISTS cloud_api_keys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);

-- Pricing table (optional overrides; default comes from KV JSON)
CREATE TABLE IF NOT EXISTS pricing_overrides (
  model TEXT PRIMARY KEY,             -- e.g., 'gpt-4o-mini'
  input_per_1k_usd REAL NOT NULL,     -- prompt
  output_per_1k_usd REAL NOT NULL     -- completion
);

-- Usage ledger (sandbox side)
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  cloud_key_id TEXT NOT NULL,
  session_id TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  base_cost_usd REAL,                  -- computed from pricing
  platform_fee_usd REAL,               -- 20% of base_cost_usd
  total_cost_usd REAL,                 -- base + fee
  request_id TEXT,                     -- from ElizaOS Cloud if available
  meta JSON                            -- freeform (ip, ua, version, etc.)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_cloud_key_id ON usage_events(cloud_key_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_session_id ON usage_events(session_id);