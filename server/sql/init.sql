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
  currency TEXT NOT NULL DEFAULT 'SAR',
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

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  payment_terms TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  rating NUMERIC(6, 2) NOT NULL DEFAULT 0,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id TEXT PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE,
  site_id TEXT,
  site_name TEXT,
  request_date DATE NOT NULL,
  needed_by DATE,
  requested_by TEXT,
  requested_by_name TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  approval_role TEXT NOT NULL DEFAULT 'manager',
  approved_by TEXT,
  approved_by_name TEXT,
  approved_at TIMESTAMPTZ,
  auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  source_type TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  total_estimated_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_request_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  ingredient_id TEXT,
  ingredient_name TEXT NOT NULL,
  description TEXT,
  requested_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  approved_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ordered_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unit TEXT,
  estimated_unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  preferred_supplier_id TEXT,
  preferred_supplier_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  request_id TEXT REFERENCES purchase_requests(id) ON DELETE SET NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT,
  site_id TEXT,
  site_name TEXT,
  order_date DATE NOT NULL,
  expected_delivery_date DATE,
  currency TEXT NOT NULL DEFAULT 'SAR',
  subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  approved_by_name TEXT,
  approved_at TIMESTAMPTZ,
  created_by TEXT,
  created_by_name TEXT,
  received_percentage NUMERIC(8, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  request_item_id TEXT REFERENCES purchase_request_items(id) ON DELETE SET NULL,
  ingredient_id TEXT,
  ingredient_name TEXT NOT NULL,
  ordered_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  received_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unit TEXT,
  unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id TEXT PRIMARY KEY,
  grn_number TEXT NOT NULL UNIQUE,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT,
  site_id TEXT,
  site_name TEXT,
  receipt_date DATE NOT NULL,
  received_by TEXT,
  received_by_name TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  order_item_id TEXT REFERENCES purchase_order_items(id) ON DELETE SET NULL,
  ingredient_id TEXT,
  ingredient_name TEXT NOT NULL,
  received_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  accepted_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  rejected_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
  unit TEXT,
  batch_number TEXT,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT,
  purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  goods_receipt_id TEXT REFERENCES goods_receipts(id) ON DELETE SET NULL,
  invoice_date DATE NOT NULL,
  due_date DATE,
  subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  entered_by TEXT,
  entered_by_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_price_history (
  id TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_name TEXT,
  ingredient_id TEXT,
  ingredient_name TEXT NOT NULL,
  purchase_order_item_id TEXT REFERENCES purchase_order_items(id) ON DELETE SET NULL,
  unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'SAR',
  effective_date DATE NOT NULL,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  site_id TEXT,
  site_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status, request_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_order ON goods_receipts(purchase_order_id, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_history_lookup ON supplier_price_history(ingredient_id, supplier_id, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lookup
  ON entity_records ((data->>'site_id'), (data->>'ingredient_id'))
  WHERE entity_name = 'Inventory';

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lot_lookup
  ON entity_records ((data->>'site_id'), (data->>'ingredient_id'), (data->>'batch_number'))
  WHERE entity_name = 'InventoryLot';
