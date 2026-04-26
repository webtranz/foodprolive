CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  site_id TEXT,
  site_name TEXT,
  password_hash TEXT NOT NULL,
  temporary_password TEXT,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS entity_records (
  id TEXT PRIMARY KEY,
  entity_name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_records_entity_name ON entity_records(entity_name);
CREATE INDEX IF NOT EXISTS idx_entity_records_entity_updated_at ON entity_records(entity_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  page_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_logs (
  id TEXT PRIMARY KEY,
  recipient TEXT,
  subject TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'api',
  api_url TEXT,
  api_key TEXT,
  api_secret TEXT,
  sync_frequency TEXT NOT NULL DEFAULT 'manual',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  default_site_id TEXT,
  default_site_name TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_sales_orders (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES pos_sources(id) ON DELETE SET NULL,
  external_order_id TEXT,
  order_number TEXT,
  site_id TEXT,
  site_name TEXT,
  location_name TEXT,
  business_date DATE,
  sold_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sync_method TEXT NOT NULL DEFAULT 'manual_upload',
  inventory_applied BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_sales_orders_source_external
  ON pos_sales_orders (source_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pos_sales_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES pos_sales_orders(id) ON DELETE CASCADE,
  external_item_id TEXT,
  pos_item_code TEXT,
  pos_item_name TEXT NOT NULL,
  recipe_id TEXT,
  recipe_name TEXT,
  quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  site_id TEXT,
  site_name TEXT,
  deduction_status TEXT NOT NULL DEFAULT 'pending',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_recipe_mapping (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES pos_sources(id) ON DELETE CASCADE,
  pos_item_code TEXT,
  pos_item_name TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_name TEXT,
  servings_per_sale NUMERIC(14, 3) NOT NULL DEFAULT 1,
  site_scope TEXT NOT NULL DEFAULT 'global',
  site_id TEXT,
  auto_deduct BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_recipe_mapping_lookup
  ON pos_recipe_mapping (source_id, pos_item_code, pos_item_name);

CREATE TABLE IF NOT EXISTS pos_sync_logs (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES pos_sources(id) ON DELETE SET NULL,
  sync_type TEXT NOT NULL DEFAULT 'manual_upload',
  status TEXT NOT NULL DEFAULT 'success',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  records_received INTEGER NOT NULL DEFAULT 0,
  records_imported INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
