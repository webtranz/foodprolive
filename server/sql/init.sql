CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

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

CREATE OR REPLACE FUNCTION notify_foodpro_user_change()
RETURNS TRIGGER AS $$
DECLARE
  user_row users%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    user_row := OLD;
  ELSE
    user_row := NEW;
  END IF;
  PERFORM pg_notify(
    'foodpro_entity_events',
    jsonb_build_object(
      'entity', 'User',
      'action', LOWER(TG_OP),
      'id', NULL,
      'site_id', user_row.site_id,
      'site_ids', '[]'::jsonb,
      'occurred_at', NOW()
    )::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'users_realtime_change' AND tgrelid = 'users'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER users_realtime_change
      AFTER INSERT OR UPDATE OR DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION notify_foodpro_user_change()';
  END IF;
END;
$trigger$;

CREATE TABLE IF NOT EXISTS entity_records (
  id TEXT PRIMARY KEY,
  entity_name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_records_entity_name ON entity_records(entity_name);
CREATE INDEX IF NOT EXISTS idx_entity_records_entity_updated_at ON entity_records(entity_name, updated_at DESC);

CREATE OR REPLACE FUNCTION notify_foodpro_entity_change()
RETURNS TRIGGER AS $$
DECLARE
  record_data JSONB;
  record_id TEXT;
  entity_value TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    record_data := OLD.data;
    record_id := OLD.id;
    entity_value := OLD.entity_name;
  ELSE
    record_data := NEW.data;
    record_id := NEW.id;
    entity_value := NEW.entity_name;
  END IF;
  PERFORM pg_notify(
    'foodpro_entity_events',
    jsonb_build_object(
      'entity', entity_value,
      'action', LOWER(TG_OP),
      'id', NULL,
      'site_id', COALESCE(record_data->>'site_id', CASE
        WHEN entity_value = 'Site' THEN record_id
        ELSE NULL
      END),
      'site_ids', '[]'::jsonb,
      'occurred_at', NOW()
    )::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'entity_records_realtime_change' AND tgrelid = 'entity_records'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER entity_records_realtime_change
      AFTER INSERT OR UPDATE OR DELETE ON entity_records
      FOR EACH ROW EXECUTE FUNCTION notify_foodpro_entity_change()';
  END IF;
END;
$trigger$;

CREATE TABLE IF NOT EXISTS app_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  page_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  site_id TEXT,
  site_name TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bulk_upload_jobs (
  id TEXT PRIMARY KEY,
  module_key TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  import_mode TEXT NOT NULL DEFAULT 'keep_existing',
  file_name TEXT,
  file_path TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  batch_size INTEGER NOT NULL DEFAULT 500,
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  applied_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  message TEXT,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_name TEXT,
  role TEXT,
  site_id TEXT,
  site_name TEXT,
  actor_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION notify_foodpro_bulk_job_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'foodpro_entity_events',
    jsonb_build_object(
      'entity', 'BulkUploadJob',
      'action', LOWER(TG_OP),
      'id', NULL,
      'site_id', NEW.site_id,
      'site_ids', '[]'::jsonb,
      'occurred_at', NOW()
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'bulk_upload_jobs_realtime_change' AND tgrelid = 'bulk_upload_jobs'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER bulk_upload_jobs_realtime_change
      AFTER INSERT OR UPDATE ON bulk_upload_jobs
      FOR EACH ROW EXECUTE FUNCTION notify_foodpro_bulk_job_change()';
  END IF;
END;
$trigger$;

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
  preferred_supplier_id TEXT
    CONSTRAINT fk_purchase_request_items_preferred_supplier
    REFERENCES suppliers(id) ON DELETE SET NULL,
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
  order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_purchase_request_items_preferred_supplier'
  ) THEN
    ALTER TABLE purchase_request_items
      ADD CONSTRAINT fk_purchase_request_items_preferred_supplier
      FOREIGN KEY (preferred_supplier_id)
      REFERENCES suppliers(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_goods_receipt_items_order_item_required'
  ) THEN
    ALTER TABLE goods_receipt_items
      ADD CONSTRAINT chk_goods_receipt_items_order_item_required
      CHECK (order_item_id IS NOT NULL)
      NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_order_item_request_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_request_id TEXT;
  item_request_id TEXT;
BEGIN
  IF NEW.request_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT request_id INTO order_request_id
  FROM purchase_orders
  WHERE id = NEW.order_id;

  SELECT request_id INTO item_request_id
  FROM purchase_request_items
  WHERE id = NEW.request_item_id;

  IF order_request_id IS NULL OR item_request_id IS DISTINCT FROM order_request_id THEN
    RAISE EXCEPTION 'Purchase order item must reference an item from its purchase request'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_purchase_order_item_request_link ON purchase_order_items;
CREATE TRIGGER trg_validate_purchase_order_item_request_link
BEFORE INSERT OR UPDATE OF order_id, request_item_id
ON purchase_order_items
FOR EACH ROW
EXECUTE FUNCTION validate_purchase_order_item_request_link();

CREATE OR REPLACE FUNCTION validate_goods_receipt_item_order_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_order_id TEXT;
  item_order_id TEXT;
BEGIN
  IF NEW.order_item_id IS NULL THEN
    RAISE EXCEPTION 'Goods receipt item must reference a purchase order item'
      USING ERRCODE = '23502';
  END IF;

  SELECT purchase_order_id INTO receipt_order_id
  FROM goods_receipts
  WHERE id = NEW.receipt_id;

  SELECT order_id INTO item_order_id
  FROM purchase_order_items
  WHERE id = NEW.order_item_id;

  IF receipt_order_id IS NULL OR item_order_id IS DISTINCT FROM receipt_order_id THEN
    RAISE EXCEPTION 'Goods receipt item must reference an item from its purchase order'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_goods_receipt_item_order_link ON goods_receipt_items;
CREATE TRIGGER trg_validate_goods_receipt_item_order_link
BEFORE INSERT OR UPDATE OF receipt_id, order_item_id
ON goods_receipt_items
FOR EACH ROW
EXECUTE FUNCTION validate_goods_receipt_item_order_link();

CREATE OR REPLACE FUNCTION validate_supplier_invoice_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_supplier_id TEXT;
  receipt_order_id TEXT;
  receipt_supplier_id TEXT;
BEGIN
  IF NEW.purchase_order_id IS NOT NULL THEN
    SELECT supplier_id INTO order_supplier_id
    FROM purchase_orders
    WHERE id = NEW.purchase_order_id;
  END IF;

  IF NEW.goods_receipt_id IS NOT NULL THEN
    SELECT purchase_order_id, supplier_id
      INTO receipt_order_id, receipt_supplier_id
    FROM goods_receipts
    WHERE id = NEW.goods_receipt_id;
  END IF;

  IF NEW.purchase_order_id IS NOT NULL
     AND NEW.goods_receipt_id IS NOT NULL
     AND receipt_order_id IS DISTINCT FROM NEW.purchase_order_id THEN
    RAISE EXCEPTION 'Supplier invoice receipt must belong to its purchase order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supplier_id IS NOT NULL
     AND order_supplier_id IS NOT NULL
     AND NEW.supplier_id IS DISTINCT FROM order_supplier_id THEN
    RAISE EXCEPTION 'Supplier invoice supplier must match its purchase order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supplier_id IS NOT NULL
     AND receipt_supplier_id IS NOT NULL
     AND NEW.supplier_id IS DISTINCT FROM receipt_supplier_id THEN
    RAISE EXCEPTION 'Supplier invoice supplier must match its goods receipt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_supplier_invoice_chain ON supplier_invoices;
CREATE TRIGGER trg_validate_supplier_invoice_chain
BEFORE INSERT OR UPDATE OF supplier_id, purchase_order_id, goods_receipt_id
ON supplier_invoices
FOR EACH ROW
EXECUTE FUNCTION validate_supplier_invoice_chain();

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_users_site_status ON users(site_id, status);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
CREATE INDEX IF NOT EXISTS idx_app_logs_user ON app_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_site ON audit_logs(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_upload_jobs_status ON bulk_upload_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_upload_jobs_actor ON bulk_upload_jobs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_upload_jobs_site ON bulk_upload_jobs(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_orders_source ON pos_sales_orders(source_id);
CREATE INDEX IF NOT EXISTS idx_pos_sales_items_order ON pos_sales_items(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_recipe_mapping_source ON pos_recipe_mapping(source_id);
CREATE INDEX IF NOT EXISTS idx_pos_sync_logs_source ON pos_sync_logs(source_id);
CREATE INDEX IF NOT EXISTS idx_purchase_request_items_request ON purchase_request_items(request_id);
CREATE INDEX IF NOT EXISTS idx_purchase_request_items_supplier ON purchase_request_items(preferred_supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_request ON purchase_orders(request_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order ON purchase_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_request_item ON purchase_order_items(request_item_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_receipt ON goods_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_order_item ON goods_receipt_items(order_item_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_order ON supplier_invoices(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_receipt ON supplier_invoices(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_supplier_price_history_order_item ON supplier_price_history(purchase_order_item_id);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status, request_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_order ON goods_receipts(purchase_order_id, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_history_lookup ON supplier_price_history(ingredient_id, supplier_id, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lookup
  ON entity_records ((data->>'site_id'), (data->>'ingredient_id'))
  WHERE entity_name = 'Inventory';

CREATE INDEX IF NOT EXISTS idx_entity_records_ingredient_name_search
  ON entity_records USING GIN (LOWER(COALESCE(data->>'name', '')) gin_trgm_ops)
  WHERE entity_name = 'Ingredient';

CREATE INDEX IF NOT EXISTS idx_entity_records_ingredient_sku_search
  ON entity_records USING GIN ((
    LOWER(COALESCE(data->>'sku', '') || ' ' || COALESCE(data->>'ingredient_code', '') || ' ' || COALESCE(data->>'item_code', ''))
  ) gin_trgm_ops)
  WHERE entity_name = 'Ingredient';

CREATE INDEX IF NOT EXISTS idx_entity_records_ingredient_category_search
  ON entity_records USING GIN (LOWER(COALESCE(data->>'category', '')) gin_trgm_ops)
  WHERE entity_name = 'Ingredient';

CREATE INDEX IF NOT EXISTS idx_entity_records_ingredient_alias_search
  ON entity_records USING GIN ((
    LOWER(COALESCE(data->>'alias', '') || ' ' || COALESCE(data->>'aliases', '') || ' ' ||
      COALESCE(data->>'alternative_name', '') || ' ' || COALESCE(data->>'alternative_names', ''))
  ) gin_trgm_ops)
  WHERE entity_name = 'Ingredient';

CREATE INDEX IF NOT EXISTS idx_entity_records_ingredient_supplier_name_search
  ON entity_records USING GIN ((
    LOWER(COALESCE(data->>'supplier_item_name', '') || ' ' || COALESCE(data->>'supplier_item_names', ''))
  ) gin_trgm_ops)
  WHERE entity_name = 'Ingredient';

CREATE INDEX IF NOT EXISTS idx_entity_records_ingredient_search_document
  ON entity_records USING GIN ((
    LOWER(
      COALESCE(data->>'name', '') || ' ' || COALESCE(data->>'sku', '') || ' ' ||
      COALESCE(data->>'ingredient_code', '') || ' ' || COALESCE(data->>'item_code', '') || ' ' ||
      COALESCE(data->>'category', '') || ' ' || COALESCE(data->>'alias', '') || ' ' ||
      COALESCE(data->>'aliases', '') || ' ' || COALESCE(data->>'alternative_name', '') || ' ' ||
      COALESCE(data->>'alternative_names', '') || ' ' || COALESCE(data->>'supplier_item_name', '') || ' ' ||
      COALESCE(data->>'supplier_item_names', '')
    )
  ) gin_trgm_ops)
  WHERE entity_name = 'Ingredient'
    AND COALESCE(LOWER(NULLIF(BTRIM(data->>'is_active'), '')), 'true') NOT IN ('false', '0', 'no', 'inactive');

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_inventory_site_ingredient_unique
  ON entity_records ((data->>'site_id'), (data->>'ingredient_id'))
  WHERE entity_name = 'Inventory'
    AND COALESCE(data->>'site_id', '') <> ''
    AND COALESCE(data->>'ingredient_id', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lot_lookup
  ON entity_records ((data->>'site_id'), (data->>'ingredient_id'), (data->>'batch_number'))
  WHERE entity_name = 'InventoryLot';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_site_date_status_ci
  ON entity_records (
    (data->>'site_id'),
    LOWER(COALESCE(data->>'plan_date', '')),
    LOWER(COALESCE(data->>'status', ''))
  )
  WHERE entity_name = 'MenuPlan';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_event_lookup
  ON entity_records ((data->>'site_id'), (data->>'event_date'), (data->>'status'))
  WHERE entity_name = 'MenuPlan' AND COALESCE(data->>'event_name', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_production_event_recipe
  ON entity_records ((data->>'source_event_id'), (data->>'source_event_recipe_id'))
  WHERE entity_name = 'Production' AND COALESCE(data->>'source_event_id', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_production_site_date_status_ci
  ON entity_records (
    (data->>'site_id'),
    LOWER(COALESCE(data->>'production_date', '')),
    LOWER(COALESCE(data->>'status', ''))
  )
  WHERE entity_name = 'Production';

CREATE INDEX IF NOT EXISTS idx_entity_records_production_status_date_ci
  ON entity_records (
    LOWER(COALESCE(data->>'status', '')),
    LOWER(COALESCE(data->>'production_date', ''))
  )
  WHERE entity_name = 'Production';

CREATE INDEX IF NOT EXISTS idx_entity_records_material_request_site_date_status_ci
  ON entity_records (
    (data->>'site_id'),
    LOWER(COALESCE(data->>'request_date', '')),
    LOWER(COALESCE(data->>'status', ''))
  )
  WHERE entity_name = 'MaterialRequest';

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_transaction_site_date_ci
  ON entity_records (
    (data->>'site_id'),
    LOWER(COALESCE(data->>'transaction_date', '')),
    LOWER(COALESCE(data->>'transaction_type', ''))
  )
  WHERE entity_name = 'InventoryTransaction';

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lot_site_expiry
  ON entity_records ((data->>'site_id'), (data->>'expiry_date'), (data->>'status'))
  WHERE entity_name = 'InventoryLot';

CREATE INDEX IF NOT EXISTS idx_entity_records_attendance_site_date_status_ci
  ON entity_records (
    (data->>'site_id'),
    LOWER(COALESCE(data->>'attendance_date', '')),
    LOWER(COALESCE(data->>'attendance_status', ''))
  )
  WHERE entity_name = 'AttendanceRecord';

CREATE INDEX IF NOT EXISTS idx_entity_records_recipe_scope_name
  ON entity_records ((data->>'site_scope'), LOWER(COALESCE(data->>'name', '')))
  WHERE entity_name = 'Recipe';

CREATE INDEX IF NOT EXISTS idx_entity_records_recipe_site_ids
  ON entity_records USING GIN ((data->'site_ids'))
  WHERE entity_name = 'Recipe';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_event_handoffs
  ON entity_records ((data->>'procurement_pr_id'), (data->>'production_plan_status'))
  WHERE entity_name = 'MenuPlan' AND COALESCE(data->>'event_name', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_budget_lookup
  ON entity_records ((data->>'budget_id'), (data->>'site_id'), (data->>'plan_date'))
  WHERE entity_name = 'MenuPlan' AND COALESCE(data->>'budget_id', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_budget_site_period_status
  ON entity_records ((data->>'site_id'), (data->>'start_date'), (data->>'end_date'), (data->>'status'))
  WHERE entity_name = 'Budget';

CREATE INDEX IF NOT EXISTS idx_entity_records_budget_scope_lookup
  ON entity_records ((data->>'scope_type'), (data->>'meal_type'), (data->>'event_name'))
  WHERE entity_name = 'Budget';

CREATE INDEX IF NOT EXISTS idx_entity_records_food_waste_site_date_meal
  ON entity_records ((data->>'site_id'), (data->>'waste_date'), (data->>'meal_type'))
  WHERE entity_name = 'FoodWaste';

CREATE INDEX IF NOT EXISTS idx_entity_records_food_waste_status_lookup
  ON entity_records ((data->>'approval_status'), (data->>'status'), (data->>'production_id'))
  WHERE entity_name = 'FoodWaste';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_menu_plan_pr_schedule_site_unique
  ON entity_records ((data->>'site_id'))
  WHERE entity_name = 'MenuPlanPRSchedule';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_pr_run_cycle
  ON entity_records ((data->>'site_id'), (data->>'cycle_start'), (data->>'cycle_end'), (data->>'status'))
  WHERE entity_name = 'MenuPlanPRRun';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_pr_run_generated_pr
  ON entity_records ((data->>'generated_pr_id'))
  WHERE entity_name = 'MenuPlanPRRun' AND COALESCE(data->>'generated_pr_id', '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_qrcode_token_unique
  ON entity_records ((data->>'token'))
  WHERE entity_name = 'QRCode' AND COALESCE(data->>'token', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_qrcode_site_category_status
  ON entity_records ((data->>'site_id'), (data->>'category'), (data->>'status'))
  WHERE entity_name = 'QRCode';
