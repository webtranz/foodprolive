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

-- ---------------------------------------------------------------------------
-- Phase 1 normalized operational schema
-- ---------------------------------------------------------------------------
-- The legacy application stores most operational records in entity_records as
-- JSONB documents. The tables below are the relational target model for the
-- core FoodPro flows. They are additive in Phase 1: existing JSON reads/writes
-- continue to work while data is backfilled and endpoints are moved over in
-- controlled follow-up phases.

CREATE TABLE IF NOT EXISTS areas (
  area_id TEXT PRIMARY KEY,
  area_code TEXT,
  name TEXT NOT NULL,
  legacy_site_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_areas_area_code_unique
  ON areas (LOWER(BTRIM(area_code)))
  WHERE COALESCE(BTRIM(area_code), '') <> '';

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(area_id) ON DELETE RESTRICT,
  project_code TEXT,
  name TEXT NOT NULL,
  legacy_site_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_code_unique
  ON projects (LOWER(BTRIM(project_code)))
  WHERE COALESCE(BTRIM(project_code), '') <> '';

CREATE INDEX IF NOT EXISTS idx_projects_area ON projects(area_id);

CREATE TABLE IF NOT EXISTS warehouses (
  warehouse_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  warehouse_code TEXT,
  d365_warehouse_id TEXT,
  name TEXT NOT NULL,
  legacy_site_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_warehouse_code_unique
  ON warehouses (LOWER(BTRIM(warehouse_code)))
  WHERE COALESCE(BTRIM(warehouse_code), '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_d365_unique
  ON warehouses (LOWER(BTRIM(d365_warehouse_id)))
  WHERE COALESCE(BTRIM(d365_warehouse_id), '') <> '';

CREATE INDEX IF NOT EXISTS idx_warehouses_project ON warehouses(project_id);

CREATE TABLE IF NOT EXISTS ingredients (
  ingredient_id TEXT PRIMARY KEY,
  item_code TEXT NOT NULL,
  ingredient_code TEXT,
  sku TEXT,
  d365_item_id TEXT,
  name TEXT NOT NULL,
  base_unit TEXT NOT NULL,
  category_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_item_code_unique
  ON ingredients (LOWER(BTRIM(item_code)))
  WHERE COALESCE(BTRIM(item_code), '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_ingredient_code_unique
  ON ingredients (LOWER(BTRIM(ingredient_code)))
  WHERE COALESCE(BTRIM(ingredient_code), '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_sku_unique
  ON ingredients (LOWER(BTRIM(sku)))
  WHERE COALESCE(BTRIM(sku), '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_d365_unique
  ON ingredients (LOWER(BTRIM(d365_item_id)))
  WHERE COALESCE(BTRIM(d365_item_id), '') <> '';

CREATE INDEX IF NOT EXISTS idx_ingredients_name_search
  ON ingredients USING gin (LOWER(name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS ingredient_unit_conversions (
  conversion_id TEXT PRIMARY KEY,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(ingredient_id) ON DELETE CASCADE,
  from_unit TEXT NOT NULL,
  to_unit TEXT NOT NULL,
  factor NUMERIC(18, 8) NOT NULL CHECK (factor > 0),
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ingredient_id, from_unit, to_unit)
);

CREATE TABLE IF NOT EXISTS warehouse_inventory (
  inventory_id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  available_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  reserved_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  on_hand_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  average_unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  last_unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  stock_unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_inventory_ingredient
  ON warehouse_inventory(ingredient_id);

CREATE TABLE IF NOT EXISTS inventory_lots (
  lot_id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES warehouse_inventory(inventory_id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  batch_number TEXT,
  received_date DATE,
  stock_date DATE,
  expiry_date DATE,
  original_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  remaining_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  unit TEXT NOT NULL,
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (warehouse_id, ingredient_id)
    REFERENCES warehouse_inventory(warehouse_id, ingredient_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_fifo
  ON inventory_lots(warehouse_id, ingredient_id, expiry_date, stock_date, lot_id)
  WHERE status NOT IN ('voided', 'closed');

CREATE TABLE IF NOT EXISTS recipes (
  recipe_id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_canonical_name_unique
  ON recipes (LOWER(BTRIM(canonical_name)))
  WHERE COALESCE(BTRIM(canonical_name), '') <> ''
    AND status NOT IN ('archived', 'voided');

CREATE TABLE IF NOT EXISTS recipe_versions (
  recipe_version_id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(recipe_id) ON DELETE CASCADE,
  area_id TEXT REFERENCES areas(area_id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  recipe_code TEXT,
  display_name TEXT NOT NULL,
  version_label TEXT NOT NULL DEFAULT 'v1',
  cuisine_type TEXT,
  menu_category TEXT,
  serving_size_grams NUMERIC(18, 6),
  batch_yield NUMERIC(18, 6) NOT NULL DEFAULT 1,
  total_recipe_weight_grams NUMERIC(18, 6),
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost_per_serving NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (warehouse_id IS NOT NULL AND project_id IS NULL AND area_id IS NULL)
    OR (warehouse_id IS NULL AND project_id IS NOT NULL AND area_id IS NULL)
    OR (warehouse_id IS NULL AND project_id IS NULL AND area_id IS NOT NULL)
    OR (warehouse_id IS NULL AND project_id IS NULL AND area_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_versions_scope_code_unique
  ON recipe_versions (
    COALESCE(warehouse_id, project_id, area_id, '__APP__'),
    LOWER(BTRIM(recipe_code))
  )
  WHERE COALESCE(BTRIM(recipe_code), '') <> ''
    AND status NOT IN ('archived', 'voided');

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_versions_scope_name_unique
  ON recipe_versions (
    COALESCE(warehouse_id, project_id, area_id, '__APP__'),
    LOWER(BTRIM(display_name))
  )
  WHERE COALESCE(BTRIM(display_name), '') <> ''
    AND status NOT IN ('archived', 'voided');

CREATE INDEX IF NOT EXISTS idx_recipe_versions_recipe
  ON recipe_versions(recipe_id);

CREATE TABLE IF NOT EXISTS recipe_ingredient_lines (
  recipe_line_id TEXT PRIMARY KEY,
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(recipe_version_id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL DEFAULT 0,
  quantity NUMERIC(18, 6) NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  converted_quantity NUMERIC(18, 6),
  converted_unit TEXT,
  raw_weight_grams NUMERIC(18, 6),
  yield_percent NUMERIC(8, 4) NOT NULL DEFAULT 100 CHECK (yield_percent >= 0),
  yielded_weight_grams NUMERIC(18, 6),
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recipe_version_id, line_number, ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredient_lines_ingredient
  ON recipe_ingredient_lines(ingredient_id);

CREATE TABLE IF NOT EXISTS menu_plans (
  menu_plan_id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  plan_date DATE NOT NULL,
  meal_period TEXT NOT NULL,
  menu_type TEXT NOT NULL,
  menu_category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_plans_scope_unique
  ON menu_plans (
    warehouse_id,
    plan_date,
    LOWER(BTRIM(meal_period)),
    LOWER(BTRIM(menu_type)),
    LOWER(BTRIM(menu_category))
  )
  WHERE status NOT IN ('cancelled', 'voided', 'archived');

CREATE TABLE IF NOT EXISTS menu_plan_lines (
  menu_plan_line_id TEXT PRIMARY KEY,
  menu_plan_id TEXT NOT NULL REFERENCES menu_plans(menu_plan_id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL DEFAULT 0,
  line_type TEXT NOT NULL DEFAULT 'recipe' CHECK (line_type IN ('recipe', 'ingredient', 'manual')),
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  planned_servings NUMERIC(18, 6),
  planned_weight_grams NUMERIC(18, 6),
  planned_unit TEXT,
  estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    recipe_version_id IS NOT NULL
    OR ingredient_id IS NOT NULL
    OR COALESCE(BTRIM(item_name), '') <> ''
  )
);

CREATE INDEX IF NOT EXISTS idx_menu_plan_lines_plan
  ON menu_plan_lines(menu_plan_id, line_number);

CREATE TABLE IF NOT EXISTS production_events (
  production_id TEXT PRIMARY KEY,
  menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  production_date DATE NOT NULL,
  meal_period TEXT NOT NULL,
  menu_type TEXT NOT NULL,
  menu_category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  issue_group_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  reversed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_production_events_issue_group_unique
  ON production_events(warehouse_id, issue_group_key)
  WHERE COALESCE(BTRIM(issue_group_key), '') <> ''
    AND status NOT IN ('voided', 'reversed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_production_events_scope
  ON production_events(warehouse_id, production_date, meal_period, menu_type, menu_category, status);

CREATE TABLE IF NOT EXISTS production_manifest_lines (
  production_line_id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production_events(production_id) ON DELETE CASCADE,
  menu_plan_line_id TEXT REFERENCES menu_plan_lines(menu_plan_line_id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL DEFAULT 0,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  requested_servings NUMERIC(18, 6),
  requested_weight_grams NUMERIC(18, 6),
  produced_servings NUMERIC(18, 6),
  produced_weight_grams NUMERIC(18, 6),
  estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    COALESCE(produced_weight_grams, requested_weight_grams, 0) > 0
    OR COALESCE(produced_servings, requested_servings, 0) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_production_manifest_lines_event
  ON production_manifest_lines(production_id, line_number);

CREATE INDEX IF NOT EXISTS idx_production_manifest_lines_recipe
  ON production_manifest_lines(recipe_version_id);

CREATE TABLE IF NOT EXISTS production_consumption_lines (
  consumption_line_id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production_events(production_id) ON DELETE CASCADE,
  production_line_id TEXT NOT NULL REFERENCES production_manifest_lines(production_line_id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  inventory_id TEXT REFERENCES warehouse_inventory(inventory_id) ON DELETE RESTRICT,
  lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE RESTRICT,
  quantity NUMERIC(18, 6) NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  raw_weight_grams NUMERIC(18, 6),
  yielded_weight_grams NUMERIC(18, 6),
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_production_consumption_lines_event
  ON production_consumption_lines(production_id);

CREATE INDEX IF NOT EXISTS idx_production_consumption_lines_lot
  ON production_consumption_lines(lot_id);

CREATE TABLE IF NOT EXISTS produced_output_batches (
  output_batch_id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production_events(production_id) ON DELETE RESTRICT,
  production_line_id TEXT NOT NULL REFERENCES production_manifest_lines(production_line_id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  batch_number TEXT NOT NULL,
  initial_weight_grams NUMERIC(18, 6) NOT NULL CHECK (initial_weight_grams >= 0),
  remaining_weight_grams NUMERIC(18, 6) NOT NULL CHECK (remaining_weight_grams >= 0),
  initial_servings NUMERIC(18, 6),
  remaining_servings NUMERIC(18, 6),
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (remaining_weight_grams <= initial_weight_grams)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_produced_output_batches_number_unique
  ON produced_output_batches(LOWER(BTRIM(batch_number)))
  WHERE COALESCE(BTRIM(batch_number), '') <> ''
    AND status NOT IN ('voided', 'reversed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_produced_output_batches_line_unique
  ON produced_output_batches(production_line_id)
  WHERE status NOT IN ('voided', 'reversed');

CREATE INDEX IF NOT EXISTS idx_produced_output_batches_fifo
  ON produced_output_batches(warehouse_id, status, created_at, output_batch_id);

CREATE TABLE IF NOT EXISTS meal_service_headers (
  meal_service_id TEXT PRIMARY KEY,
  service_reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  service_date DATE NOT NULL,
  meal_period TEXT NOT NULL,
  menu_type TEXT NOT NULL,
  menu_category TEXT NOT NULL,
  serving_size_grams NUMERIC(18, 6) NOT NULL CHECK (serving_size_grams > 0),
  covers NUMERIC(18, 6) NOT NULL CHECK (covers >= 0),
  status TEXT NOT NULL DEFAULT 'posted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  posted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_service_headers_scope
  ON meal_service_headers(warehouse_id, service_date, meal_period, menu_type, menu_category, status);

CREATE TABLE IF NOT EXISTS meal_service_lines (
  meal_service_line_id TEXT PRIMARY KEY,
  meal_service_id TEXT NOT NULL REFERENCES meal_service_headers(meal_service_id) ON DELETE CASCADE,
  output_batch_id TEXT NOT NULL REFERENCES produced_output_batches(output_batch_id) ON DELETE RESTRICT,
  served_covers NUMERIC(18, 6) NOT NULL CHECK (served_covers >= 0),
  served_weight_grams NUMERIC(18, 6) NOT NULL CHECK (served_weight_grams >= 0),
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_service_lines_batch
  ON meal_service_lines(output_batch_id, status);

CREATE TABLE IF NOT EXISTS food_waste_records (
  food_waste_id TEXT PRIMARY KEY,
  waste_reference TEXT,
  idempotency_key TEXT UNIQUE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  waste_date DATE NOT NULL,
  meal_period TEXT,
  menu_type TEXT,
  menu_category TEXT,
  waste_category TEXT NOT NULL,
  reason_code TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'posted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_waste_records_scope
  ON food_waste_records(warehouse_id, waste_date, meal_period, menu_type, menu_category, waste_category, status);

CREATE TABLE IF NOT EXISTS food_waste_lines (
  food_waste_line_id TEXT PRIMARY KEY,
  food_waste_id TEXT NOT NULL REFERENCES food_waste_records(food_waste_id) ON DELETE CASCADE,
  output_batch_id TEXT REFERENCES produced_output_batches(output_batch_id) ON DELETE RESTRICT,
  production_line_id TEXT REFERENCES production_manifest_lines(production_line_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  waste_weight_grams NUMERIC(18, 6) NOT NULL CHECK (waste_weight_grams > 0),
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_waste_lines_output_batch
  ON food_waste_lines(output_batch_id, status);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  inventory_transaction_id TEXT PRIMARY KEY,
  inventory_id TEXT REFERENCES warehouse_inventory(inventory_id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL,
  transaction_date DATE,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  unit TEXT,
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id TEXT,
  reason_code TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  source_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_transactions_idempotency_unique
  ON inventory_transactions(idempotency_key)
  WHERE COALESCE(BTRIM(idempotency_key), '') <> '';

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_reference
  ON inventory_transactions(reference_type, reference_id, reason_code);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_scope
  ON inventory_transactions(warehouse_id, transaction_date, transaction_type, status);

CREATE TABLE IF NOT EXISTS production_consumption_reports (
  report_id TEXT PRIMARY KEY,
  report_number TEXT NOT NULL,
  production_id TEXT NOT NULL REFERENCES production_events(production_id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  production_date DATE,
  total_consumption_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_shortage_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_production_consumption_reports_production_unique
  ON production_consumption_reports(production_id)
  WHERE status <> 'reversed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_production_consumption_reports_number_unique
  ON production_consumption_reports(LOWER(BTRIM(report_number)));

CREATE INDEX IF NOT EXISTS idx_production_consumption_reports_scope
  ON production_consumption_reports(warehouse_id, production_date, status);

CREATE TABLE IF NOT EXISTS meal_service_consumptions (
  meal_consumption_id TEXT PRIMARY KEY,
  meal_service_id TEXT NOT NULL REFERENCES meal_service_headers(meal_service_id) ON DELETE CASCADE,
  output_batch_id TEXT REFERENCES produced_output_batches(output_batch_id) ON DELETE RESTRICT,
  production_id TEXT REFERENCES production_events(production_id) ON DELETE RESTRICT,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  service_reference TEXT NOT NULL,
  movement_type TEXT NOT NULL DEFAULT 'consumption',
  service_date DATE,
  meal_period TEXT,
  consumed_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  consumed_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_service_consumptions_idempotency_unique
  ON meal_service_consumptions(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumptions_header
  ON meal_service_consumptions(meal_service_id, status);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumptions_report
  ON meal_service_consumptions(service_date, meal_period, status);

ALTER TABLE areas ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE warehouse_inventory ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recipe_versions ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_plans ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_plan_lines ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE production_consumption_lines ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meal_service_lines ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill core legacy JSON documents into the normalized cutover tables. The
-- INSERT order follows the real foreign-key chain so a restart is safe and
-- idempotent. Rows with missing parents are skipped instead of inventing links.
INSERT INTO areas (area_id, area_code, name, legacy_site_id, status, source_name, payload, created_at, updated_at)
SELECT
  record.id,
  NULLIF(BTRIM(COALESCE(record.data->>'area_code', record.data->>'project_code')), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  record.id,
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Site'
  AND LOWER(COALESCE(NULLIF(record.data->>'type', ''), 'area')) IN ('area', 'company', 'region')
ON CONFLICT (area_id) DO NOTHING;

INSERT INTO projects (project_id, area_id, project_code, name, legacy_site_id, status, source_name, payload, created_at, updated_at)
SELECT
  record.id,
  record.data->>'parent_site_id',
  NULLIF(BTRIM(record.data->>'project_code'), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  record.id,
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN areas parent_area ON parent_area.area_id = record.data->>'parent_site_id'
WHERE record.entity_name = 'Site'
  AND LOWER(COALESCE(record.data->>'type', '')) IN ('project', 'location', 'branch', 'camp', 'headquarters')
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO warehouses (
  warehouse_id, project_id, warehouse_code, d365_warehouse_id, name, legacy_site_id,
  status, source_name, payload, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'parent_site_id',
  NULLIF(BTRIM(COALESCE(record.data->>'warehouse_code', record.data->>'project_code')), ''),
  NULLIF(BTRIM(record.data->>'d365_warehouse_id'), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  record.id,
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN projects parent_project ON parent_project.project_id = record.data->>'parent_site_id'
WHERE record.entity_name = 'Site'
  AND LOWER(COALESCE(record.data->>'type', '')) IN ('store', 'warehouse', 'kitchen')
ON CONFLICT (warehouse_id) DO NOTHING;

INSERT INTO ingredients (
  ingredient_id, item_code, ingredient_code, sku, d365_item_id, name, base_unit,
  category_id, status, source_name, payload, created_at, updated_at
)
SELECT
  record.id,
  COALESCE(
    NULLIF(BTRIM(record.data->>'item_code'), ''),
    NULLIF(BTRIM(record.data->>'ingredient_code'), ''),
    NULLIF(BTRIM(record.data->>'sku'), ''),
    NULLIF(BTRIM(record.data->>'d365_item_id'), ''),
    record.id
  ),
  NULLIF(BTRIM(record.data->>'ingredient_code'), ''),
  NULLIF(BTRIM(record.data->>'sku'), ''),
  NULLIF(BTRIM(record.data->>'d365_item_id'), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  COALESCE(NULLIF(BTRIM(COALESCE(record.data->>'base_unit', record.data->>'unit', record.data->>'conversion_unit')), ''), 'EA'),
  NULLIF(BTRIM(COALESCE(record.data->>'category_id', record.data->>'category')), ''),
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Ingredient'
ON CONFLICT (ingredient_id) DO NOTHING;

INSERT INTO warehouse_inventory (
  inventory_id, warehouse_id, ingredient_id, available_quantity, reserved_quantity,
  on_hand_quantity, average_unit_cost, last_unit_cost, stock_unit, status,
  source_name, payload, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'site_id',
  record.data->>'ingredient_id',
  COALESCE(NULLIF(record.data->>'available_quantity', '')::numeric, NULLIF(record.data->>'quantity', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'reserved_quantity', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'on_hand_quantity', '')::numeric, NULLIF(record.data->>'quantity', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'average_unit_cost', '')::numeric, NULLIF(record.data->>'cost_per_unit', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'last_unit_cost', '')::numeric, NULLIF(record.data->>'cost_per_unit', '')::numeric, 0),
  COALESCE(NULLIF(BTRIM(record.data->>'unit'), ''), ingredient.base_unit, 'EA'),
  COALESCE(NULLIF(record.data->>'status', ''), 'active'),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
JOIN ingredients ingredient ON ingredient.ingredient_id = record.data->>'ingredient_id'
WHERE record.entity_name = 'Inventory'
ON CONFLICT (inventory_id) DO NOTHING;

INSERT INTO inventory_lots (
  lot_id, inventory_id, warehouse_id, ingredient_id, batch_number, received_date, stock_date,
  expiry_date, original_quantity, remaining_quantity, unit, unit_cost, status, source_name,
  payload, created_at, updated_at
)
SELECT
  record.id,
  inventory.inventory_id,
  record.data->>'site_id',
  record.data->>'ingredient_id',
  NULLIF(record.data->>'batch_number', ''),
  NULLIF(record.data->>'received_date', '')::date,
  NULLIF(record.data->>'stock_date', '')::date,
  NULLIF(record.data->>'expiry_date', '')::date,
  COALESCE(NULLIF(record.data->>'original_quantity', '')::numeric, NULLIF(record.data->>'quantity', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'remaining_quantity', '')::numeric, NULLIF(record.data->>'quantity', '')::numeric, 0),
  COALESCE(NULLIF(BTRIM(record.data->>'unit'), ''), inventory.stock_unit),
  COALESCE(NULLIF(record.data->>'unit_cost', '')::numeric, NULLIF(record.data->>'cost_per_unit', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'active'),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouse_inventory inventory
  ON inventory.warehouse_id = record.data->>'site_id'
 AND inventory.ingredient_id = record.data->>'ingredient_id'
WHERE record.entity_name = 'InventoryLot'
ON CONFLICT (lot_id) DO NOTHING;

INSERT INTO recipes (recipe_id, canonical_name, description, status, source_name, payload, created_at, updated_at)
SELECT
  record.id,
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  NULLIF(record.data->>'description', ''),
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Recipe'
ON CONFLICT (recipe_id) DO NOTHING;

INSERT INTO recipe_versions (
  recipe_version_id, recipe_id, area_id, project_id, warehouse_id, recipe_code,
  display_name, version_label, cuisine_type, menu_category, serving_size_grams,
  batch_yield, total_recipe_weight_grams, total_cost, cost_per_serving,
  status, source_name, payload, created_at, updated_at
)
SELECT
  record.id,
  record.id,
  CASE WHEN record.data->>'site_scope' = 'area' THEN record.data->'site_ids'->>0 ELSE NULL END,
  CASE WHEN record.data->>'site_scope' = 'project' THEN record.data->'site_ids'->>0 ELSE NULL END,
  CASE WHEN record.data->>'site_scope' IN ('warehouse', 'store') THEN record.data->'site_ids'->>0 ELSE NULL END,
  NULLIF(BTRIM(record.data->>'recipe_code'), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  COALESCE(NULLIF(record.data->>'version_label', ''), 'v1'),
  NULLIF(record.data->>'cuisine_type', ''),
  NULLIF(COALESCE(record.data->>'menu_category', record.data->>'category'), ''),
  NULLIF(COALESCE(record.data->>'portion_size_grams', record.data->>'serving_size_grams'), '')::numeric,
  COALESCE(NULLIF(record.data->>'batch_yield', '')::numeric, 1),
  NULLIF(record.data->>'total_recipe_weight_grams', '')::numeric,
  COALESCE(NULLIF(record.data->>'total_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'cost_per_serving', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN recipes recipe ON recipe.recipe_id = record.id
WHERE record.entity_name = 'Recipe'
ON CONFLICT (recipe_version_id) DO NOTHING;

INSERT INTO menu_plans (
  menu_plan_id, warehouse_id, plan_date, meal_period, menu_type, menu_category,
  status, source_name, created_by, payload, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'site_id',
  (record.data->>'plan_date')::date,
  COALESCE(NULLIF(record.data->>'meal_type', ''), 'all'),
  COALESCE(NULLIF(COALESCE(record.data->>'menu_type', record.data->>'cuisine_type'), ''), 'general'),
  COALESCE(NULLIF(record.data->>'menu_category', ''), 'senior'),
  COALESCE(NULLIF(record.data->>'status', ''), 'planned'),
  NULLIF(record.data->>'source_name', ''),
  NULLIF(record.data->>'created_by', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
WHERE record.entity_name = 'MenuPlan'
  AND COALESCE(record.data->>'plan_date', '') <> ''
ON CONFLICT (menu_plan_id) DO NOTHING;

INSERT INTO production_events (
  production_id, menu_plan_id, warehouse_id, production_date, meal_period, menu_type,
  menu_category, status, issue_group_key, payload, started_by, completed_by, completed_at,
  reversed_by, reversed_at, reversal_reason, source_name, created_at, updated_at
)
SELECT
  record.id,
  menu_plan.menu_plan_id,
  COALESCE(NULLIF(record.data->>'fulfillment_store_id', ''), record.data->>'site_id'),
  (record.data->>'production_date')::date,
  COALESCE(NULLIF(record.data->>'meal_type', ''), 'breakfast'),
  COALESCE(NULLIF(COALESCE(record.data->>'menu_type', record.data->>'cuisine_type'), ''), 'general'),
  COALESCE(NULLIF(record.data->>'menu_category', ''), 'senior'),
  COALESCE(NULLIF(record.data->>'status', ''), 'planned'),
  COALESCE(NULLIF(record.data->>'issue_group_key', ''), record.id),
  record.data || jsonb_build_object('id', record.id),
  NULLIF(record.data->>'started_by', ''),
  NULLIF(record.data->>'completed_by', ''),
  NULLIF(record.data->>'completed_at', '')::timestamptz,
  NULLIF(record.data->>'reversed_by', ''),
  NULLIF(record.data->>'reversed_at', '')::timestamptz,
  NULLIF(record.data->>'reversal_reason', ''),
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = COALESCE(NULLIF(record.data->>'fulfillment_store_id', ''), record.data->>'site_id')
LEFT JOIN menu_plans menu_plan ON menu_plan.menu_plan_id = NULLIF(COALESCE(record.data->>'menu_plan_id', record.data->>'source_event_id'), '')
WHERE record.entity_name = 'Production'
  AND COALESCE(record.data->>'production_date', '') <> ''
ON CONFLICT (production_id) DO NOTHING;

INSERT INTO production_manifest_lines (
  production_line_id, production_id, menu_plan_line_id, line_number, recipe_version_id,
  ingredient_id, item_name, requested_servings, requested_weight_grams, produced_servings,
  produced_weight_grams, estimated_cost, actual_cost, status, source_name, payload,
  created_at, updated_at
)
SELECT
  COALESCE(NULLIF(record.data->>'source_event_recipe_id', ''), record.id || ':line:1'),
  record.id,
  NULL,
  1,
  recipe.recipe_version_id,
  ingredient.ingredient_id,
  COALESCE(NULLIF(record.data->>'recipe_name', ''), NULLIF(record.data->>'production_name', ''), record.id),
  NULLIF(COALESCE(record.data->>'target_servings', record.data->>'produced_servings'), '')::numeric,
  NULLIF(COALESCE(record.data->>'requested_weight_grams', record.data->>'production_size_grams'), '')::numeric,
  NULLIF(COALESCE(record.data->>'produced_servings', record.data->>'production_covers'), '')::numeric,
  NULLIF(COALESCE(record.data->>'produced_weight_grams', record.data->>'finished_weight_grams', record.data->>'production_size_grams'), '')::numeric,
  COALESCE(NULLIF(COALESCE(record.data->>'estimated_cost', record.data->>'estimated_batch_cost'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'actual_cost', record.data->>'production_cost_total', record.data->>'total_cost'), '')::numeric, 0),
  'active',
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN production_events production ON production.production_id = record.id
LEFT JOIN recipe_versions recipe ON recipe.recipe_version_id = NULLIF(record.data->>'recipe_id', '')
LEFT JOIN ingredients ingredient ON ingredient.ingredient_id = NULLIF(record.data->>'ingredient_id', '')
WHERE record.entity_name = 'Production'
ON CONFLICT (production_line_id) DO NOTHING;

INSERT INTO produced_output_batches (
  output_batch_id, production_id, production_line_id, warehouse_id, recipe_version_id, ingredient_id,
  batch_number, initial_weight_grams, remaining_weight_grams, initial_servings, remaining_servings,
  unit_cost, total_cost, status, source_name, payload, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'production_id',
  line.production_line_id,
  record.data->>'site_id',
  recipe.recipe_version_id,
  ingredient.ingredient_id,
  COALESCE(NULLIF(record.data->>'batch_number', ''), record.id),
  COALESCE(NULLIF(COALESCE(record.data->>'initial_weight_grams', record.data->>'produced_weight_grams'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'remaining_weight_grams', record.data->>'available_weight_grams', record.data->>'produced_weight_grams'), '')::numeric, 0),
  NULLIF(COALESCE(record.data->>'initial_servings', record.data->>'produced_servings'), '')::numeric,
  NULLIF(COALESCE(record.data->>'remaining_servings', record.data->>'available_servings', record.data->>'produced_servings'), '')::numeric,
  COALESCE(NULLIF(record.data->>'unit_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'total_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'active'),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN production_events production ON production.production_id = record.data->>'production_id'
JOIN production_manifest_lines line ON line.production_id = production.production_id
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
LEFT JOIN recipe_versions recipe ON recipe.recipe_version_id = NULLIF(record.data->>'recipe_id', '')
LEFT JOIN ingredients ingredient ON ingredient.ingredient_id = NULLIF(record.data->>'ingredient_id', '')
WHERE record.entity_name = 'ProducedItemBatch'
ON CONFLICT (output_batch_id) DO NOTHING;

INSERT INTO production_consumption_reports (
  report_id, report_number, production_id, warehouse_id, production_date,
  total_consumption_cost, total_shortage_cost, status, payload, created_at, updated_at
)
SELECT
  record.id,
  COALESCE(NULLIF(record.data->>'report_number', ''), record.id),
  record.data->>'production_id',
  NULLIF(record.data->>'site_id', ''),
  NULLIF(record.data->>'production_date', '')::date,
  COALESCE(NULLIF(record.data->>'total_consumption_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'total_shortage_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN production_events production ON production.production_id = record.data->>'production_id'
WHERE record.entity_name = 'ProductionConsumptionReport'
ON CONFLICT (report_id) DO NOTHING;

INSERT INTO meal_service_headers (
  meal_service_id, service_reference, idempotency_key, warehouse_id, service_date,
  meal_period, menu_type, menu_category, serving_size_grams, covers, status,
  payload, posted_by, reversed_by, reversed_at, source_name, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'service_reference',
  record.data->>'idempotency_key',
  record.data->>'site_id',
  (record.data->>'service_date')::date,
  COALESCE(NULLIF(record.data->>'meal_type', ''), 'breakfast'),
  COALESCE(NULLIF(record.data->>'menu_type', ''), 'general'),
  COALESCE(NULLIF(record.data->>'menu_category', ''), 'senior'),
  COALESCE(NULLIF(COALESCE(record.data->>'serving_size_grams', record.data->>'portion_size_grams'), '')::numeric, 1),
  COALESCE(NULLIF(COALESCE(record.data->>'covers', record.data->>'attendee_count'), '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  record.data || jsonb_build_object('id', record.id),
  NULLIF(COALESCE(record.data->>'posted_by', record.data->>'performed_by'), ''),
  NULLIF(record.data->>'reversed_by', ''),
  NULLIF(record.data->>'reversed_at', '')::timestamptz,
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
WHERE record.entity_name = 'MealServiceAttendance'
  AND COALESCE(record.data->>'service_reference', '') <> ''
  AND COALESCE(record.data->>'idempotency_key', '') <> ''
  AND COALESCE(record.data->>'service_date', '') <> ''
ON CONFLICT (meal_service_id) DO NOTHING;

INSERT INTO meal_service_consumptions (
  meal_consumption_id, meal_service_id, output_batch_id, production_id, recipe_version_id,
  idempotency_key, service_reference, movement_type, service_date, meal_period,
  consumed_weight_grams, consumed_servings, cost, status, payload, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'meal_service_attendance_id',
  output_batch.output_batch_id,
  production.production_id,
  recipe.recipe_version_id,
  record.data->>'idempotency_key',
  record.data->>'service_reference',
  COALESCE(NULLIF(record.data->>'movement_type', ''), 'consumption'),
  NULLIF(record.data->>'service_date', '')::date,
  NULLIF(record.data->>'meal_type', ''),
  COALESCE(NULLIF(COALESCE(record.data->>'consumed_weight_grams', record.data->>'required_weight_grams'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'consumed_servings', record.data->>'required_servings'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'cost', record.data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN meal_service_headers header ON header.meal_service_id = record.data->>'meal_service_attendance_id'
LEFT JOIN produced_output_batches output_batch
  ON output_batch.output_batch_id = NULLIF(COALESCE(record.data->>'produced_item_batch_id', record.data->'allocations'->0->>'produced_item_batch_id', record.data->'allocations'->0->>'batch_id'), '')
LEFT JOIN production_events production
  ON production.production_id = NULLIF(COALESCE(record.data->>'production_id', record.data->'allocations'->0->>'production_id'), '')
LEFT JOIN recipe_versions recipe ON recipe.recipe_version_id = NULLIF(record.data->>'recipe_id', '')
WHERE record.entity_name = 'MealServiceConsumption'
  AND COALESCE(record.data->>'idempotency_key', '') <> ''
  AND COALESCE(record.data->>'service_reference', '') <> ''
ON CONFLICT (meal_consumption_id) DO NOTHING;

INSERT INTO food_waste_records (
  food_waste_id, waste_reference, idempotency_key, warehouse_id, waste_date, meal_period,
  menu_type, menu_category, waste_category, reason_code, approval_status, status,
  recorded_by, reversed_by, reversed_at, reversal_reason, source_name, payload,
  created_at, updated_at
)
SELECT
  record.id,
  NULLIF(COALESCE(record.data->>'waste_reference', record.data->>'service_reference'), ''),
  NULLIF(record.data->>'idempotency_key', ''),
  record.data->>'site_id',
  (record.data->>'waste_date')::date,
  NULLIF(record.data->>'meal_type', ''),
  NULLIF(record.data->>'menu_type', ''),
  NULLIF(record.data->>'menu_category', ''),
  COALESCE(NULLIF(record.data->>'waste_category', ''), 'ingredient'),
  NULLIF(record.data->>'reason_code', ''),
  COALESCE(NULLIF(record.data->>'approval_status', ''), 'pending'),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  NULLIF(record.data->>'recorded_by', ''),
  NULLIF(record.data->>'reversed_by', ''),
  NULLIF(record.data->>'reversed_at', '')::timestamptz,
  NULLIF(record.data->>'reversal_reason', ''),
  NULLIF(record.data->>'source_name', ''),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
WHERE record.entity_name = 'FoodWaste'
  AND COALESCE(record.data->>'waste_date', '') <> ''
ON CONFLICT (food_waste_id) DO NOTHING;

INSERT INTO food_waste_lines (
  food_waste_line_id, food_waste_id, output_batch_id, production_line_id, ingredient_id,
  waste_weight_grams, cost, status, payload, created_at, updated_at
)
SELECT
  record.id || ':line:1',
  record.id,
  output_batch.output_batch_id,
  NULL,
  ingredient.ingredient_id,
  COALESCE(
    NULLIF(COALESCE(record.data->>'waste_weight_grams', record.data->>'quantity_grams'), '')::numeric,
    CASE WHEN LOWER(COALESCE(record.data->>'unit', 'g')) = 'kg'
      THEN COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0) * 1000
      ELSE COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0)
    END
  ),
  COALESCE(NULLIF(COALESCE(record.data->>'estimated_cost', record.data->>'waste_cost', record.data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  record.data || jsonb_build_object('id', record.id),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN food_waste_records waste ON waste.food_waste_id = record.id
LEFT JOIN produced_output_batches output_batch
  ON output_batch.output_batch_id = NULLIF(COALESCE(record.data->>'produced_item_batch_id', record.data->'output_allocations'->0->>'produced_item_batch_id'), '')
LEFT JOIN ingredients ingredient ON ingredient.ingredient_id = NULLIF(record.data->>'ingredient_id', '')
WHERE record.entity_name = 'FoodWaste'
  AND COALESCE(
    NULLIF(COALESCE(record.data->>'waste_weight_grams', record.data->>'quantity_grams'), '')::numeric,
    NULLIF(record.data->>'quantity', '')::numeric,
    0
  ) > 0
ON CONFLICT (food_waste_line_id) DO NOTHING;

-- Backfill location ownership for legacy production-quality records whenever a
-- trustworthy production or batch link is available. Records without such a
-- link remain unattributed and are intentionally excluded from scoped reports.
UPDATE entity_records AS batch
SET data = batch.data || jsonb_build_object(
      'site_id', production.data->>'site_id',
      'site_name', production.data->>'site_name',
      'updated_date', NOW()
    ),
    updated_at = NOW()
FROM entity_records AS production
WHERE batch.entity_name = 'ProductionBatch'
  AND production.entity_name = 'Production'
  AND production.id = batch.data->>'production_id'
  AND COALESCE(batch.data->>'site_id', '') = ''
  AND COALESCE(production.data->>'site_id', '') <> '';

UPDATE entity_records AS inspection
SET data = inspection.data || jsonb_build_object(
      'site_id', batch.data->>'site_id',
      'site_name', batch.data->>'site_name',
      'production_id', COALESCE(inspection.data->>'production_id', batch.data->>'production_id'),
      'updated_date', NOW()
    ),
    updated_at = NOW()
FROM entity_records AS batch
WHERE inspection.entity_name = 'QualityControl'
  AND batch.entity_name = 'ProductionBatch'
  AND batch.id = inspection.data->>'batch_id'
  AND COALESCE(inspection.data->>'site_id', '') = ''
  AND COALESCE(batch.data->>'site_id', '') <> '';

UPDATE entity_records AS inspection
SET data = inspection.data || jsonb_build_object(
      'site_id', production.data->>'site_id',
      'site_name', production.data->>'site_name',
      'updated_date', NOW()
    ),
    updated_at = NOW()
FROM entity_records AS production
WHERE inspection.entity_name = 'QualityControl'
  AND production.entity_name = 'Production'
  AND production.id = inspection.data->>'production_id'
  AND COALESCE(inspection.data->>'site_id', '') = ''
  AND COALESCE(production.data->>'site_id', '') <> '';

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
  source_name TEXT,
  actor_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bulk_upload_jobs
  ADD COLUMN IF NOT EXISTS source_name TEXT;

UPDATE entity_records
SET data = data || jsonb_build_object('source_name', 'D365'),
    updated_at = NOW()
WHERE entity_name IN ('Ingredient', 'Inventory')
  AND COALESCE(data->>'source_name', '') = '';

-- Inventory records are linked to the Ingredient master. Backfill their Item
-- Code from that source so legacy stock, lots, and stock history display the
-- same stable identifier as newly uploaded inventory.
UPDATE entity_records AS target
SET data = target.data || jsonb_build_object(
      'item_code', COALESCE(
        NULLIF(BTRIM(ingredient.data->>'item_code'), ''),
        NULLIF(BTRIM(ingredient.data->>'ingredient_code'), ''),
        NULLIF(BTRIM(ingredient.data->>'sku'), ''),
        NULLIF(BTRIM(ingredient.data->>'d365_item_id'), '')
      )
    ),
    updated_at = NOW()
FROM entity_records AS ingredient
WHERE target.entity_name IN ('Inventory', 'InventoryLot', 'InventoryTransaction')
  AND ingredient.entity_name = 'Ingredient'
  AND target.data->>'ingredient_id' = ingredient.id
  AND COALESCE(BTRIM(target.data->>'item_code'), '') = ''
  AND COALESCE(
    NULLIF(BTRIM(ingredient.data->>'item_code'), ''),
    NULLIF(BTRIM(ingredient.data->>'ingredient_code'), ''),
    NULLIF(BTRIM(ingredient.data->>'sku'), ''),
    NULLIF(BTRIM(ingredient.data->>'d365_item_id'), '')
  ) IS NOT NULL;

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
  source_event_id TEXT,
  notes TEXT,
  total_estimated_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS source_event_id TEXT;

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_requests_special_event_source_unique
  ON purchase_requests(source_event_id)
  WHERE source_type = 'special_event' AND source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_order ON goods_receipts(purchase_order_id, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_history_lookup ON supplier_price_history(ingredient_id, supplier_id, effective_date DESC);

CREATE OR REPLACE FUNCTION notify_foodpro_scoped_table_change()
RETURNS TRIGGER AS $$
DECLARE
  record_data JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    record_data := to_jsonb(OLD);
  ELSE
    record_data := to_jsonb(NEW);
  END IF;
  PERFORM pg_notify(
    'foodpro_entity_events',
    jsonb_build_object(
      'entity', TG_ARGV[0],
      'action', LOWER(TG_OP),
      'id', record_data->>'id',
      'site_id', record_data->>'site_id',
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
    WHERE tgname = 'purchase_requests_realtime_change' AND tgrelid = 'purchase_requests'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER purchase_requests_realtime_change
      AFTER INSERT OR UPDATE OR DELETE ON purchase_requests
      FOR EACH ROW EXECUTE FUNCTION notify_foodpro_scoped_table_change(''PurchaseRequest'')';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'purchase_orders_realtime_change' AND tgrelid = 'purchase_orders'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER purchase_orders_realtime_change
      AFTER INSERT OR UPDATE OR DELETE ON purchase_orders
      FOR EACH ROW EXECUTE FUNCTION notify_foodpro_scoped_table_change(''PurchaseOrder'')';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'goods_receipts_realtime_change' AND tgrelid = 'goods_receipts'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER goods_receipts_realtime_change
      AFTER INSERT OR UPDATE OR DELETE ON goods_receipts
      FOR EACH ROW EXECUTE FUNCTION notify_foodpro_scoped_table_change(''GoodsReceipt'')';
  END IF;
END;
$trigger$;

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

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lot_rotation
  ON entity_records (
    (data->>'site_id'),
    (data->>'ingredient_id'),
    (data->>'expiry_date'),
    (COALESCE(data->>'stock_date', data->>'received_date')),
    id
  )
  WHERE entity_name = 'InventoryLot';

-- New D365 mapping and idempotency constraints must be safe on databases that
-- predate those constraints. Ambiguous mappings are never resolved by picking
-- an arbitrary winner: every conflicting active mapping is cleared and marked
-- for an explicit remap, while its original value and conflict set remain in
-- legacy_metadata. Duplicate transaction keys retain the oldest deterministic
-- canonical row and quarantine only later conflicting active keys.
WITH ambiguous_ingredient_mappings AS (
  SELECT
    LOWER(BTRIM(data->>'d365_item_id')) AS normalized_value,
    jsonb_agg(id ORDER BY id) AS conflicting_record_ids
  FROM entity_records
  WHERE entity_name = 'Ingredient'
    AND COALESCE(BTRIM(data->>'d365_item_id'), '') <> ''
  GROUP BY LOWER(BTRIM(data->>'d365_item_id'))
  HAVING COUNT(*) > 1
)
UPDATE entity_records AS record
SET data = jsonb_set(
      (record.data - 'd365_item_id') || jsonb_build_object(
        'd365_mapping_status', 'needs_remap'
      ),
      '{legacy_metadata}',
      (CASE
        WHEN jsonb_typeof(record.data->'legacy_metadata') = 'object'
          THEN record.data->'legacy_metadata'
        WHEN record.data ? 'legacy_metadata'
          THEN jsonb_build_object('prior_legacy_metadata', record.data->'legacy_metadata')
        ELSE '{}'::jsonb
      END) || jsonb_build_object(
        'd365_item_id_conflict', jsonb_build_object(
          'original_value', record.data->>'d365_item_id',
          'normalized_value', ambiguous.normalized_value,
          'conflicting_record_ids', ambiguous.conflicting_record_ids,
          'resolution', 'explicit_remap_required'
        )
      ),
      true
    ),
    updated_at = NOW()
FROM ambiguous_ingredient_mappings AS ambiguous
WHERE record.entity_name = 'Ingredient'
  AND LOWER(BTRIM(record.data->>'d365_item_id')) = ambiguous.normalized_value;

WITH ambiguous_site_mappings AS (
  SELECT
    LOWER(BTRIM(data->>'d365_warehouse_id')) AS normalized_value,
    jsonb_agg(id ORDER BY id) AS conflicting_record_ids
  FROM entity_records
  WHERE entity_name = 'Site'
    AND COALESCE(BTRIM(data->>'d365_warehouse_id'), '') <> ''
  GROUP BY LOWER(BTRIM(data->>'d365_warehouse_id'))
  HAVING COUNT(*) > 1
)
UPDATE entity_records AS record
SET data = jsonb_set(
      (record.data - 'd365_warehouse_id') || jsonb_build_object(
        'd365_mapping_status', 'needs_remap'
      ),
      '{legacy_metadata}',
      (CASE
        WHEN jsonb_typeof(record.data->'legacy_metadata') = 'object'
          THEN record.data->'legacy_metadata'
        WHEN record.data ? 'legacy_metadata'
          THEN jsonb_build_object('prior_legacy_metadata', record.data->'legacy_metadata')
        ELSE '{}'::jsonb
      END) || jsonb_build_object(
        'd365_warehouse_id_conflict', jsonb_build_object(
          'original_value', record.data->>'d365_warehouse_id',
          'normalized_value', ambiguous.normalized_value,
          'conflicting_record_ids', ambiguous.conflicting_record_ids,
          'resolution', 'explicit_remap_required'
        )
      ),
      true
    ),
    updated_at = NOW()
FROM ambiguous_site_mappings AS ambiguous
WHERE record.entity_name = 'Site'
  AND LOWER(BTRIM(record.data->>'d365_warehouse_id')) = ambiguous.normalized_value;

WITH ranked_transaction_keys AS (
  SELECT
    id,
    data->>'idempotency_key' AS original_key,
    FIRST_VALUE(id) OVER (
      PARTITION BY BTRIM(data->>'idempotency_key')
      ORDER BY created_at ASC, id ASC
    ) AS canonical_transaction_id,
    ROW_NUMBER() OVER (
      PARTITION BY BTRIM(data->>'idempotency_key')
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_rank
  FROM entity_records
  WHERE entity_name = 'InventoryTransaction'
    AND COALESCE(BTRIM(data->>'idempotency_key'), '') <> ''
), duplicate_transaction_keys AS (
  SELECT id, original_key, canonical_transaction_id
  FROM ranked_transaction_keys
  WHERE duplicate_rank > 1
)
UPDATE entity_records AS record
SET data = jsonb_set(
      record.data - 'idempotency_key',
      '{legacy_metadata}',
      (CASE
        WHEN jsonb_typeof(record.data->'legacy_metadata') = 'object'
          THEN record.data->'legacy_metadata'
        WHEN record.data ? 'legacy_metadata'
          THEN jsonb_build_object('prior_legacy_metadata', record.data->'legacy_metadata')
        ELSE '{}'::jsonb
      END) || jsonb_build_object(
        'duplicate_idempotency_key', jsonb_build_object(
          'original_value', duplicate.original_key,
          'canonical_transaction_id', duplicate.canonical_transaction_id,
          'status', 'legacy_duplicate_quarantined'
        )
      ),
      true
    ),
    updated_at = NOW()
FROM duplicate_transaction_keys AS duplicate
WHERE record.id = duplicate.id
  AND record.entity_name = 'InventoryTransaction';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_inventory_transaction_idempotency
  ON entity_records ((data->>'idempotency_key'))
  WHERE entity_name = 'InventoryTransaction'
    AND COALESCE(data->>'idempotency_key', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_transaction_reference
  ON entity_records ((data->>'reference_type'), (data->>'reference_id'), (data->>'reason_code'))
  WHERE entity_name = 'InventoryTransaction';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_ingredient_d365_item_unique
  ON entity_records ((LOWER(BTRIM(data->>'d365_item_id'))))
  WHERE entity_name = 'Ingredient' AND COALESCE(BTRIM(data->>'d365_item_id'), '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_site_d365_warehouse_unique
  ON entity_records ((LOWER(BTRIM(data->>'d365_warehouse_id'))))
  WHERE entity_name = 'Site' AND COALESCE(BTRIM(data->>'d365_warehouse_id'), '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_erp_log_sync_lookup
  ON entity_records ((data->>'direction'), (data->>'module_key'), (data->>'sync_id'), updated_at DESC)
  WHERE entity_name = 'ERPIntegrationLog';

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

CREATE INDEX IF NOT EXISTS idx_entity_records_production_site_date_meal_scope
  ON entity_records (
    (data->>'site_id'),
    (data->>'fulfillment_store_id'),
    (data->>'production_date'),
    (data->>'meal_type'),
    (data->>'menu_type'),
    (data->>'menu_category'),
    (data->>'status')
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

CREATE INDEX IF NOT EXISTS idx_entity_records_inventory_lot_site_ingredient_status
  ON entity_records ((data->>'site_id'), (data->>'ingredient_id'), (data->>'status'))
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

CREATE INDEX IF NOT EXISTS idx_entity_records_food_waste_report_filters
  ON entity_records (
    (data->>'waste_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'waste_category'),
    (data->>'reason_code'),
    (data->>'waste_scope'),
    (data->>'status')
  )
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

-- Finished-food output is intentionally separate from raw Inventory and
-- InventoryLot. Production completion creates one immutable-identity output
-- batch, while meal service changes only its served/remaining balance.
DROP INDEX IF EXISTS idx_entity_records_produced_item_production_unique;
CREATE UNIQUE INDEX idx_entity_records_produced_item_production_unique
  ON entity_records ((data->>'production_id'))
  WHERE entity_name = 'ProducedItemBatch'
    AND COALESCE(data->>'production_id', '') <> ''
    AND COALESCE(data->>'status', '') <> 'voided';

DROP INDEX IF EXISTS idx_entity_records_produced_item_batch_number_unique;
CREATE UNIQUE INDEX idx_entity_records_produced_item_batch_number_unique
  ON entity_records ((data->>'batch_number'))
  WHERE entity_name = 'ProducedItemBatch'
    AND COALESCE(data->>'batch_number', '') <> ''
    AND COALESCE(data->>'status', '') <> 'voided';

CREATE INDEX IF NOT EXISTS idx_entity_records_produced_item_fifo
  ON entity_records (
    (data->>'site_id'),
    (data->>'production_date'),
    (data->>'meal_type'),
    (data->>'recipe_id'),
    (data->>'completed_at'),
    id
  )
  WHERE entity_name = 'ProducedItemBatch'
    AND COALESCE(data->>'status', '') IN ('available', 'partial');

CREATE INDEX IF NOT EXISTS idx_entity_records_produced_item_menu_fifo
  ON entity_records (
    (data->>'site_id'),
    (data->>'production_date'),
    (data->>'meal_type'),
    (data->>'menu_type'),
    (data->>'menu_category'),
    (data->>'recipe_id'),
    (data->>'completed_at'),
    id
  )
  WHERE entity_name = 'ProducedItemBatch'
    AND COALESCE(data->>'status', '') IN ('available', 'partial');

CREATE INDEX IF NOT EXISTS idx_entity_records_produced_item_menu_plan_report
  ON entity_records (
    (data->>'menu_plan_id'),
    (data->>'production_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'recipe_id'),
    id
  )
  WHERE entity_name = 'ProducedItemBatch'
    AND COALESCE(data->>'menu_plan_id', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_menu_plan_meal_service_lookup
  ON entity_records (
    (data->>'site_id'),
    (data->>'plan_date'),
    (data->>'cuisine_type'),
    (data->>'menu_category'),
    (data->>'status'),
    id
  )
  WHERE entity_name = 'MenuPlan'
    AND COALESCE(data->>'event_name', '') = '';

CREATE INDEX IF NOT EXISTS idx_entity_records_produced_item_report_date
  ON entity_records (
    (data->>'production_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'recipe_id'),
    id
  )
  WHERE entity_name = 'ProducedItemBatch';

CREATE INDEX IF NOT EXISTS idx_entity_records_produced_item_report_scope
  ON entity_records (
    (data->>'production_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'menu_type'),
    (data->>'menu_category'),
    (data->>'status'),
    id
  )
  WHERE entity_name = 'ProducedItemBatch';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_idempotency_unique
  ON entity_records ((data->>'idempotency_key'))
  WHERE entity_name = 'MealServiceAttendance'
    AND COALESCE(data->>'idempotency_key', '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_reference_unique
  ON entity_records ((data->>'service_reference'))
  WHERE entity_name = 'MealServiceAttendance'
    AND COALESCE(data->>'service_reference', '') <> '';

DROP INDEX IF EXISTS idx_entity_records_meal_attendance_scope_unique;
CREATE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_scope
  ON entity_records ((data->>'scope_key'))
  WHERE entity_name = 'MealServiceAttendance'
    AND COALESCE(data->>'scope_key', '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_reversal_unique
  ON entity_records ((data->>'reversal_idempotency_key'))
  WHERE entity_name = 'MealServiceAttendance'
    AND COALESCE(data->>'reversal_idempotency_key', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_report
  ON entity_records (
    (data->>'site_id'),
    (data->>'service_date'),
    (data->>'meal_type'),
    (data->>'status')
  )
  WHERE entity_name = 'MealServiceAttendance';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_report_date
  ON entity_records (
    (data->>'service_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    id
  )
  WHERE entity_name = 'MealServiceAttendance';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_attendance_menu_report
  ON entity_records (
    (data->>'service_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'menu_type'),
    (data->>'menu_category'),
    id
  )
  WHERE entity_name = 'MealServiceAttendance';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_records_meal_consumption_idempotency_unique
  ON entity_records ((data->>'idempotency_key'))
  WHERE entity_name = 'MealServiceConsumption'
    AND COALESCE(data->>'idempotency_key', '') <> '';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_consumption_attendance
  ON entity_records (
    (data->>'meal_service_attendance_id'),
    (data->>'movement_type'),
    (data->>'recipe_id')
  )
  WHERE entity_name = 'MealServiceConsumption';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_consumption_history
  ON entity_records (
    (data->>'meal_service_attendance_id'),
    (data->>'movement_type'),
    (data->>'performed_at')
  )
  WHERE entity_name = 'MealServiceConsumption';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_consumption_report_date
  ON entity_records (
    (data->>'service_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'recipe_id'),
    id
  )
  WHERE entity_name = 'MealServiceConsumption';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_consumption_menu_report
  ON entity_records (
    (data->>'service_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'menu_type'),
    (data->>'menu_category'),
    id
  )
  WHERE entity_name = 'MealServiceConsumption';

CREATE INDEX IF NOT EXISTS idx_entity_records_meal_consumption_report_status
  ON entity_records (
    (data->>'service_date'),
    (data->>'site_id'),
    (data->>'meal_type'),
    (data->>'menu_type'),
    (data->>'menu_category'),
    (data->>'movement_type'),
    (data->>'status'),
    id
  )
  WHERE entity_name = 'MealServiceConsumption';
