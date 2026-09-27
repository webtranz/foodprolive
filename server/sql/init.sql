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
  phone TEXT,
  language TEXT,
  avatar_url TEXT,
  visibility_scope TEXT,
  deactivated_at TIMESTAMPTZ,
  deactivated_by TEXT,
  deactivation_reason TEXT,
  password_hash TEXT NOT NULL,
  temporary_password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS visibility_scope TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;

CREATE TABLE IF NOT EXISTS user_site_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,
  site_name TEXT,
  access_scope TEXT NOT NULL DEFAULT 'assigned',
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_user_site_access_site
  ON user_site_access(site_id, user_id);

DO $user_profile_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'profile'
  ) THEN
    UPDATE users
       SET phone = COALESCE(phone, NULLIF(profile->>'phone', '')),
           language = COALESCE(language, NULLIF(profile->>'language', '')),
           avatar_url = COALESCE(avatar_url, NULLIF(profile->>'avatar_url', '')),
           visibility_scope = COALESCE(visibility_scope, NULLIF(profile->>'visibility_scope', '')),
           deactivated_at = COALESCE(deactivated_at, CASE
             WHEN COALESCE(profile->>'deactivated_at', '') ~ '^\d{4}-\d{2}-\d{2}'
               THEN NULLIF(profile->>'deactivated_at', '')::timestamptz
             ELSE NULL
           END),
           deactivated_by = COALESCE(deactivated_by, NULLIF(profile->>'deactivated_by', '')),
           deactivation_reason = COALESCE(deactivation_reason, NULLIF(profile->>'deactivation_reason', ''));

    INSERT INTO user_site_access (user_id, site_id, access_scope)
    SELECT user_row.id, allowed_site_id, 'assigned'
      FROM users user_row
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(user_row.profile->'allowed_site_ids') = 'array'
            THEN user_row.profile->'allowed_site_ids'
          ELSE '[]'::jsonb
        END
      ) AS allowed_site(allowed_site_id)
     WHERE COALESCE(BTRIM(allowed_site_id), '') <> ''
    ON CONFLICT (user_id, site_id) DO NOTHING;

    ALTER TABLE users DROP COLUMN profile;
  END IF;
END;
$user_profile_cutover$;

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

CREATE TABLE IF NOT EXISTS uploaded_files (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content BYTEA NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_storage_key
  ON uploaded_files (storage_key);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_created_at
  ON uploaded_files (created_at DESC);

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
-- Relational document tables for modules that previously shared entity_records
-- ---------------------------------------------------------------------------
-- These tables keep typed, indexed operational fields out of one large JSONB
-- bucket while preserving the full payload for screen compatibility during the
-- cutover. The API routes each module to its own physical table.
CREATE OR REPLACE FUNCTION notify_foodpro_document_table_change()
RETURNS TRIGGER AS $$
DECLARE
  record_data JSONB;
  entity_value TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    record_data := OLD.payload;
  ELSE
    record_data := NEW.payload;
  END IF;
  entity_value := TG_ARGV[0];
  PERFORM pg_notify(
    'foodpro_entity_events',
    jsonb_build_object(
      'entity', entity_value,
      'action', LOWER(TG_OP),
      'id', NULL,
      'site_id', COALESCE(record_data->>'site_id', record_data->>'warehouse_id'),
      'site_ids', COALESCE(record_data->'site_ids', '[]'::jsonb),
      'occurred_at', NOW()
    )::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $document_tables$
DECLARE
  document_table TEXT;
  entity_value TEXT;
BEGIN
  FOR document_table, entity_value IN
    SELECT *
    FROM (VALUES
      ('advanced_report_schedules', 'AdvancedReportSchedule'),
      ('erp_integration_configs', 'ERPIntegrationConfig'),
      ('erp_integration_logs', 'ERPIntegrationLog'),
      ('forecast_scenarios', 'ForecastScenario'),
      ('forecast_snapshots', 'ForecastSnapshot'),
      ('attendance_records', 'AttendanceRecord'),
      ('attendance_sessions', 'AttendanceSession'),
      ('staff_shifts', 'StaffShift'),
      ('branch_orders', 'BranchOrder'),
      ('category_qr_sessions', 'CategoryQRSession'),
      ('d365_masters', 'D365Master'),
      ('diner_scans', 'DinerScan'),
      ('customer_meal_plans', 'CustomerMealPlan'),
      ('material_requests', 'MaterialRequest'),
      ('budgets', 'Budget'),
      ('food_categories', 'FoodCategory'),
      ('menu_plan_pr_schedules', 'MenuPlanPRSchedule'),
      ('menu_plan_pr_runs', 'MenuPlanPRRun'),
      ('production_batches', 'ProductionBatch'),
      ('production_transfers', 'ProductionTransfer'),
      ('purchase_order_documents', 'PurchaseOrder'),
      ('qr_codes', 'QRCode'),
      ('role_profiles', 'RoleProfile'),
      ('qr_deliveries', 'QRDelivery'),
      ('quality_controls', 'QualityControl'),
      ('rfqs', 'RFQ'),
      ('user_groups', 'UserGroup'),
      ('waste_targets', 'WasteTarget'),
      ('waste_detection_logs', 'WasteDetectionLog')
    ) AS mapped(document_table, entity_value)
  LOOP
    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I (
        id TEXT PRIMARY KEY,
        entity_name TEXT NOT NULL DEFAULT %L,
        site_id TEXT,
        site_name TEXT,
        from_site_id TEXT,
        to_site_id TEXT,
        site_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
        status TEXT NOT NULL DEFAULT 'active',
        record_date DATE,
        source_name TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    $sql$, document_table, entity_value);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (site_id, status, updated_at DESC)', 'idx_' || document_table || '_site_status', document_table);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (record_date, status, updated_at DESC)', 'idx_' || document_table || '_record_date', document_table);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING GIN (site_ids)', 'idx_' || document_table || '_site_ids', document_table);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING GIN (payload)', 'idx_' || document_table || '_payload', document_table);
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = document_table || '_realtime_change'
        AND tgrelid = to_regclass(document_table)
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_foodpro_document_table_change(%L)',
        document_table || '_realtime_change',
        document_table,
        entity_value
      );
    END IF;
    EXECUTE format($sql$
      INSERT INTO %I (
        id, entity_name, site_id, site_name, from_site_id, to_site_id,
        site_ids, status, record_date, source_name, payload, created_at, updated_at
      )
      SELECT
        record.id,
        %L,
        COALESCE(
          NULLIF(record.data->>'site_id', ''),
          NULLIF(record.data->>'warehouse_id', ''),
          NULLIF(record.data->>'fulfillment_store_id', ''),
          NULLIF(record.data->>'requesting_site_id', '')
        ),
        NULLIF(record.data->>'site_name', ''),
        NULLIF(record.data->>'from_site_id', ''),
        NULLIF(record.data->>'to_site_id', ''),
        CASE
          WHEN jsonb_typeof(record.data->'site_ids') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(record.data->'site_ids'))
          ELSE ARRAY[]::text[]
        END,
        COALESCE(NULLIF(record.data->>'status', ''), 'active'),
        CASE
          WHEN COALESCE(
            record.data->>'record_date',
            record.data->>'date',
            record.data->>'service_date',
            record.data->>'waste_date',
            record.data->>'plan_date',
            record.data->>'production_date',
            record.data->>'request_date',
            record.data->>'order_date',
            record.data->>'event_date',
            record.data->>'shift_date',
            record.data->>'scan_date',
            record.data->>'created_date'
          ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN LEFT(COALESCE(
              record.data->>'record_date',
              record.data->>'date',
              record.data->>'service_date',
              record.data->>'waste_date',
              record.data->>'plan_date',
              record.data->>'production_date',
              record.data->>'request_date',
              record.data->>'order_date',
              record.data->>'event_date',
              record.data->>'shift_date',
              record.data->>'scan_date',
              record.data->>'created_date'
            ), 10)::date
          ELSE NULL
        END,
        NULLIF(record.data->>'source_name', ''),
        record.data || jsonb_build_object('id', record.id),
        record.created_at,
        record.updated_at
      FROM entity_records record
      WHERE record.entity_name = %L
      ON CONFLICT (id) DO NOTHING
    $sql$, document_table, entity_value, entity_value);
  END LOOP;
END;
$document_tables$;

ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS role_key TEXT;
ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'user';
ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS dashboard_variant TEXT;
ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE role_profiles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_profiles_role_key_unique
  ON role_profiles(LOWER(BTRIM(role_key)))
  WHERE COALESCE(BTRIM(role_key), '') <> '';

CREATE TABLE IF NOT EXISTS role_profile_permissions (
  role_profile_id TEXT NOT NULL REFERENCES role_profiles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_profile_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_role_profile_permissions_permission
  ON role_profile_permissions(permission_key, role_profile_id);

UPDATE role_profiles
   SET role_key = COALESCE(role_key, NULLIF(payload->>'role_key', '')),
       name = COALESCE(name, NULLIF(payload->>'name', '')),
       description = COALESCE(description, NULLIF(payload->>'description', '')),
       access_level = COALESCE(NULLIF(access_level, ''), NULLIF(payload->>'access_level', ''), 'user'),
       dashboard_variant = COALESCE(dashboard_variant, NULLIF(payload->>'dashboard_variant', '')),
       is_active = CASE
         WHEN payload ? 'is_active' THEN COALESCE((payload->>'is_active')::boolean, TRUE)
         ELSE is_active
       END,
       is_system = CASE
         WHEN payload ? 'is_system' THEN COALESCE((payload->>'is_system')::boolean, FALSE)
         ELSE is_system
       END
 WHERE payload IS NOT NULL;

INSERT INTO role_profile_permissions (role_profile_id, permission_key)
SELECT role_profile.id, permission.permission_key
  FROM role_profiles role_profile
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(role_profile.payload->'permissions') = 'array'
        THEN role_profile.payload->'permissions'
      ELSE '[]'::jsonb
    END
  ) AS permission(permission_key)
     WHERE COALESCE(BTRIM(permission.permission_key), '') <> ''
ON CONFLICT (role_profile_id, permission_key) DO NOTHING;

DROP TRIGGER IF EXISTS role_profiles_realtime_change ON role_profiles;

CREATE OR REPLACE FUNCTION notify_foodpro_role_profile_change()
RETURNS TRIGGER AS $$
DECLARE
  role_row role_profiles%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    role_row := OLD;
  ELSE
    role_row := NEW;
  END IF;
  PERFORM pg_notify(
    'foodpro_entity_events',
    jsonb_build_object(
      'entity', 'RoleProfile',
      'action', LOWER(TG_OP),
      'id', role_row.id,
      'site_id', NULL,
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

CREATE TRIGGER role_profiles_realtime_change
  AFTER INSERT OR UPDATE OR DELETE ON role_profiles
  FOR EACH ROW EXECUTE FUNCTION notify_foodpro_role_profile_change();

ALTER TABLE role_profiles DROP COLUMN IF EXISTS payload;

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
  source_type TEXT,
  source_event_id TEXT,
  source_event_name TEXT,
  source_event_recipe_id TEXT,
  source_menu_plan_item_key TEXT,
  production_issue_grouped BOOLEAN NOT NULL DEFAULT FALSE,
  production_issue_group_key TEXT,
  production_issue_scope TEXT,
  production_issue_item_count INTEGER,
  production_issue_dish_count INTEGER,
  production_issue_admin_reissue BOOLEAN NOT NULL DEFAULT FALSE,
  production_issue_reissue_run_id TEXT,
  production_issue_reissue_original_group_key TEXT,
  target_servings NUMERIC(18, 6),
  ingredient_cost_total NUMERIC(18, 6) NOT NULL DEFAULT 0,
  production_cost_total NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost_per_serving NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_shortage_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  consumption_report_id TEXT,
  consumption_report_number TEXT,
  consumption_report_name TEXT,
  consumption_report_generated_at TIMESTAMPTZ,
  produced_item_batch_id TEXT,
  produced_item_batch_number TEXT,
  yield_adjustment_applied BOOLEAN NOT NULL DEFAULT FALSE,
  yield_adjustment_version INTEGER,
  yield_adjustment_updated_at TIMESTAMPTZ,
  yield_snapshot_source TEXT,
  quantity_semantics TEXT,
  reconciliation_mode TEXT,
  output_calculation_source TEXT,
  recipe_raw_weight_grams NUMERIC(18, 6),
  total_raw_consumption_weight_grams NUMERIC(18, 6),
  total_yielded_weight_grams NUMERIC(18, 6),
  expected_finished_weight_grams NUMERIC(18, 6),
  actual_finished_weight_grams NUMERIC(18, 6),
  portion_size_grams NUMERIC(18, 6),
  portion_size_source TEXT,
  expected_yield_servings NUMERIC(18, 6),
  produced_servings NUMERIC(18, 6),
  produced_weight_grams NUMERIC(18, 6),
  completed_by_name TEXT,
  fulfillment_store_name TEXT,
  linked_material_request_id TEXT,
  linked_material_request_number TEXT,
  material_request_status TEXT,
  last_review_action TEXT,
  rejection_reason TEXT,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_name TEXT,
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

CREATE INDEX IF NOT EXISTS idx_production_events_food_cost
  ON production_events(production_date, warehouse_id, meal_period, menu_type, menu_category)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS production_manifest_lines (
  production_line_id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES production_events(production_id) ON DELETE CASCADE,
  menu_plan_line_id TEXT REFERENCES menu_plan_lines(menu_plan_line_id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL DEFAULT 0,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  line_type TEXT NOT NULL DEFAULT 'recipe',
  item_key TEXT,
  source_menu_plan_item_key TEXT,
  recipe_code TEXT,
  ingredient_name TEXT,
  meal_period TEXT,
  requested_servings NUMERIC(18, 6),
  requested_weight_grams NUMERIC(18, 6),
  produced_servings NUMERIC(18, 6),
  produced_weight_grams NUMERIC(18, 6),
  production_covers NUMERIC(18, 6),
  raw_weight_grams NUMERIC(18, 6),
  yielded_weight_grams NUMERIC(18, 6),
  expected_finished_weight_grams NUMERIC(18, 6),
  portion_size_grams NUMERIC(18, 6),
  expected_yield_servings NUMERIC(18, 6),
  output_calculation_source TEXT,
  weight_calculation_source TEXT,
  yield_calculation_source TEXT,
  weight_snapshot_version INTEGER,
  estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
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

CREATE INDEX IF NOT EXISTS idx_production_manifest_lines_active_output
  ON production_manifest_lines(production_id, recipe_version_id, ingredient_id)
  WHERE status NOT IN ('voided', 'reversed', 'cancelled');

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
  served_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  wasted_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  served_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  wasted_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  portion_size_grams NUMERIC(18, 6),
  service_portion_size_grams NUMERIC(18, 6),
  service_portion_updated_by TEXT,
  service_portion_updated_by_name TEXT,
  service_portion_updated_at TIMESTAMPTZ,
  expected_servings NUMERIC(18, 6),
  expected_finished_weight_grams NUMERIC(18, 6),
  actual_finished_weight_grams NUMERIC(18, 6),
  source_type TEXT,
  source_event_id TEXT,
  menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL,
  consumption_report_id TEXT,
  consumption_report_number TEXT,
  production_issue_grouped BOOLEAN NOT NULL DEFAULT FALSE,
  production_issue_item_count INTEGER,
  production_issue_dish_count INTEGER,
  completed_by TEXT,
  completed_by_name TEXT,
  reconciliation_mode TEXT,
  output_calculation_source TEXT,
  cutover_version INTEGER NOT NULL DEFAULT 1,
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
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

CREATE INDEX IF NOT EXISTS idx_produced_output_batches_report
  ON produced_output_batches(production_id, production_line_id, warehouse_id, status);

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
  request_fingerprint TEXT,
  reversal_idempotency_key TEXT,
  reversal_request_fingerprint TEXT,
  scope_key TEXT,
  menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL,
  menu_plan_name TEXT,
  customer_meal_plan_id TEXT,
  customer_meal_plan_name TEXT,
  customer_name TEXT,
  customer_id TEXT,
  category TEXT,
  attendee_count NUMERIC(18, 6) NOT NULL DEFAULT 0,
  scan_method TEXT,
  notes TEXT,
  required_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  required_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  served_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  served_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  shortage_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  shortage_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  recorded_by TEXT,
  recorded_by_name TEXT,
  recorded_at TIMESTAMPTZ,
  posted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_by_name TEXT,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  cutover_version INTEGER NOT NULL DEFAULT 1,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_service_lines_batch
  ON meal_service_lines(output_batch_id, status);

CREATE TABLE IF NOT EXISTS meal_service_items (
  meal_service_item_id TEXT PRIMARY KEY,
  meal_service_id TEXT NOT NULL REFERENCES meal_service_headers(meal_service_id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL DEFAULT 1,
  output_batch_id TEXT REFERENCES produced_output_batches(output_batch_id) ON DELETE SET NULL,
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL,
  recipe_name TEXT,
  item_name TEXT,
  attendee_count NUMERIC(18, 6),
  portions_per_attendee NUMERIC(18, 6),
  servings_per_attendee NUMERIC(18, 6),
  portion_size_grams NUMERIC(18, 6),
  manual_portion_size_grams NUMERIC(18, 6),
  portion_size_source TEXT,
  required_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  required_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  served_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  served_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  consumed_production_equivalent_servings NUMERIC(18, 6),
  shortage_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  shortage_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_service_items_header
  ON meal_service_items(meal_service_id, item_order);

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
  reason TEXT,
  waste_scope TEXT NOT NULL DEFAULT 'ingredient',
  source_type TEXT NOT NULL DEFAULT 'manual_entry',
  avoidable_type TEXT NOT NULL DEFAULT 'avoidable',
  preventable BOOLEAN NOT NULL DEFAULT TRUE,
  auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  high_value BOOLEAN NOT NULL DEFAULT FALSE,
  quantity_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'g',
  estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL,
  menu_plan_name TEXT,
  meal_service_id TEXT REFERENCES meal_service_headers(meal_service_id) ON DELETE SET NULL,
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE SET NULL,
  production_name TEXT,
  recipe_name TEXT,
  ingredient_name TEXT,
  batch_reference TEXT,
  batch_overproduction_item_key TEXT,
  manifest_item_key TEXT,
  source_menu_plan_item_key TEXT,
  batch_recipe_id TEXT,
  batch_recipe_name TEXT,
  produced_weight_grams NUMERIC(18, 6),
  available_weight_grams_before NUMERIC(18, 6),
  wasted_production_equivalent_servings NUMERIC(18, 6),
  served_at TIMESTAMPTZ,
  production_completed_at TIMESTAMPTZ,
  recording_window_basis TEXT,
  recording_window_open_at TIMESTAMPTZ,
  recording_deadline_at TIMESTAMPTZ,
  meal_service_adjustment_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  inventory_transaction_id TEXT,
  inventory_deduction_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  inventory_shortage_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  notes TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'posted',
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

CREATE INDEX IF NOT EXISTS idx_food_waste_records_source
  ON food_waste_records(source_type, waste_scope, status);

CREATE INDEX IF NOT EXISTS idx_food_waste_records_operational_links
  ON food_waste_records(production_id, meal_service_id, recipe_version_id, ingredient_id);

CREATE TABLE IF NOT EXISTS food_waste_lines (
  food_waste_line_id TEXT PRIMARY KEY,
  food_waste_id TEXT NOT NULL REFERENCES food_waste_records(food_waste_id) ON DELETE CASCADE,
  output_batch_id TEXT REFERENCES produced_output_batches(output_batch_id) ON DELETE RESTRICT,
  production_line_id TEXT REFERENCES production_manifest_lines(production_line_id) ON DELETE RESTRICT,
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL DEFAULT 1,
  item_name TEXT,
  batch_number TEXT,
  batch_overproduction_item_key TEXT,
  manifest_item_key TEXT,
  source_menu_plan_item_key TEXT,
  wasted_production_equivalent_servings NUMERIC(18, 6),
  produced_weight_grams_before NUMERIC(18, 6),
  available_weight_grams_before NUMERIC(18, 6),
  waste_weight_grams NUMERIC(18, 6) NOT NULL CHECK (waste_weight_grams > 0),
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_waste_lines_output_batch
  ON food_waste_lines(output_batch_id, status);

CREATE INDEX IF NOT EXISTS idx_food_waste_lines_audit
  ON food_waste_lines(food_waste_id, output_batch_id, production_line_id, ingredient_id, status);

CREATE TABLE IF NOT EXISTS food_waste_inventory_movements (
  food_waste_inventory_movement_id TEXT PRIMARY KEY,
  food_waste_id TEXT NOT NULL REFERENCES food_waste_records(food_waste_id) ON DELETE CASCADE,
  movement_order INTEGER NOT NULL DEFAULT 1,
  inventory_transaction_id TEXT,
  inventory_id TEXT REFERENCES warehouse_inventory(inventory_id) ON DELETE SET NULL,
  lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE SET NULL,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE SET NULL,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  unit TEXT,
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  stock_date DATE,
  expiry_date DATE,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_waste_inventory_movements_record
  ON food_waste_inventory_movements(food_waste_id, movement_order);

CREATE TABLE IF NOT EXISTS food_waste_images (
  food_waste_image_id TEXT PRIMARY KEY,
  food_waste_id TEXT NOT NULL REFERENCES food_waste_records(food_waste_id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  image_order INTEGER NOT NULL DEFAULT 1,
  original_name TEXT,
  content_type TEXT,
  byte_size INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(food_waste_id, image_url)
);

CREATE INDEX IF NOT EXISTS idx_food_waste_images_record
  ON food_waste_images(food_waste_id, image_order);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  inventory_transaction_id TEXT PRIMARY KEY,
  inventory_id TEXT REFERENCES warehouse_inventory(inventory_id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  warehouse_name TEXT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  ingredient_name TEXT,
  item_code TEXT,
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
  notes TEXT,
  performed_by TEXT,
  batch_number TEXT,
  expiry_date DATE,
  stock_date DATE,
  received_date DATE,
  from_warehouse_id TEXT,
  from_warehouse_name TEXT,
  to_warehouse_id TEXT,
  to_warehouse_name TEXT,
  source TEXT,
  source_type TEXT,
  balance_before NUMERIC(18, 6),
  balance_after NUMERIC(18, 6),
  opening_quantity NUMERIC(18, 6),
  addition_quantity NUMERIC(18, 6),
  consumption_quantity NUMERIC(18, 6),
  remaining_quantity NUMERIC(18, 6),
  operation TEXT,
  operation_id TEXT,
  commitment_revision INTEGER,
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

CREATE TABLE IF NOT EXISTS inventory_transaction_layers (
  inventory_transaction_layer_id TEXT PRIMARY KEY,
  inventory_transaction_id TEXT NOT NULL REFERENCES inventory_transactions(inventory_transaction_id) ON DELETE CASCADE,
  layer_order INTEGER NOT NULL,
  inventory_lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE SET NULL,
  batch_number TEXT,
  stock_date DATE,
  received_date DATE,
  expiry_date DATE,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  quantity_before NUMERIC(18, 6),
  quantity_after NUMERIC(18, 6),
  reserved_quantity_before NUMERIC(18, 6),
  reserved_quantity_after NUMERIC(18, 6),
  available_quantity_before NUMERIC(18, 6),
  available_quantity_after NUMERIC(18, 6),
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  accounting_unit_cost NUMERIC(18, 6),
  accounting_total_cost NUMERIC(18, 6),
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  commitment_revision INTEGER,
  operation_id TEXT,
  source_transaction_id TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(inventory_transaction_id, layer_order)
);

CREATE INDEX IF NOT EXISTS idx_inventory_transaction_layers_transaction
  ON inventory_transaction_layers(inventory_transaction_id, layer_order);

CREATE INDEX IF NOT EXISTS idx_inventory_transaction_layers_lot
  ON inventory_transaction_layers(inventory_lot_id);

CREATE TABLE IF NOT EXISTS inventory_transaction_metadata (
  inventory_transaction_metadata_id TEXT PRIMARY KEY,
  inventory_transaction_id TEXT NOT NULL REFERENCES inventory_transactions(inventory_transaction_id) ON DELETE CASCADE,
  metadata_key TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC(18, 6),
  value_boolean BOOLEAN,
  value_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(inventory_transaction_id, metadata_key)
);

CREATE INDEX IF NOT EXISTS idx_inventory_transaction_metadata_transaction
  ON inventory_transaction_metadata(inventory_transaction_id, metadata_key);

CREATE TABLE IF NOT EXISTS inventory_transaction_metadata_items (
  inventory_transaction_metadata_item_id TEXT PRIMARY KEY,
  inventory_transaction_id TEXT NOT NULL REFERENCES inventory_transactions(inventory_transaction_id) ON DELETE CASCADE,
  metadata_key TEXT NOT NULL,
  container_type TEXT NOT NULL DEFAULT 'array',
  item_order INTEGER NOT NULL DEFAULT 1,
  attribute_name TEXT NOT NULL DEFAULT 'value',
  attribute_value_text TEXT,
  attribute_value_numeric NUMERIC(18, 6),
  attribute_value_boolean BOOLEAN,
  attribute_value_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(inventory_transaction_id, metadata_key, container_type, item_order, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_inventory_transaction_metadata_items_transaction
  ON inventory_transaction_metadata_items(inventory_transaction_id, metadata_key, item_order);

CREATE TABLE IF NOT EXISTS production_consumption_reports (
  report_id TEXT PRIMARY KEY,
  report_number TEXT NOT NULL,
  report_name TEXT,
  production_id TEXT NOT NULL REFERENCES production_events(production_id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  warehouse_name TEXT,
  requesting_warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE SET NULL,
  requesting_warehouse_name TEXT,
  fulfillment_store_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE SET NULL,
  fulfillment_store_name TEXT,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL,
  recipe_name TEXT,
  original_recipe_name TEXT,
  production_name TEXT,
  original_production_name TEXT,
  production_date DATE,
  meal_period TEXT,
  menu_type TEXT,
  menu_category TEXT,
  menu_scope_label TEXT,
  production_issue_grouped BOOLEAN NOT NULL DEFAULT FALSE,
  production_issue_item_count INTEGER,
  production_issue_dish_count INTEGER,
  kitchen_station TEXT,
  target_servings NUMERIC(18, 6),
  completed_by TEXT,
  completed_by_name TEXT,
  completed_at TIMESTAMPTZ,
  quantity_basis TEXT,
  reconciliation_mode TEXT,
  output_calculation_source TEXT,
  recipe_raw_weight_grams NUMERIC(18, 6),
  expected_finished_weight_grams NUMERIC(18, 6),
  total_raw_consumption_weight_grams NUMERIC(18, 6),
  total_yielded_weight_grams NUMERIC(18, 6),
  portion_size_grams NUMERIC(18, 6),
  expected_yield_servings NUMERIC(18, 6),
  total_consumption_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_shortage_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  shortage_line_count INTEGER NOT NULL DEFAULT 0,
  ingredient_line_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  reversed_at TIMESTAMPTZ,
  reversed_by TEXT,
  reversed_by_name TEXT,
  reversal_reason TEXT,
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

CREATE TABLE IF NOT EXISTS production_consumption_report_lines (
  report_line_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE SET NULL,
  item_code TEXT,
  ingredient_name TEXT,
  unit TEXT,
  recipe_quantity NUMERIC(18, 6),
  recipe_unit TEXT,
  inventory_unit TEXT,
  planned_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  actual_requested_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  issued_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  shortage_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  posted_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  estimated_shortage_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  quantity_basis TEXT,
  yield_percent NUMERIC(18, 6),
  raw_weight_grams NUMERIC(18, 6),
  yielded_weight_grams NUMERIC(18, 6),
  weight_calculation_source TEXT,
  yield_calculation_source TEXT,
  unit_status TEXT,
  conversion_note TEXT,
  inventory_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_pcr_lines_report
  ON production_consumption_report_lines(report_id, line_number);
CREATE INDEX IF NOT EXISTS idx_pcr_lines_ingredient
  ON production_consumption_report_lines(ingredient_id, report_id);

CREATE TABLE IF NOT EXISTS production_consumption_report_line_sources (
  report_line_source_id TEXT PRIMARY KEY,
  report_line_id TEXT NOT NULL REFERENCES production_consumption_report_lines(report_line_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  source_order INTEGER NOT NULL,
  recipe_name TEXT NOT NULL,
  UNIQUE(report_line_id, source_order)
);

CREATE TABLE IF NOT EXISTS production_consumption_report_line_transactions (
  report_line_transaction_id TEXT PRIMARY KEY,
  report_line_id TEXT NOT NULL REFERENCES production_consumption_report_lines(report_line_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  transaction_order INTEGER NOT NULL,
  inventory_transaction_id TEXT NOT NULL,
  UNIQUE(report_line_id, inventory_transaction_id)
);

CREATE TABLE IF NOT EXISTS production_consumption_report_line_layers (
  report_line_layer_id TEXT PRIMARY KEY,
  report_line_id TEXT NOT NULL REFERENCES production_consumption_report_lines(report_line_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  layer_order INTEGER NOT NULL,
  inventory_lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE SET NULL,
  batch_number TEXT,
  stock_date DATE,
  received_date DATE,
  expiry_date DATE,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  quantity_before NUMERIC(18, 6),
  quantity_after NUMERIC(18, 6),
  reserved_quantity_before NUMERIC(18, 6),
  reserved_quantity_after NUMERIC(18, 6),
  available_quantity_before NUMERIC(18, 6),
  available_quantity_after NUMERIC(18, 6),
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  accounting_unit_cost NUMERIC(18, 6),
  accounting_total_cost NUMERIC(18, 6),
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  commitment_revision INTEGER,
  operation_id TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_line_id, layer_order)
);

CREATE INDEX IF NOT EXISTS idx_pcr_line_layers_report
  ON production_consumption_report_line_layers(report_id, layer_order);

CREATE TABLE IF NOT EXISTS production_consumption_report_menu_items (
  report_menu_item_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL,
  production_line_id TEXT REFERENCES production_manifest_lines(production_line_id) ON DELETE SET NULL,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  recipe_name TEXT,
  line_type TEXT,
  item_key TEXT,
  source_menu_plan_item_key TEXT,
  original_source_menu_plan_item_key TEXT,
  recipe_code TEXT,
  ingredient_name TEXT,
  meal_period TEXT,
  requested_servings NUMERIC(18, 6),
  requested_weight_grams NUMERIC(18, 6),
  produced_servings NUMERIC(18, 6),
  produced_weight_grams NUMERIC(18, 6),
  production_covers NUMERIC(18, 6),
  raw_weight_grams NUMERIC(18, 6),
  yielded_weight_grams NUMERIC(18, 6),
  expected_finished_weight_grams NUMERIC(18, 6),
  portion_size_grams NUMERIC(18, 6),
  expected_yield_servings NUMERIC(18, 6),
  output_calculation_source TEXT,
  weight_calculation_source TEXT,
  yield_calculation_source TEXT,
  weight_snapshot_version INTEGER,
  estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_id, item_order)
);

CREATE INDEX IF NOT EXISTS idx_pcr_menu_items_report
  ON production_consumption_report_menu_items(report_id, item_order);

CREATE TABLE IF NOT EXISTS production_consumption_report_unit_totals (
  report_unit_total_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  unit TEXT NOT NULL,
  shortage_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  UNIQUE(report_id, unit)
);

CREATE TABLE IF NOT EXISTS production_consumption_report_events (
  report_event_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_order INTEGER NOT NULL,
  event_timestamp TIMESTAMPTZ,
  actor_id TEXT,
  actor_email TEXT,
  actor_name TEXT,
  reason TEXT,
  returned_line_count INTEGER NOT NULL DEFAULT 0,
  returned_total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  served_weight_grams NUMERIC(18, 6),
  wasted_weight_grams NUMERIC(18, 6),
  served_servings NUMERIC(18, 6),
  wasted_servings NUMERIC(18, 6),
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_id, event_type, event_order)
);

CREATE INDEX IF NOT EXISTS idx_pcr_events_report
  ON production_consumption_report_events(report_id, event_order);

CREATE TABLE IF NOT EXISTS production_consumption_report_event_manifest_items (
  report_event_manifest_item_id TEXT PRIMARY KEY,
  report_event_id TEXT NOT NULL REFERENCES production_consumption_report_events(report_event_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL,
  item_key TEXT,
  item_name TEXT,
  reversed_weight_grams NUMERIC(18, 6),
  reversal_ratio NUMERIC(18, 6),
  UNIQUE(report_event_id, item_order)
);

CREATE TABLE IF NOT EXISTS production_consumption_report_event_lines (
  report_event_line_id TEXT PRIMARY KEY,
  report_event_id TEXT NOT NULL REFERENCES production_consumption_report_events(report_event_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL,
  source_line_index INTEGER,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE SET NULL,
  item_code TEXT,
  ingredient_name TEXT,
  unit TEXT,
  requested_quantity NUMERIC(18, 6),
  returned_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  inventory_transaction_id TEXT,
  UNIQUE(report_event_id, line_order)
);

CREATE TABLE IF NOT EXISTS production_consumption_report_event_line_layers (
  report_event_line_layer_id TEXT PRIMARY KEY,
  report_event_line_id TEXT NOT NULL REFERENCES production_consumption_report_event_lines(report_event_line_id) ON DELETE CASCADE,
  report_event_id TEXT NOT NULL REFERENCES production_consumption_report_events(report_event_id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES production_consumption_reports(report_id) ON DELETE CASCADE,
  layer_order INTEGER NOT NULL,
  inventory_lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE SET NULL,
  batch_number TEXT,
  stock_date DATE,
  received_date DATE,
  expiry_date DATE,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  quantity_before NUMERIC(18, 6),
  quantity_after NUMERIC(18, 6),
  reserved_quantity_before NUMERIC(18, 6),
  reserved_quantity_after NUMERIC(18, 6),
  available_quantity_before NUMERIC(18, 6),
  available_quantity_after NUMERIC(18, 6),
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  accounting_unit_cost NUMERIC(18, 6),
  accounting_total_cost NUMERIC(18, 6),
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  commitment_revision INTEGER,
  operation_id TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_event_line_id, layer_order)
);

CREATE TABLE IF NOT EXISTS meal_service_consumptions (
  meal_consumption_id TEXT PRIMARY KEY,
  meal_service_id TEXT NOT NULL REFERENCES meal_service_headers(meal_service_id) ON DELETE CASCADE,
  output_batch_id TEXT REFERENCES produced_output_batches(output_batch_id) ON DELETE RESTRICT,
  production_id TEXT REFERENCES production_events(production_id) ON DELETE RESTRICT,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  reverses_consumption_id TEXT REFERENCES meal_service_consumptions(meal_consumption_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  service_reference TEXT NOT NULL,
  movement_type TEXT NOT NULL DEFAULT 'consumption',
  service_date DATE,
  meal_period TEXT,
  consumed_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  consumed_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL,
  menu_type TEXT,
  menu_category TEXT,
  customer_meal_plan_id TEXT,
  recipe_name TEXT,
  attendee_count NUMERIC(18, 6),
  portions_per_attendee NUMERIC(18, 6),
  servings_per_attendee NUMERIC(18, 6),
  portion_size_grams NUMERIC(18, 6),
  manual_portion_size_grams NUMERIC(18, 6),
  portion_size_source TEXT,
  covers NUMERIC(18, 6),
  required_servings NUMERIC(18, 6),
  required_weight_grams NUMERIC(18, 6),
  consumed_production_equivalent_servings NUMERIC(18, 6),
  shortage_servings NUMERIC(18, 6),
  shortage_weight_grams NUMERIC(18, 6),
  reversal_reason TEXT,
  performed_by TEXT,
  performed_by_name TEXT,
  performed_at TIMESTAMPTZ,
  cutover_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS reverses_consumption_id TEXT REFERENCES meal_service_consumptions(meal_consumption_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_service_consumptions_idempotency_unique
  ON meal_service_consumptions(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumptions_header
  ON meal_service_consumptions(meal_service_id, status);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumptions_report
  ON meal_service_consumptions(service_date, meal_period, status);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumptions_reversal
  ON meal_service_consumptions(reverses_consumption_id)
  WHERE reverses_consumption_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meal_service_consumptions_food_cost
  ON meal_service_consumptions(service_date, meal_period, movement_type, status, meal_service_id, output_batch_id, production_id);

CREATE TABLE IF NOT EXISTS meal_service_consumption_allocations (
  meal_service_consumption_allocation_id TEXT PRIMARY KEY,
  meal_consumption_id TEXT NOT NULL REFERENCES meal_service_consumptions(meal_consumption_id) ON DELETE CASCADE,
  allocation_order INTEGER NOT NULL DEFAULT 1,
  output_batch_id TEXT REFERENCES produced_output_batches(output_batch_id) ON DELETE SET NULL,
  production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL,
  batch_number TEXT,
  portion_size_grams NUMERIC(18, 6),
  service_portion_size_grams NUMERIC(18, 6),
  servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  production_equivalent_servings NUMERIC(18, 6) NOT NULL DEFAULT 0,
  meal_portions NUMERIC(18, 6) NOT NULL DEFAULT 0,
  weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0,
  remaining_servings_before NUMERIC(18, 6),
  remaining_servings_after NUMERIC(18, 6),
  remaining_weight_grams_before NUMERIC(18, 6),
  remaining_weight_grams_after NUMERIC(18, 6),
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumption_allocations_consumption
  ON meal_service_consumption_allocations(meal_consumption_id, allocation_order);

CREATE INDEX IF NOT EXISTS idx_meal_service_consumption_allocations_batch
  ON meal_service_consumption_allocations(output_batch_id, status);

-- ---------------------------------------------------------------------------
-- CPU / central production schema
-- ---------------------------------------------------------------------------
-- CPU runs are modeled separately from store production because central
-- production creates finished output that can be dispatched, received, and cost
-- allocated across multiple destination warehouses.
CREATE TABLE IF NOT EXISTS cpu_production_orders (
  cpu_order_id TEXT PRIMARY KEY,
  cpu_warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  area_id TEXT REFERENCES areas(area_id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  production_date DATE NOT NULL,
  meal_period TEXT,
  menu_type TEXT,
  menu_category TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  reversed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_production_order_lines (
  cpu_order_line_id TEXT PRIMARY KEY,
  cpu_order_id TEXT NOT NULL REFERENCES cpu_production_orders(cpu_order_id) ON DELETE CASCADE,
  destination_warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL,
  menu_plan_line_id TEXT REFERENCES menu_plan_lines(menu_plan_line_id) ON DELETE SET NULL,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  requested_servings NUMERIC(14, 3),
  requested_weight_grams NUMERIC(14, 3),
  produced_weight_grams NUMERIC(14, 3) NOT NULL DEFAULT 0,
  produced_servings NUMERIC(14, 3) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_manifest_lines (
  cpu_manifest_line_id TEXT PRIMARY KEY,
  cpu_order_id TEXT NOT NULL REFERENCES cpu_production_orders(cpu_order_id) ON DELETE CASCADE,
  cpu_order_line_id TEXT REFERENCES cpu_production_order_lines(cpu_order_line_id) ON DELETE CASCADE,
  recipe_line_id TEXT REFERENCES recipe_ingredient_lines(recipe_line_id) ON DELETE SET NULL,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  required_quantity NUMERIC(14, 6) NOT NULL DEFAULT 0,
  unit TEXT,
  estimated_unit_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  estimated_line_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_consumption_lines (
  cpu_consumption_line_id TEXT PRIMARY KEY,
  cpu_order_id TEXT NOT NULL REFERENCES cpu_production_orders(cpu_order_id) ON DELETE CASCADE,
  cpu_manifest_line_id TEXT REFERENCES cpu_manifest_lines(cpu_manifest_line_id) ON DELETE SET NULL,
  inventory_id TEXT REFERENCES warehouse_inventory(inventory_id) ON DELETE RESTRICT,
  lot_id TEXT REFERENCES inventory_lots(lot_id) ON DELETE RESTRICT,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  issued_quantity NUMERIC(14, 6) NOT NULL DEFAULT 0,
  unit TEXT,
  unit_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_output_batches (
  cpu_output_batch_id TEXT PRIMARY KEY,
  cpu_order_id TEXT NOT NULL REFERENCES cpu_production_orders(cpu_order_id) ON DELETE RESTRICT,
  cpu_order_line_id TEXT NOT NULL REFERENCES cpu_production_order_lines(cpu_order_line_id) ON DELETE RESTRICT,
  cpu_warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE RESTRICT,
  ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE RESTRICT,
  batch_number TEXT NOT NULL,
  initial_weight_grams NUMERIC(14, 3) NOT NULL DEFAULT 0,
  remaining_weight_grams NUMERIC(14, 3) NOT NULL DEFAULT 0,
  initial_servings NUMERIC(14, 3),
  remaining_servings NUMERIC(14, 3),
  unit_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_dispatches (
  cpu_dispatch_id TEXT PRIMARY KEY,
  cpu_order_id TEXT REFERENCES cpu_production_orders(cpu_order_id) ON DELETE SET NULL,
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  dispatch_date DATE NOT NULL,
  dispatched_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft',
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_dispatch_lines (
  cpu_dispatch_line_id TEXT PRIMARY KEY,
  cpu_dispatch_id TEXT NOT NULL REFERENCES cpu_dispatches(cpu_dispatch_id) ON DELETE CASCADE,
  cpu_output_batch_id TEXT NOT NULL REFERENCES cpu_output_batches(cpu_output_batch_id) ON DELETE RESTRICT,
  dispatched_weight_grams NUMERIC(14, 3) NOT NULL DEFAULT 0,
  dispatched_servings NUMERIC(14, 3),
  received_weight_grams NUMERIC(14, 3),
  received_servings NUMERIC(14, 3),
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_receipts (
  cpu_receipt_id TEXT PRIMARY KEY,
  cpu_dispatch_id TEXT NOT NULL REFERENCES cpu_dispatches(cpu_dispatch_id) ON DELETE RESTRICT,
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  received_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'posted',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cpu_cost_allocations (
  cpu_cost_allocation_id TEXT PRIMARY KEY,
  cpu_order_id TEXT REFERENCES cpu_production_orders(cpu_order_id) ON DELETE SET NULL,
  cpu_output_batch_id TEXT REFERENCES cpu_output_batches(cpu_output_batch_id) ON DELETE SET NULL,
  destination_warehouse_id TEXT NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
  allocation_basis TEXT NOT NULL DEFAULT 'weight',
  allocated_weight_grams NUMERIC(14, 3) NOT NULL DEFAULT 0,
  allocated_servings NUMERIC(14, 3),
  allocated_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cpu_production_orders_scope
  ON cpu_production_orders(cpu_warehouse_id, production_date, meal_period, status);
CREATE INDEX IF NOT EXISTS idx_cpu_order_lines_destination
  ON cpu_production_order_lines(destination_warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_cpu_manifest_lines_order
  ON cpu_manifest_lines(cpu_order_id, ingredient_id);
CREATE INDEX IF NOT EXISTS idx_cpu_consumption_lines_order
  ON cpu_consumption_lines(cpu_order_id, ingredient_id, lot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpu_output_batches_batch_number
  ON cpu_output_batches(batch_number);
CREATE INDEX IF NOT EXISTS idx_cpu_output_batches_fifo
  ON cpu_output_batches(cpu_warehouse_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cpu_dispatches_route
  ON cpu_dispatches(from_warehouse_id, to_warehouse_id, dispatch_date, status);
CREATE INDEX IF NOT EXISTS idx_cpu_dispatch_lines_batch
  ON cpu_dispatch_lines(cpu_output_batch_id, status);
CREATE INDEX IF NOT EXISTS idx_cpu_receipts_dispatch
  ON cpu_receipts(cpu_dispatch_id, status);
CREATE INDEX IF NOT EXISTS idx_cpu_cost_allocations_destination
  ON cpu_cost_allocations(destination_warehouse_id, status, created_at DESC);

ALTER TABLE cpu_production_orders DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_production_order_lines DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_manifest_lines DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_consumption_lines DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_output_batches DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_dispatches DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_dispatch_lines DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_receipts DROP COLUMN IF EXISTS payload;
ALTER TABLE cpu_cost_allocations DROP COLUMN IF EXISTS payload;

ALTER TABLE areas DROP COLUMN IF EXISTS payload;
ALTER TABLE projects DROP COLUMN IF EXISTS payload;
ALTER TABLE warehouses DROP COLUMN IF EXISTS payload;
ALTER TABLE ingredients DROP COLUMN IF EXISTS payload;
ALTER TABLE warehouse_inventory DROP COLUMN IF EXISTS payload;
ALTER TABLE inventory_lots DROP COLUMN IF EXISTS payload;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS warehouse_name TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS ingredient_name TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS item_code TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS performed_by TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS batch_number TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS stock_date DATE;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS received_date DATE;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS from_warehouse_id TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS from_warehouse_name TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS to_warehouse_id TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS to_warehouse_name TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS balance_before NUMERIC(18, 6);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS balance_after NUMERIC(18, 6);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS opening_quantity NUMERIC(18, 6);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS addition_quantity NUMERIC(18, 6);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS consumption_quantity NUMERIC(18, 6);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS remaining_quantity NUMERIC(18, 6);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS operation TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS operation_id TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS commitment_revision INTEGER;
DO $recipe_menu_payload_cleanup$
DECLARE
  cleanup_target RECORD;
  has_payload_column BOOLEAN;
  has_non_empty_payload BOOLEAN;
BEGIN
  FOR cleanup_target IN
    SELECT * FROM (VALUES
      ('recipes'),
      ('recipe_versions'),
      ('menu_plans'),
      ('menu_plan_lines')
    ) AS targets(table_name)
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = cleanup_target.table_name
        AND column_name = 'payload'
    ) INTO has_payload_column;

    IF has_payload_column THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I WHERE payload IS NOT NULL AND payload <> ''{}''::jsonb)',
        cleanup_target.table_name
      ) INTO has_non_empty_payload;

      IF NOT has_non_empty_payload THEN
        EXECUTE format('ALTER TABLE %I DROP COLUMN payload', cleanup_target.table_name);
      END IF;
    END IF;
  END LOOP;
END;
$recipe_menu_payload_cleanup$;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS source_event_name TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS source_event_recipe_id TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS source_menu_plan_item_key TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_grouped BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_group_key TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_scope TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_item_count INTEGER;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_dish_count INTEGER;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_admin_reissue BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_reissue_run_id TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_issue_reissue_original_group_key TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS target_servings NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS ingredient_cost_total NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS production_cost_total NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS cost_per_serving NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS total_shortage_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS consumption_report_id TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS consumption_report_number TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS consumption_report_name TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS consumption_report_generated_at TIMESTAMPTZ;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS produced_item_batch_id TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS produced_item_batch_number TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS yield_adjustment_applied BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS yield_adjustment_version INTEGER;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS yield_adjustment_updated_at TIMESTAMPTZ;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS yield_snapshot_source TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS quantity_semantics TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS reconciliation_mode TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS output_calculation_source TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS recipe_raw_weight_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS total_raw_consumption_weight_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS total_yielded_weight_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS expected_finished_weight_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS actual_finished_weight_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS portion_size_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS portion_size_source TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS expected_yield_servings NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS produced_servings NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS produced_weight_grams NUMERIC(18, 6);
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS completed_by_name TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS fulfillment_store_name TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS linked_material_request_id TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS linked_material_request_number TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS material_request_status TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS last_review_action TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE production_events ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'recipe';
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS item_key TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS source_menu_plan_item_key TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS recipe_code TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS ingredient_name TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS meal_period TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS production_covers NUMERIC(18, 6);
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS raw_weight_grams NUMERIC(18, 6);
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS yielded_weight_grams NUMERIC(18, 6);
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS expected_finished_weight_grams NUMERIC(18, 6);
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS portion_size_grams NUMERIC(18, 6);
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS expected_yield_servings NUMERIC(18, 6);
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS output_calculation_source TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS weight_calculation_source TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS yield_calculation_source TEXT;
ALTER TABLE production_manifest_lines ADD COLUMN IF NOT EXISTS weight_snapshot_version INTEGER;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS served_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS wasted_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS served_servings NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS wasted_servings NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS portion_size_grams NUMERIC(18, 6);
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS service_portion_size_grams NUMERIC(18, 6);
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS service_portion_updated_by TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS service_portion_updated_by_name TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS service_portion_updated_at TIMESTAMPTZ;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS expected_servings NUMERIC(18, 6);
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS expected_finished_weight_grams NUMERIC(18, 6);
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS actual_finished_weight_grams NUMERIC(18, 6);
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS consumption_report_id TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS consumption_report_number TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS production_issue_grouped BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS production_issue_item_count INTEGER;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS production_issue_dish_count INTEGER;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS completed_by TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS completed_by_name TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS reconciliation_mode TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS output_calculation_source TEXT;
ALTER TABLE produced_output_batches ADD COLUMN IF NOT EXISTS cutover_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS report_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS warehouse_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS requesting_warehouse_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE SET NULL;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS requesting_warehouse_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS fulfillment_store_id TEXT REFERENCES warehouses(warehouse_id) ON DELETE SET NULL;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS fulfillment_store_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS recipe_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS original_recipe_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS production_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS original_production_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS meal_period TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS menu_type TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS menu_category TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS menu_scope_label TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS production_issue_grouped BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS production_issue_item_count INTEGER;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS production_issue_dish_count INTEGER;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS kitchen_station TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS target_servings NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS completed_by TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS completed_by_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS quantity_basis TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS reconciliation_mode TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS output_calculation_source TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS recipe_raw_weight_grams NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS expected_finished_weight_grams NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS total_raw_consumption_weight_grams NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS total_yielded_weight_grams NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS portion_size_grams NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS expected_yield_servings NUMERIC(18, 6);
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS shortage_line_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS ingredient_line_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS reversed_by TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS reversed_by_name TEXT;
ALTER TABLE production_consumption_reports ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS reversal_idempotency_key TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS reversal_request_fingerprint TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS scope_key TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS menu_plan_name TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS customer_meal_plan_id TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS customer_meal_plan_name TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS attendee_count NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS scan_method TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS required_servings NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS required_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS served_servings NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS served_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS shortage_servings NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS shortage_weight_grams NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS recorded_by TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS recorded_by_name TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS reversed_by_name TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE meal_service_headers ADD COLUMN IF NOT EXISTS cutover_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS menu_type TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS menu_category TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS customer_meal_plan_id TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS recipe_name TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS attendee_count NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS portions_per_attendee NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS servings_per_attendee NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS portion_size_grams NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS manual_portion_size_grams NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS portion_size_source TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS covers NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS required_servings NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS required_weight_grams NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS consumed_production_equivalent_servings NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS shortage_servings NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS shortage_weight_grams NUMERIC(18, 6);
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS performed_by TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS performed_by_name TEXT;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS performed_at TIMESTAMPTZ;
ALTER TABLE meal_service_consumptions ADD COLUMN IF NOT EXISTS cutover_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS waste_scope TEXT NOT NULL DEFAULT 'ingredient';
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual_entry';
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS avoidable_type TEXT NOT NULL DEFAULT 'avoidable';
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS preventable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS high_value BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS quantity_grams NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'g';
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS menu_plan_id TEXT REFERENCES menu_plans(menu_plan_id) ON DELETE SET NULL;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS menu_plan_name TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS meal_service_id TEXT REFERENCES meal_service_headers(meal_service_id) ON DELETE SET NULL;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS ingredient_id TEXT REFERENCES ingredients(ingredient_id) ON DELETE SET NULL;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS production_name TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS recipe_name TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS ingredient_name TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS batch_reference TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS batch_overproduction_item_key TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS manifest_item_key TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS source_menu_plan_item_key TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS batch_recipe_id TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS batch_recipe_name TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS produced_weight_grams NUMERIC(18, 6);
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS available_weight_grams_before NUMERIC(18, 6);
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS wasted_production_equivalent_servings NUMERIC(18, 6);
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS production_completed_at TIMESTAMPTZ;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS recording_window_basis TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS recording_window_open_at TIMESTAMPTZ;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS recording_deadline_at TIMESTAMPTZ;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS meal_service_adjustment_cost NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS inventory_transaction_id TEXT;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS inventory_deduction_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS inventory_shortage_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE food_waste_records ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS production_id TEXT REFERENCES production_events(production_id) ON DELETE SET NULL;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS recipe_version_id TEXT REFERENCES recipe_versions(recipe_version_id) ON DELETE SET NULL;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS line_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS item_name TEXT;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS batch_number TEXT;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS batch_overproduction_item_key TEXT;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS manifest_item_key TEXT;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS source_menu_plan_item_key TEXT;
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS wasted_production_equivalent_servings NUMERIC(18, 6);
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS produced_weight_grams_before NUMERIC(18, 6);
ALTER TABLE food_waste_lines ADD COLUMN IF NOT EXISTS available_weight_grams_before NUMERIC(18, 6);

-- Backfill core legacy JSON documents into the normalized cutover tables. The
-- INSERT order follows the real foreign-key chain so a restart is safe and
-- idempotent. Rows with missing parents are skipped instead of inventing links.
INSERT INTO areas (area_id, area_code, name, legacy_site_id, status, source_name, created_at, updated_at)
SELECT
  record.id,
  NULLIF(BTRIM(COALESCE(record.data->>'area_code', record.data->>'project_code')), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  record.id,
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Site'
  AND LOWER(COALESCE(NULLIF(record.data->>'type', ''), 'area')) IN ('area', 'company', 'region')
ON CONFLICT (area_id) DO NOTHING;

INSERT INTO projects (project_id, area_id, project_code, name, legacy_site_id, status, source_name, created_at, updated_at)
SELECT
  record.id,
  record.data->>'parent_site_id',
  NULLIF(BTRIM(record.data->>'project_code'), ''),
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  record.id,
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN areas parent_area ON parent_area.area_id = record.data->>'parent_site_id'
WHERE record.entity_name = 'Site'
  AND LOWER(COALESCE(record.data->>'type', '')) IN ('project', 'location', 'branch', 'camp', 'headquarters')
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO warehouses (
  warehouse_id, project_id, warehouse_code, d365_warehouse_id, name, legacy_site_id,
  status, source_name, created_at, updated_at
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
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN projects parent_project ON parent_project.project_id = record.data->>'parent_site_id'
WHERE record.entity_name = 'Site'
  AND LOWER(COALESCE(record.data->>'type', '')) IN ('store', 'warehouse', 'kitchen')
ON CONFLICT (warehouse_id) DO NOTHING;

INSERT INTO ingredients (
  ingredient_id, item_code, ingredient_code, sku, d365_item_id, name, base_unit,
  category_id, status, source_name, created_at, updated_at
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
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Ingredient'
ON CONFLICT (ingredient_id) DO NOTHING;

INSERT INTO warehouse_inventory (
  inventory_id, warehouse_id, ingredient_id, available_quantity, reserved_quantity,
  on_hand_quantity, average_unit_cost, last_unit_cost, stock_unit, status,
  source_name, created_at, updated_at
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
  created_at, updated_at
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
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouse_inventory inventory
  ON inventory.warehouse_id = record.data->>'site_id'
 AND inventory.ingredient_id = record.data->>'ingredient_id'
WHERE record.entity_name = 'InventoryLot'
ON CONFLICT (lot_id) DO NOTHING;

INSERT INTO inventory_transactions (
  inventory_transaction_id, inventory_id, warehouse_id, warehouse_name,
  ingredient_id, ingredient_name, item_code, lot_id, transaction_type,
  transaction_date, quantity, unit, unit_cost, total_cost, reference_type,
  reference_id, reason_code, idempotency_key, status, source_name, notes,
  performed_by, batch_number, expiry_date, stock_date, received_date,
  from_warehouse_id, from_warehouse_name, to_warehouse_id, to_warehouse_name,
  source, source_type, balance_before, balance_after, opening_quantity,
  addition_quantity, consumption_quantity, remaining_quantity, operation,
  operation_id, commitment_revision, created_at, updated_at
)
SELECT
  record.id,
  inventory.inventory_id,
  warehouse.warehouse_id,
  COALESCE(NULLIF(record.data->>'site_name', ''), warehouse.name),
  ingredient.ingredient_id,
  COALESCE(NULLIF(record.data->>'ingredient_name', ''), ingredient.name),
  COALESCE(
    NULLIF(record.data->>'item_code', ''),
    NULLIF(ingredient.item_code, ''),
    NULLIF(ingredient.ingredient_code, ''),
    NULLIF(ingredient.d365_item_id, '')
  ),
  lot.lot_id,
  COALESCE(NULLIF(record.data->>'transaction_type', ''), NULLIF(record.data->>'type', ''), 'adjustment'),
  NULLIF(COALESCE(record.data->>'transaction_date', record.data->>'date', record.data->>'created_date'), '')::date,
  COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0),
  NULLIF(record.data->>'unit', ''),
  COALESCE(NULLIF(COALESCE(record.data->>'unit_cost', record.data->>'cost_per_unit'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'total_cost', record.data->>'value'), '')::numeric, 0),
  NULLIF(record.data->>'reference_type', ''),
  NULLIF(record.data->>'reference_id', ''),
  NULLIF(record.data->>'reason_code', ''),
  NULLIF(record.data->>'idempotency_key', ''),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  NULLIF(record.data->>'source_name', ''),
  NULLIF(record.data->>'notes', ''),
  NULLIF(record.data->>'performed_by', ''),
  NULLIF(record.data->>'batch_number', ''),
  NULLIF(record.data->>'expiry_date', '')::date,
  NULLIF(record.data->>'stock_date', '')::date,
  NULLIF(record.data->>'received_date', '')::date,
  NULLIF(record.data->>'from_site_id', ''),
  NULLIF(record.data->>'from_site_name', ''),
  NULLIF(record.data->>'to_site_id', ''),
  NULLIF(record.data->>'to_site_name', ''),
  NULLIF(record.data->>'source', ''),
  NULLIF(record.data->>'source_type', ''),
  NULLIF(record.data->>'balance_before', '')::numeric,
  NULLIF(record.data->>'balance_after', '')::numeric,
  NULLIF(record.data->>'opening_quantity', '')::numeric,
  NULLIF(record.data->>'addition_quantity', '')::numeric,
  NULLIF(record.data->>'consumption_quantity', '')::numeric,
  NULLIF(record.data->>'remaining_quantity', '')::numeric,
  NULLIF(record.data->>'operation', ''),
  NULLIF(record.data->>'operation_id', ''),
  NULLIF(record.data->>'commitment_revision', '')::integer,
  record.created_at,
  record.updated_at
FROM entity_records record
LEFT JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
LEFT JOIN ingredients ingredient ON ingredient.ingredient_id = record.data->>'ingredient_id'
LEFT JOIN warehouse_inventory inventory
  ON inventory.warehouse_id = warehouse.warehouse_id
 AND inventory.ingredient_id = ingredient.ingredient_id
LEFT JOIN inventory_lots lot
  ON lot.lot_id = COALESCE(NULLIF(record.data->>'lot_id', ''), NULLIF(record.data->>'inventory_lot_id', ''))
WHERE record.entity_name = 'InventoryTransaction'
ON CONFLICT (inventory_transaction_id) DO NOTHING;

INSERT INTO inventory_transaction_layers (
  inventory_transaction_layer_id, inventory_transaction_id, layer_order,
  inventory_lot_id, batch_number, stock_date, received_date, expiry_date,
  quantity, quantity_before, quantity_after, reserved_quantity_before,
  reserved_quantity_after, available_quantity_before, available_quantity_after,
  unit_cost, total_cost, accounting_unit_cost, accounting_total_cost,
  production_id, commitment_revision, operation_id, source_transaction_id,
  source_name, created_at
)
SELECT
  record.id || ':layer:' || layer_rows.layer_order,
  record.id,
  layer_rows.layer_order,
  lot.lot_id,
  NULLIF(layer_rows.layer_data->>'batch_number', ''),
  NULLIF(layer_rows.layer_data->>'stock_date', '')::date,
  NULLIF(layer_rows.layer_data->>'received_date', '')::date,
  NULLIF(layer_rows.layer_data->>'expiry_date', '')::date,
  COALESCE(NULLIF(layer_rows.layer_data->>'quantity', '')::numeric, 0),
  NULLIF(layer_rows.layer_data->>'quantity_before', '')::numeric,
  NULLIF(layer_rows.layer_data->>'quantity_after', '')::numeric,
  NULLIF(layer_rows.layer_data->>'reserved_quantity_before', '')::numeric,
  NULLIF(layer_rows.layer_data->>'reserved_quantity_after', '')::numeric,
  NULLIF(layer_rows.layer_data->>'available_quantity_before', '')::numeric,
  NULLIF(layer_rows.layer_data->>'available_quantity_after', '')::numeric,
  COALESCE(NULLIF(layer_rows.layer_data->>'unit_cost', '')::numeric, 0),
  COALESCE(NULLIF(layer_rows.layer_data->>'total_cost', '')::numeric, 0),
  NULLIF(layer_rows.layer_data->>'accounting_unit_cost', '')::numeric,
  NULLIF(layer_rows.layer_data->>'accounting_total_cost', '')::numeric,
  production.production_id,
  NULLIF(layer_rows.layer_data->>'commitment_revision', '')::integer,
  NULLIF(layer_rows.layer_data->>'operation_id', ''),
  NULLIF(COALESCE(layer_rows.layer_data->>'source_transaction_id', layer_rows.layer_data->>'transaction_id'), ''),
  NULLIF(layer_rows.layer_data->>'source_name', ''),
  record.created_at
FROM entity_records record
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(record.data->'movement_layers') = 'array'
    THEN record.data->'movement_layers'
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS layer_rows(layer_data, layer_order)
JOIN inventory_transactions txn ON txn.inventory_transaction_id = record.id
LEFT JOIN inventory_lots lot
  ON lot.lot_id = COALESCE(NULLIF(layer_rows.layer_data->>'lot_id', ''), NULLIF(layer_rows.layer_data->>'inventory_lot_id', ''))
LEFT JOIN production_events production
  ON production.production_id = NULLIF(layer_rows.layer_data->>'production_id', '')
WHERE record.entity_name = 'InventoryTransaction'
ON CONFLICT (inventory_transaction_layer_id) DO NOTHING;

INSERT INTO inventory_transaction_metadata (
  inventory_transaction_metadata_id, inventory_transaction_id, metadata_key,
  value_text, value_numeric, value_boolean, value_date, created_at
)
SELECT
  record.id || ':meta:' || regexp_replace(meta_entry.key, '[^A-Za-z0-9_:-]+', '_', 'g'),
  record.id,
  meta_entry.key,
  CASE WHEN jsonb_typeof(meta_entry.value) = 'string' THEN meta_entry.value #>> '{}' ELSE NULL END,
  CASE WHEN jsonb_typeof(meta_entry.value) = 'number' THEN (meta_entry.value #>> '{}')::numeric ELSE NULL END,
  CASE WHEN jsonb_typeof(meta_entry.value) = 'boolean' THEN (meta_entry.value #>> '{}')::boolean ELSE NULL END,
  CASE
    WHEN jsonb_typeof(meta_entry.value) = 'string'
      AND (meta_entry.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      THEN (meta_entry.value #>> '{}')::timestamptz
    ELSE NULL
  END,
  record.created_at
FROM entity_records record
CROSS JOIN LATERAL jsonb_each(
  CASE WHEN jsonb_typeof(record.data->'metadata') = 'object'
    THEN record.data->'metadata'
    ELSE '{}'::jsonb
  END
) AS meta_entry(key, value)
JOIN inventory_transactions txn ON txn.inventory_transaction_id = record.id
WHERE record.entity_name = 'InventoryTransaction'
  AND jsonb_typeof(meta_entry.value) IN ('string', 'number', 'boolean')
ON CONFLICT (inventory_transaction_metadata_id) DO NOTHING;

WITH metadata_containers AS (
  SELECT
    record.id AS inventory_transaction_id,
    record.created_at,
    meta_entry.key AS metadata_key,
    'array'::text AS container_type,
    array_item.item_order::integer AS item_order,
    array_item.item_value AS item_value
  FROM entity_records record
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(record.data->'metadata') = 'object'
      THEN record.data->'metadata'
      ELSE '{}'::jsonb
    END
  ) AS meta_entry(key, value)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(meta_entry.value) = 'array'
      THEN meta_entry.value
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS array_item(item_value, item_order)
  JOIN inventory_transactions txn ON txn.inventory_transaction_id = record.id
  WHERE record.entity_name = 'InventoryTransaction'
    AND jsonb_typeof(meta_entry.value) = 'array'

  UNION ALL

  SELECT
    record.id AS inventory_transaction_id,
    record.created_at,
    meta_entry.key AS metadata_key,
    'object'::text AS container_type,
    1 AS item_order,
    meta_entry.value AS item_value
  FROM entity_records record
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(record.data->'metadata') = 'object'
      THEN record.data->'metadata'
      ELSE '{}'::jsonb
    END
  ) AS meta_entry(key, value)
  JOIN inventory_transactions txn ON txn.inventory_transaction_id = record.id
  WHERE record.entity_name = 'InventoryTransaction'
    AND jsonb_typeof(meta_entry.value) = 'object'
), metadata_attributes AS (
  SELECT
    container.inventory_transaction_id,
    container.created_at,
    container.metadata_key,
    container.container_type,
    container.item_order,
    attribute.key AS attribute_name,
    attribute.value AS attribute_value
  FROM metadata_containers container
  CROSS JOIN LATERAL jsonb_each(container.item_value) AS attribute(key, value)
  WHERE jsonb_typeof(container.item_value) = 'object'

  UNION ALL

  SELECT
    container.inventory_transaction_id,
    container.created_at,
    container.metadata_key,
    container.container_type,
    container.item_order,
    'value'::text AS attribute_name,
    container.item_value AS attribute_value
  FROM metadata_containers container
  WHERE jsonb_typeof(container.item_value) <> 'object'
)
INSERT INTO inventory_transaction_metadata_items (
  inventory_transaction_metadata_item_id, inventory_transaction_id, metadata_key,
  container_type, item_order, attribute_name, attribute_value_text,
  attribute_value_numeric, attribute_value_boolean, attribute_value_date, created_at
)
SELECT
  inventory_transaction_id || ':meta-item:' || regexp_replace(metadata_key, '[^A-Za-z0-9_:-]+', '_', 'g') || ':' || container_type || ':' || item_order || ':' || regexp_replace(attribute_name, '[^A-Za-z0-9_:-]+', '_', 'g'),
  inventory_transaction_id,
  metadata_key,
  container_type,
  item_order,
  attribute_name,
  CASE WHEN jsonb_typeof(attribute_value) = 'string' THEN attribute_value #>> '{}' ELSE NULL END,
  CASE WHEN jsonb_typeof(attribute_value) = 'number' THEN (attribute_value #>> '{}')::numeric ELSE NULL END,
  CASE WHEN jsonb_typeof(attribute_value) = 'boolean' THEN (attribute_value #>> '{}')::boolean ELSE NULL END,
  CASE
    WHEN jsonb_typeof(attribute_value) = 'string'
      AND (attribute_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      THEN (attribute_value #>> '{}')::timestamptz
    ELSE NULL
  END,
  created_at
FROM metadata_attributes
ON CONFLICT (inventory_transaction_metadata_item_id) DO NOTHING;

DO $inventory_transaction_payload_cutover$
DECLARE
  has_payload_column BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_transactions'
      AND column_name = 'payload'
  ) INTO has_payload_column;

  IF has_payload_column THEN
    UPDATE inventory_transactions AS txn
       SET warehouse_name = COALESCE(txn.warehouse_name, NULLIF(txn.payload->>'site_name', ''), NULLIF(txn.payload->>'warehouse_name', '')),
           ingredient_name = COALESCE(txn.ingredient_name, NULLIF(txn.payload->>'ingredient_name', '')),
           item_code = COALESCE(txn.item_code, NULLIF(txn.payload->>'item_code', '')),
           notes = COALESCE(txn.notes, NULLIF(txn.payload->>'notes', '')),
           performed_by = COALESCE(txn.performed_by, NULLIF(txn.payload->>'performed_by', '')),
           batch_number = COALESCE(txn.batch_number, NULLIF(txn.payload->>'batch_number', '')),
           expiry_date = COALESCE(txn.expiry_date, NULLIF(txn.payload->>'expiry_date', '')::date),
           stock_date = COALESCE(txn.stock_date, NULLIF(txn.payload->>'stock_date', '')::date),
           received_date = COALESCE(txn.received_date, NULLIF(txn.payload->>'received_date', '')::date),
           from_warehouse_id = COALESCE(txn.from_warehouse_id, NULLIF(txn.payload->>'from_site_id', ''), NULLIF(txn.payload->>'from_warehouse_id', '')),
           from_warehouse_name = COALESCE(txn.from_warehouse_name, NULLIF(txn.payload->>'from_site_name', ''), NULLIF(txn.payload->>'from_warehouse_name', '')),
           to_warehouse_id = COALESCE(txn.to_warehouse_id, NULLIF(txn.payload->>'to_site_id', ''), NULLIF(txn.payload->>'to_warehouse_id', '')),
           to_warehouse_name = COALESCE(txn.to_warehouse_name, NULLIF(txn.payload->>'to_site_name', ''), NULLIF(txn.payload->>'to_warehouse_name', '')),
           source = COALESCE(txn.source, NULLIF(txn.payload->>'source', '')),
           source_type = COALESCE(txn.source_type, NULLIF(txn.payload->>'source_type', '')),
           balance_before = COALESCE(txn.balance_before, NULLIF(txn.payload->>'balance_before', '')::numeric),
           balance_after = COALESCE(txn.balance_after, NULLIF(txn.payload->>'balance_after', '')::numeric),
           opening_quantity = COALESCE(txn.opening_quantity, NULLIF(txn.payload->>'opening_quantity', '')::numeric),
           addition_quantity = COALESCE(txn.addition_quantity, NULLIF(txn.payload->>'addition_quantity', '')::numeric),
           consumption_quantity = COALESCE(txn.consumption_quantity, NULLIF(txn.payload->>'consumption_quantity', '')::numeric),
           remaining_quantity = COALESCE(txn.remaining_quantity, NULLIF(txn.payload->>'remaining_quantity', '')::numeric),
           operation = COALESCE(txn.operation, NULLIF(txn.payload->>'operation', '')),
           operation_id = COALESCE(txn.operation_id, NULLIF(txn.payload->>'operation_id', '')),
           commitment_revision = COALESCE(txn.commitment_revision, NULLIF(txn.payload->>'commitment_revision', '')::integer);

    INSERT INTO inventory_transaction_layers (
      inventory_transaction_layer_id, inventory_transaction_id, layer_order,
      inventory_lot_id, batch_number, stock_date, received_date, expiry_date,
      quantity, quantity_before, quantity_after, reserved_quantity_before,
      reserved_quantity_after, available_quantity_before, available_quantity_after,
      unit_cost, total_cost, accounting_unit_cost, accounting_total_cost,
      production_id, commitment_revision, operation_id, source_transaction_id,
      source_name, created_at
    )
    SELECT
      txn.inventory_transaction_id || ':layer:' || layer_rows.layer_order,
      txn.inventory_transaction_id,
      layer_rows.layer_order,
      lot.lot_id,
      NULLIF(layer_rows.layer_data->>'batch_number', ''),
      NULLIF(layer_rows.layer_data->>'stock_date', '')::date,
      NULLIF(layer_rows.layer_data->>'received_date', '')::date,
      NULLIF(layer_rows.layer_data->>'expiry_date', '')::date,
      COALESCE(NULLIF(layer_rows.layer_data->>'quantity', '')::numeric, 0),
      NULLIF(layer_rows.layer_data->>'quantity_before', '')::numeric,
      NULLIF(layer_rows.layer_data->>'quantity_after', '')::numeric,
      NULLIF(layer_rows.layer_data->>'reserved_quantity_before', '')::numeric,
      NULLIF(layer_rows.layer_data->>'reserved_quantity_after', '')::numeric,
      NULLIF(layer_rows.layer_data->>'available_quantity_before', '')::numeric,
      NULLIF(layer_rows.layer_data->>'available_quantity_after', '')::numeric,
      COALESCE(NULLIF(layer_rows.layer_data->>'unit_cost', '')::numeric, 0),
      COALESCE(NULLIF(layer_rows.layer_data->>'total_cost', '')::numeric, 0),
      NULLIF(layer_rows.layer_data->>'accounting_unit_cost', '')::numeric,
      NULLIF(layer_rows.layer_data->>'accounting_total_cost', '')::numeric,
      production.production_id,
      NULLIF(layer_rows.layer_data->>'commitment_revision', '')::integer,
      NULLIF(layer_rows.layer_data->>'operation_id', ''),
      NULLIF(COALESCE(layer_rows.layer_data->>'source_transaction_id', layer_rows.layer_data->>'transaction_id'), ''),
      NULLIF(layer_rows.layer_data->>'source_name', ''),
      txn.created_at
    FROM inventory_transactions txn
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(txn.payload->'movement_layers') = 'array'
        THEN txn.payload->'movement_layers'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS layer_rows(layer_data, layer_order)
    LEFT JOIN inventory_lots lot
      ON lot.lot_id = COALESCE(NULLIF(layer_rows.layer_data->>'lot_id', ''), NULLIF(layer_rows.layer_data->>'inventory_lot_id', ''))
    LEFT JOIN production_events production
      ON production.production_id = NULLIF(layer_rows.layer_data->>'production_id', '')
    ON CONFLICT (inventory_transaction_layer_id) DO NOTHING;

    INSERT INTO inventory_transaction_metadata (
      inventory_transaction_metadata_id, inventory_transaction_id, metadata_key,
      value_text, value_numeric, value_boolean, value_date, created_at
    )
    SELECT
      txn.inventory_transaction_id || ':meta:' || regexp_replace(meta_entry.key, '[^A-Za-z0-9_:-]+', '_', 'g'),
      txn.inventory_transaction_id,
      meta_entry.key,
      CASE WHEN jsonb_typeof(meta_entry.value) = 'string' THEN meta_entry.value #>> '{}' ELSE NULL END,
      CASE WHEN jsonb_typeof(meta_entry.value) = 'number' THEN (meta_entry.value #>> '{}')::numeric ELSE NULL END,
      CASE WHEN jsonb_typeof(meta_entry.value) = 'boolean' THEN (meta_entry.value #>> '{}')::boolean ELSE NULL END,
      CASE
        WHEN jsonb_typeof(meta_entry.value) = 'string'
          AND (meta_entry.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          THEN (meta_entry.value #>> '{}')::timestamptz
        ELSE NULL
      END,
      txn.created_at
    FROM inventory_transactions txn
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(txn.payload->'metadata') = 'object'
        THEN txn.payload->'metadata'
        ELSE '{}'::jsonb
      END
    ) AS meta_entry(key, value)
    WHERE jsonb_typeof(meta_entry.value) IN ('string', 'number', 'boolean')
    ON CONFLICT (inventory_transaction_metadata_id) DO NOTHING;

    WITH metadata_containers AS (
      SELECT
        txn.inventory_transaction_id,
        txn.created_at,
        meta_entry.key AS metadata_key,
        'array'::text AS container_type,
        array_item.item_order::integer AS item_order,
        array_item.item_value
      FROM inventory_transactions txn
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(txn.payload->'metadata') = 'object'
          THEN txn.payload->'metadata'
          ELSE '{}'::jsonb
        END
      ) AS meta_entry(key, value)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(meta_entry.value) = 'array'
          THEN meta_entry.value
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS array_item(item_value, item_order)

      UNION ALL

      SELECT
        txn.inventory_transaction_id,
        txn.created_at,
        meta_entry.key AS metadata_key,
        'object'::text AS container_type,
        1 AS item_order,
        meta_entry.value AS item_value
      FROM inventory_transactions txn
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(txn.payload->'metadata') = 'object'
          THEN txn.payload->'metadata'
          ELSE '{}'::jsonb
        END
      ) AS meta_entry(key, value)
      WHERE jsonb_typeof(meta_entry.value) = 'object'
    ), metadata_attributes AS (
      SELECT
        container.inventory_transaction_id,
        container.created_at,
        container.metadata_key,
        container.container_type,
        container.item_order,
        attribute.key AS attribute_name,
        attribute.value AS attribute_value
      FROM metadata_containers container
      CROSS JOIN LATERAL jsonb_each(container.item_value) AS attribute(key, value)
      WHERE jsonb_typeof(container.item_value) = 'object'

      UNION ALL

      SELECT
        container.inventory_transaction_id,
        container.created_at,
        container.metadata_key,
        container.container_type,
        container.item_order,
        'value'::text AS attribute_name,
        container.item_value AS attribute_value
      FROM metadata_containers container
      WHERE jsonb_typeof(container.item_value) <> 'object'
    )
    INSERT INTO inventory_transaction_metadata_items (
      inventory_transaction_metadata_item_id, inventory_transaction_id, metadata_key,
      container_type, item_order, attribute_name, attribute_value_text,
      attribute_value_numeric, attribute_value_boolean, attribute_value_date, created_at
    )
    SELECT
      inventory_transaction_id || ':meta-item:' || regexp_replace(metadata_key, '[^A-Za-z0-9_:-]+', '_', 'g') || ':' || container_type || ':' || item_order || ':' || regexp_replace(attribute_name, '[^A-Za-z0-9_:-]+', '_', 'g'),
      inventory_transaction_id,
      metadata_key,
      container_type,
      item_order,
      attribute_name,
      CASE WHEN jsonb_typeof(attribute_value) = 'string' THEN attribute_value #>> '{}' ELSE NULL END,
      CASE WHEN jsonb_typeof(attribute_value) = 'number' THEN (attribute_value #>> '{}')::numeric ELSE NULL END,
      CASE WHEN jsonb_typeof(attribute_value) = 'boolean' THEN (attribute_value #>> '{}')::boolean ELSE NULL END,
      CASE
        WHEN jsonb_typeof(attribute_value) = 'string'
          AND (attribute_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          THEN (attribute_value #>> '{}')::timestamptz
        ELSE NULL
      END,
      created_at
    FROM metadata_attributes
    ON CONFLICT (inventory_transaction_metadata_item_id) DO NOTHING;

    ALTER TABLE inventory_transactions DROP COLUMN payload;
  END IF;
END;
$inventory_transaction_payload_cutover$;

INSERT INTO recipes (recipe_id, canonical_name, description, status, source_name, created_at, updated_at)
SELECT
  record.id,
  COALESCE(NULLIF(BTRIM(record.data->>'name'), ''), record.id),
  NULLIF(record.data->>'description', ''),
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Recipe'
ON CONFLICT (recipe_id) DO NOTHING;

INSERT INTO recipe_versions (
  recipe_version_id, recipe_id, area_id, project_id, warehouse_id, recipe_code,
  display_name, version_label, cuisine_type, menu_category, serving_size_grams,
  batch_yield, total_recipe_weight_grams, total_cost, cost_per_serving,
  status, source_name, created_at, updated_at
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
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN recipes recipe ON recipe.recipe_id = record.id
WHERE record.entity_name = 'Recipe'
ON CONFLICT (recipe_version_id) DO NOTHING;

INSERT INTO menu_plans (
  menu_plan_id, warehouse_id, plan_date, meal_period, menu_type, menu_category,
  status, source_name, created_by, created_at, updated_at
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
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
WHERE record.entity_name = 'MenuPlan'
  AND COALESCE(record.data->>'plan_date', '') <> ''
ON CONFLICT (menu_plan_id) DO NOTHING;

INSERT INTO production_events (
  production_id, menu_plan_id, warehouse_id, production_date, meal_period, menu_type,
  menu_category, status, issue_group_key, source_type, source_event_id, source_event_name,
  source_event_recipe_id, source_menu_plan_item_key, production_issue_grouped,
  production_issue_group_key, production_issue_scope, production_issue_item_count,
  production_issue_dish_count, production_issue_admin_reissue, production_issue_reissue_run_id,
  production_issue_reissue_original_group_key, target_servings, ingredient_cost_total,
  production_cost_total, cost_per_serving, total_shortage_quantity, consumption_report_id,
  consumption_report_number, consumption_report_name, consumption_report_generated_at,
  produced_item_batch_id, produced_item_batch_number, yield_adjustment_applied,
  yield_adjustment_version, yield_adjustment_updated_at, yield_snapshot_source,
  quantity_semantics, reconciliation_mode, output_calculation_source, recipe_raw_weight_grams,
  total_raw_consumption_weight_grams, total_yielded_weight_grams, expected_finished_weight_grams,
  actual_finished_weight_grams, portion_size_grams, portion_size_source, expected_yield_servings,
  produced_servings, produced_weight_grams, completed_by_name, fulfillment_store_name,
  linked_material_request_id, linked_material_request_number, material_request_status,
  last_review_action, rejection_reason, cancellation_reason, cancelled_at, cancelled_by,
  cancelled_by_name, started_by, completed_by, completed_at, reversed_by, reversed_at,
  reversal_reason, source_name, created_at, updated_at
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
  NULLIF(record.data->>'source_type', ''),
  NULLIF(record.data->>'source_event_id', ''),
  NULLIF(record.data->>'source_event_name', ''),
  NULLIF(record.data->>'source_event_recipe_id', ''),
  NULLIF(record.data->>'source_menu_plan_item_key', ''),
  COALESCE((NULLIF(record.data->>'production_issue_grouped', ''))::boolean, FALSE),
  NULLIF(record.data->>'production_issue_group_key', ''),
  NULLIF(record.data->>'production_issue_scope', ''),
  NULLIF(record.data->>'production_issue_item_count', '')::integer,
  NULLIF(record.data->>'production_issue_dish_count', '')::integer,
  COALESCE((NULLIF(record.data->>'production_issue_admin_reissue', ''))::boolean, FALSE),
  NULLIF(record.data->>'production_issue_reissue_run_id', ''),
  NULLIF(record.data->>'production_issue_reissue_original_group_key', ''),
  NULLIF(COALESCE(record.data->>'target_servings', record.data->>'production_covers'), '')::numeric,
  COALESCE(NULLIF(record.data->>'ingredient_cost_total', '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'production_cost_total', record.data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'cost_per_serving', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'total_shortage_quantity', '')::numeric, 0),
  NULLIF(record.data->>'consumption_report_id', ''),
  NULLIF(record.data->>'consumption_report_number', ''),
  NULLIF(record.data->>'consumption_report_name', ''),
  NULLIF(record.data->>'consumption_report_generated_at', '')::timestamptz,
  NULLIF(record.data->>'produced_item_batch_id', ''),
  NULLIF(record.data->>'produced_item_batch_number', ''),
  COALESCE((NULLIF(record.data->>'yield_adjustment_applied', ''))::boolean, FALSE),
  NULLIF(record.data->>'yield_adjustment_version', '')::integer,
  NULLIF(record.data->>'yield_adjustment_updated_at', '')::timestamptz,
  NULLIF(record.data->>'yield_snapshot_source', ''),
  NULLIF(record.data->>'quantity_semantics', ''),
  NULLIF(record.data->>'reconciliation_mode', ''),
  NULLIF(record.data->>'output_calculation_source', ''),
  NULLIF(record.data->>'recipe_raw_weight_grams', '')::numeric,
  NULLIF(record.data->>'total_raw_consumption_weight_grams', '')::numeric,
  NULLIF(record.data->>'total_yielded_weight_grams', '')::numeric,
  NULLIF(record.data->>'expected_finished_weight_grams', '')::numeric,
  NULLIF(record.data->>'actual_finished_weight_grams', '')::numeric,
  NULLIF(record.data->>'portion_size_grams', '')::numeric,
  NULLIF(record.data->>'portion_size_source', ''),
  NULLIF(record.data->>'expected_yield_servings', '')::numeric,
  NULLIF(record.data->>'produced_servings', '')::numeric,
  NULLIF(record.data->>'produced_weight_grams', '')::numeric,
  NULLIF(record.data->>'completed_by_name', ''),
  NULLIF(record.data->>'fulfillment_store_name', ''),
  NULLIF(record.data->>'linked_material_request_id', ''),
  NULLIF(record.data->>'linked_material_request_number', ''),
  NULLIF(record.data->>'material_request_status', ''),
  NULLIF(record.data->>'last_review_action', ''),
  NULLIF(record.data->>'rejection_reason', ''),
  NULLIF(record.data->>'cancellation_reason', ''),
  NULLIF(record.data->>'cancelled_at', '')::timestamptz,
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'cancelled_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'cancelled_by', ''))
    LIMIT 1
  ),
  NULLIF(record.data->>'cancelled_by_name', ''),
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'started_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'started_by', ''))
    LIMIT 1
  ),
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'completed_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'completed_by', ''))
    LIMIT 1
  ),
  NULLIF(record.data->>'completed_at', '')::timestamptz,
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'reversed_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'reversed_by', ''))
    LIMIT 1
  ),
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
  ingredient_id, item_name, line_type, item_key, source_menu_plan_item_key, recipe_code,
  ingredient_name, meal_period, requested_servings, requested_weight_grams, produced_servings,
  produced_weight_grams, production_covers, raw_weight_grams, yielded_weight_grams,
  expected_finished_weight_grams, portion_size_grams, expected_yield_servings,
  output_calculation_source, weight_calculation_source, yield_calculation_source,
  weight_snapshot_version, estimated_cost, actual_cost, status, source_name,
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
  COALESCE(NULLIF(record.data->>'line_type', ''), 'recipe'),
  NULLIF(COALESCE(record.data->>'key', record.data->>'manifest_item_key'), ''),
  NULLIF(record.data->>'source_menu_plan_item_key', ''),
  NULLIF(record.data->>'recipe_code', ''),
  NULLIF(record.data->>'ingredient_name', ''),
  NULLIF(record.data->>'meal_type', ''),
  NULLIF(COALESCE(record.data->>'target_servings', record.data->>'produced_servings'), '')::numeric,
  NULLIF(COALESCE(record.data->>'requested_weight_grams', record.data->>'production_size_grams'), '')::numeric,
  NULLIF(COALESCE(record.data->>'produced_servings', record.data->>'production_covers'), '')::numeric,
  NULLIF(COALESCE(record.data->>'produced_weight_grams', record.data->>'finished_weight_grams', record.data->>'production_size_grams'), '')::numeric,
  NULLIF(COALESCE(record.data->>'production_covers', record.data->>'target_servings'), '')::numeric,
  NULLIF(record.data->>'raw_weight_grams', '')::numeric,
  NULLIF(record.data->>'yielded_weight_grams', '')::numeric,
  NULLIF(record.data->>'expected_finished_weight_grams', '')::numeric,
  NULLIF(record.data->>'portion_size_grams', '')::numeric,
  NULLIF(record.data->>'expected_yield_servings', '')::numeric,
  NULLIF(record.data->>'output_calculation_source', ''),
  NULLIF(record.data->>'weight_calculation_source', ''),
  NULLIF(COALESCE(record.data->>'yield_calculation_source', record.data->>'yield_source'), ''),
  NULLIF(record.data->>'weight_snapshot_version', '')::integer,
  COALESCE(NULLIF(COALESCE(record.data->>'estimated_cost', record.data->>'estimated_batch_cost'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'actual_cost', record.data->>'production_cost_total', record.data->>'total_cost'), '')::numeric, 0),
  'active',
  NULLIF(record.data->>'source_name', ''),
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
  served_weight_grams, wasted_weight_grams, served_servings, wasted_servings,
  portion_size_grams, service_portion_size_grams, service_portion_updated_by,
  service_portion_updated_by_name, service_portion_updated_at, expected_servings,
  expected_finished_weight_grams, actual_finished_weight_grams, source_type,
  source_event_id, menu_plan_id, consumption_report_id, consumption_report_number,
  production_issue_grouped, production_issue_item_count, production_issue_dish_count,
  completed_by, completed_by_name, reconciliation_mode, output_calculation_source,
  cutover_version, unit_cost, total_cost, status, source_name, created_at, updated_at
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
  COALESCE(NULLIF(record.data->>'served_weight_grams', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'wasted_weight_grams', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'served_servings', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'wasted_servings', '')::numeric, 0),
  NULLIF(record.data->>'portion_size_grams', '')::numeric,
  NULLIF(record.data->>'service_portion_size_grams', '')::numeric,
  NULLIF(record.data->>'service_portion_updated_by', ''),
  NULLIF(record.data->>'service_portion_updated_by_name', ''),
  NULLIF(record.data->>'service_portion_updated_at', '')::timestamptz,
  NULLIF(COALESCE(record.data->>'expected_servings', record.data->>'produced_servings'), '')::numeric,
  NULLIF(COALESCE(record.data->>'expected_finished_weight_grams', record.data->>'produced_weight_grams'), '')::numeric,
  NULLIF(COALESCE(record.data->>'actual_finished_weight_grams', record.data->>'produced_weight_grams'), '')::numeric,
  NULLIF(record.data->>'source_type', ''),
  NULLIF(record.data->>'source_event_id', ''),
  NULLIF(record.data->>'menu_plan_id', ''),
  NULLIF(record.data->>'consumption_report_id', ''),
  NULLIF(record.data->>'consumption_report_number', ''),
  COALESCE((NULLIF(record.data->>'production_issue_grouped', ''))::boolean, FALSE),
  NULLIF(record.data->>'production_issue_item_count', '')::integer,
  NULLIF(record.data->>'production_issue_dish_count', '')::integer,
  NULLIF(record.data->>'completed_by', ''),
  NULLIF(record.data->>'completed_by_name', ''),
  NULLIF(record.data->>'reconciliation_mode', ''),
  NULLIF(record.data->>'output_calculation_source', ''),
  COALESCE(NULLIF(record.data->>'cutover_version', '')::integer, 1),
  COALESCE(NULLIF(record.data->>'unit_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'total_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'active'),
  NULLIF(record.data->>'source_name', ''),
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
  report_id, report_number, report_name, production_id, warehouse_id, warehouse_name,
  requesting_warehouse_id, requesting_warehouse_name, fulfillment_store_id, fulfillment_store_name,
  recipe_version_id, recipe_name, original_recipe_name, production_name, original_production_name,
  production_date, meal_period, menu_type, menu_category, menu_scope_label,
  production_issue_grouped, production_issue_item_count, production_issue_dish_count,
  kitchen_station, target_servings, completed_by, completed_by_name, completed_at,
  quantity_basis, reconciliation_mode, output_calculation_source,
  recipe_raw_weight_grams, expected_finished_weight_grams,
  total_raw_consumption_weight_grams, total_yielded_weight_grams,
  portion_size_grams, expected_yield_servings,
  total_consumption_cost, total_shortage_cost, shortage_line_count,
  ingredient_line_count, status, reversed_at, reversed_by, reversed_by_name,
  reversal_reason, created_at, updated_at
)
SELECT
  record.id,
  COALESCE(NULLIF(record.data->>'report_number', ''), record.id),
  NULLIF(record.data->>'report_name', ''),
  record.data->>'production_id',
  NULLIF(record.data->>'site_id', ''),
  NULLIF(record.data->>'site_name', ''),
  NULLIF(record.data->>'requesting_site_id', ''),
  NULLIF(record.data->>'requesting_site_name', ''),
  NULLIF(record.data->>'fulfillment_store_id', ''),
  NULLIF(record.data->>'fulfillment_store_name', ''),
  (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(record.data->>'recipe_id', '') LIMIT 1),
  NULLIF(record.data->>'recipe_name', ''),
  NULLIF(record.data->>'original_recipe_name', ''),
  NULLIF(record.data->>'production_name', ''),
  NULLIF(record.data->>'original_production_name', ''),
  NULLIF(record.data->>'production_date', '')::date,
  NULLIF(record.data->>'meal_type', ''),
  NULLIF(COALESCE(record.data->>'menu_type', record.data->>'cuisine_type'), ''),
  NULLIF(record.data->>'menu_category', ''),
  NULLIF(record.data->>'menu_scope_label', ''),
  COALESCE(NULLIF(record.data->>'production_issue_grouped', '')::boolean, FALSE),
  NULLIF(record.data->>'production_issue_item_count', '')::integer,
  NULLIF(record.data->>'production_issue_dish_count', '')::integer,
  NULLIF(record.data->>'kitchen_station', ''),
  NULLIF(record.data->>'target_servings', '')::numeric,
  NULLIF(record.data->>'completed_by', ''),
  NULLIF(record.data->>'completed_by_name', ''),
  NULLIF(record.data->>'completed_at', '')::timestamptz,
  NULLIF(record.data->>'quantity_basis', ''),
  NULLIF(record.data->>'reconciliation_mode', ''),
  NULLIF(record.data->>'output_calculation_source', ''),
  NULLIF(record.data->>'recipe_raw_weight_grams', '')::numeric,
  NULLIF(record.data->>'expected_finished_weight_grams', '')::numeric,
  NULLIF(record.data->>'total_raw_consumption_weight_grams', '')::numeric,
  NULLIF(record.data->>'total_yielded_weight_grams', '')::numeric,
  NULLIF(record.data->>'portion_size_grams', '')::numeric,
  NULLIF(record.data->>'expected_yield_servings', '')::numeric,
  COALESCE(NULLIF(record.data->>'total_consumption_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'total_shortage_cost', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'shortage_line_count', '')::integer, 0),
  COALESCE(NULLIF(record.data->>'ingredient_line_count', '')::integer, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  NULLIF(record.data->>'reversed_at', '')::timestamptz,
  NULLIF(record.data->>'reversed_by', ''),
  NULLIF(record.data->>'reversed_by_name', ''),
  NULLIF(record.data->>'reversal_reason', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN production_events production ON production.production_id = record.data->>'production_id'
WHERE record.entity_name = 'ProductionConsumptionReport'
ON CONFLICT (report_id) DO NOTHING;

WITH report_data AS (
  SELECT record.id AS report_id, record.data, record.created_at, record.updated_at
  FROM entity_records record
  JOIN production_consumption_reports report ON report.report_id = record.id
  WHERE record.entity_name = 'ProductionConsumptionReport'
), line_rows AS (
  SELECT report_data.report_id, report_data.created_at, report_data.updated_at,
         line.value AS line_data, line.ordinality::integer AS line_number
  FROM report_data
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(report_data.data->'ingredient_lines') = 'array'
      THEN report_data.data->'ingredient_lines'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS line(value, ordinality)
)
INSERT INTO production_consumption_report_lines (
  report_line_id, report_id, line_number, ingredient_id, item_code, ingredient_name,
  unit, recipe_quantity, recipe_unit, inventory_unit, planned_quantity,
  actual_requested_quantity, issued_quantity, shortage_quantity, posted_cost,
  estimated_shortage_cost, quantity_basis, yield_percent, raw_weight_grams,
  yielded_weight_grams, weight_calculation_source, yield_calculation_source,
  unit_status, conversion_note, inventory_transaction_id, status, source_name,
  created_at, updated_at
)
SELECT
  line_rows.report_id || ':line:' || line_rows.line_number,
  line_rows.report_id,
  line_rows.line_number,
  (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(line_rows.line_data->>'ingredient_id', '') LIMIT 1),
  NULLIF(line_rows.line_data->>'item_code', ''),
  NULLIF(line_rows.line_data->>'ingredient_name', ''),
  NULLIF(line_rows.line_data->>'unit', ''),
  NULLIF(line_rows.line_data->>'recipe_quantity', '')::numeric,
  NULLIF(line_rows.line_data->>'recipe_unit', ''),
  NULLIF(line_rows.line_data->>'inventory_unit', ''),
  COALESCE(NULLIF(line_rows.line_data->>'planned_quantity', '')::numeric, 0),
  COALESCE(NULLIF(line_rows.line_data->>'actual_requested_quantity', '')::numeric, 0),
  COALESCE(NULLIF(line_rows.line_data->>'issued_quantity', '')::numeric, 0),
  COALESCE(NULLIF(line_rows.line_data->>'shortage_quantity', '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(line_rows.line_data->>'posted_cost', line_rows.line_data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(line_rows.line_data->>'estimated_shortage_cost', '')::numeric, 0),
  NULLIF(line_rows.line_data->>'quantity_basis', ''),
  NULLIF(line_rows.line_data->>'yield_percent', '')::numeric,
  NULLIF(line_rows.line_data->>'raw_weight_grams', '')::numeric,
  NULLIF(line_rows.line_data->>'yielded_weight_grams', '')::numeric,
  NULLIF(line_rows.line_data->>'weight_calculation_source', ''),
  NULLIF(COALESCE(line_rows.line_data->>'yield_calculation_source', line_rows.line_data->>'yield_source'), ''),
  NULLIF(line_rows.line_data->>'unit_status', ''),
  NULLIF(line_rows.line_data->>'conversion_note', ''),
  NULLIF(line_rows.line_data->>'inventory_transaction_id', ''),
  COALESCE(NULLIF(line_rows.line_data->>'status', ''), 'posted'),
  NULLIF(line_rows.line_data->>'source_name', ''),
  line_rows.created_at,
  line_rows.updated_at
FROM line_rows
ON CONFLICT (report_line_id) DO NOTHING;

WITH report_data AS (
  SELECT record.id AS report_id, record.data
  FROM entity_records record
  JOIN production_consumption_reports report ON report.report_id = record.id
  WHERE record.entity_name = 'ProductionConsumptionReport'
), line_rows AS (
  SELECT report_data.report_id, line.value AS line_data, line.ordinality::integer AS line_number
  FROM report_data
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(report_data.data->'ingredient_lines') = 'array'
      THEN report_data.data->'ingredient_lines'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS line(value, ordinality)
), source_rows AS (
  SELECT line_rows.report_id, line_rows.line_number,
         source.value AS recipe_name, source.ordinality::integer AS source_order
  FROM line_rows
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(line_rows.line_data->'source_recipe_names') = 'array'
      THEN line_rows.line_data->'source_recipe_names'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS source(value, ordinality)
)
INSERT INTO production_consumption_report_line_sources (
  report_line_source_id, report_line_id, report_id, source_order, recipe_name
)
SELECT
  source_rows.report_id || ':line:' || source_rows.line_number || ':source:' || source_rows.source_order,
  source_rows.report_id || ':line:' || source_rows.line_number,
  source_rows.report_id,
  source_rows.source_order,
  source_rows.recipe_name
FROM source_rows
WHERE COALESCE(BTRIM(source_rows.recipe_name), '') <> ''
ON CONFLICT (report_line_source_id) DO NOTHING;

WITH report_data AS (
  SELECT record.id AS report_id, record.data
  FROM entity_records record
  JOIN production_consumption_reports report ON report.report_id = record.id
  WHERE record.entity_name = 'ProductionConsumptionReport'
), line_rows AS (
  SELECT report_data.report_id, line.value AS line_data, line.ordinality::integer AS line_number
  FROM report_data
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(report_data.data->'ingredient_lines') = 'array'
      THEN report_data.data->'ingredient_lines'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS line(value, ordinality)
), transaction_rows AS (
  SELECT line_rows.report_id, line_rows.line_number,
         transaction_id.value AS inventory_transaction_id,
         transaction_id.ordinality::integer AS transaction_order
  FROM line_rows
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(line_rows.line_data->'inventory_transaction_ids') = 'array'
      THEN line_rows.line_data->'inventory_transaction_ids'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS transaction_id(value, ordinality)
)
INSERT INTO production_consumption_report_line_transactions (
  report_line_transaction_id, report_line_id, report_id, transaction_order, inventory_transaction_id
)
SELECT
  transaction_rows.report_id || ':line:' || transaction_rows.line_number || ':txn:' || transaction_rows.transaction_order,
  transaction_rows.report_id || ':line:' || transaction_rows.line_number,
  transaction_rows.report_id,
  transaction_rows.transaction_order,
  transaction_rows.inventory_transaction_id
FROM transaction_rows
WHERE COALESCE(BTRIM(transaction_rows.inventory_transaction_id), '') <> ''
ON CONFLICT (report_line_transaction_id) DO NOTHING;

WITH report_data AS (
  SELECT record.id AS report_id, record.data
  FROM entity_records record
  JOIN production_consumption_reports report ON report.report_id = record.id
  WHERE record.entity_name = 'ProductionConsumptionReport'
), line_rows AS (
  SELECT report_data.report_id, line.value AS line_data, line.ordinality::integer AS line_number
  FROM report_data
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(report_data.data->'ingredient_lines') = 'array'
      THEN report_data.data->'ingredient_lines'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS line(value, ordinality)
), layer_rows AS (
  SELECT line_rows.report_id, line_rows.line_number,
         layer.value AS layer_data, layer.ordinality::integer AS layer_order
  FROM line_rows
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(line_rows.line_data->'movement_layers') = 'array'
      THEN line_rows.line_data->'movement_layers'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS layer(value, ordinality)
)
INSERT INTO production_consumption_report_line_layers (
  report_line_layer_id, report_line_id, report_id, layer_order, inventory_lot_id,
  batch_number, stock_date, received_date, expiry_date, quantity, quantity_before,
  quantity_after, reserved_quantity_before, reserved_quantity_after,
  available_quantity_before, available_quantity_after, unit_cost, total_cost,
  accounting_unit_cost, accounting_total_cost, production_id, commitment_revision,
  operation_id, source_name
)
SELECT
  layer_rows.report_id || ':line:' || layer_rows.line_number || ':layer:' || layer_rows.layer_order,
  layer_rows.report_id || ':line:' || layer_rows.line_number,
  layer_rows.report_id,
  layer_rows.layer_order,
  (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF(layer_rows.layer_data->>'inventory_lot_id', '') LIMIT 1),
  NULLIF(layer_rows.layer_data->>'batch_number', ''),
  NULLIF(layer_rows.layer_data->>'stock_date', '')::date,
  NULLIF(layer_rows.layer_data->>'received_date', '')::date,
  NULLIF(layer_rows.layer_data->>'expiry_date', '')::date,
  COALESCE(NULLIF(layer_rows.layer_data->>'quantity', '')::numeric, 0),
  NULLIF(layer_rows.layer_data->>'quantity_before', '')::numeric,
  NULLIF(layer_rows.layer_data->>'quantity_after', '')::numeric,
  NULLIF(layer_rows.layer_data->>'reserved_quantity_before', '')::numeric,
  NULLIF(layer_rows.layer_data->>'reserved_quantity_after', '')::numeric,
  NULLIF(layer_rows.layer_data->>'available_quantity_before', '')::numeric,
  NULLIF(layer_rows.layer_data->>'available_quantity_after', '')::numeric,
  COALESCE(NULLIF(layer_rows.layer_data->>'unit_cost', '')::numeric, 0),
  COALESCE(NULLIF(layer_rows.layer_data->>'total_cost', '')::numeric, 0),
  NULLIF(layer_rows.layer_data->>'accounting_unit_cost', '')::numeric,
  NULLIF(layer_rows.layer_data->>'accounting_total_cost', '')::numeric,
  (SELECT production_id FROM production_events WHERE production_id = NULLIF(layer_rows.layer_data->>'production_id', '') LIMIT 1),
  NULLIF(layer_rows.layer_data->>'commitment_revision', '')::integer,
  NULLIF(layer_rows.layer_data->>'operation_id', ''),
  NULLIF(layer_rows.layer_data->>'source_name', '')
FROM layer_rows
ON CONFLICT (report_line_layer_id) DO NOTHING;

WITH report_data AS (
  SELECT record.id AS report_id, record.data, record.created_at, record.updated_at
  FROM entity_records record
  JOIN production_consumption_reports report ON report.report_id = record.id
  WHERE record.entity_name = 'ProductionConsumptionReport'
), menu_rows AS (
  SELECT report_data.report_id, report_data.created_at, report_data.updated_at,
         item.value AS item_data, item.ordinality::integer AS item_order
  FROM report_data
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(report_data.data->'menu_issue_items') = 'array'
      THEN report_data.data->'menu_issue_items'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS item(value, ordinality)
)
INSERT INTO production_consumption_report_menu_items (
  report_menu_item_id, report_id, item_order, production_line_id, recipe_version_id,
  ingredient_id, item_name, recipe_name, line_type, item_key, source_menu_plan_item_key,
  original_source_menu_plan_item_key, recipe_code, ingredient_name, meal_period,
  requested_servings, requested_weight_grams, produced_servings, produced_weight_grams,
  production_covers, raw_weight_grams, yielded_weight_grams, expected_finished_weight_grams,
  portion_size_grams, expected_yield_servings, output_calculation_source,
  weight_calculation_source, yield_calculation_source, weight_snapshot_version,
  estimated_cost, actual_cost, status, source_name, created_at, updated_at
)
SELECT
  menu_rows.report_id || ':menu-item:' || menu_rows.item_order,
  menu_rows.report_id,
  menu_rows.item_order,
  (SELECT production_line_id FROM production_manifest_lines WHERE production_line_id = NULLIF(COALESCE(menu_rows.item_data->>'production_line_id', menu_rows.item_data->>'id'), '') LIMIT 1),
  (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(COALESCE(menu_rows.item_data->>'recipe_id', menu_rows.item_data->>'recipe_version_id'), '') LIMIT 1),
  (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(menu_rows.item_data->>'ingredient_id', '') LIMIT 1),
  COALESCE(NULLIF(menu_rows.item_data->>'item_name', ''), NULLIF(menu_rows.item_data->>'recipe_name', ''), NULLIF(menu_rows.item_data->>'name', ''), 'Production menu item'),
  NULLIF(COALESCE(menu_rows.item_data->>'recipe_name', menu_rows.item_data->>'name'), ''),
  NULLIF(menu_rows.item_data->>'line_type', ''),
  NULLIF(COALESCE(menu_rows.item_data->>'key', menu_rows.item_data->>'manifest_item_key'), ''),
  NULLIF(menu_rows.item_data->>'source_menu_plan_item_key', ''),
  NULLIF(menu_rows.item_data->>'original_source_menu_plan_item_key', ''),
  NULLIF(menu_rows.item_data->>'recipe_code', ''),
  NULLIF(menu_rows.item_data->>'ingredient_name', ''),
  NULLIF(menu_rows.item_data->>'meal_type', ''),
  NULLIF(menu_rows.item_data->>'requested_servings', '')::numeric,
  NULLIF(menu_rows.item_data->>'requested_weight_grams', '')::numeric,
  NULLIF(menu_rows.item_data->>'produced_servings', '')::numeric,
  NULLIF(menu_rows.item_data->>'produced_weight_grams', '')::numeric,
  NULLIF(COALESCE(menu_rows.item_data->>'production_covers', menu_rows.item_data->>'expected_servings'), '')::numeric,
  NULLIF(menu_rows.item_data->>'raw_weight_grams', '')::numeric,
  NULLIF(menu_rows.item_data->>'yielded_weight_grams', '')::numeric,
  NULLIF(menu_rows.item_data->>'expected_finished_weight_grams', '')::numeric,
  NULLIF(menu_rows.item_data->>'portion_size_grams', '')::numeric,
  NULLIF(menu_rows.item_data->>'expected_yield_servings', '')::numeric,
  NULLIF(menu_rows.item_data->>'output_calculation_source', ''),
  NULLIF(menu_rows.item_data->>'weight_calculation_source', ''),
  NULLIF(COALESCE(menu_rows.item_data->>'yield_calculation_source', menu_rows.item_data->>'yield_source'), ''),
  NULLIF(menu_rows.item_data->>'weight_snapshot_version', '')::integer,
  COALESCE(NULLIF(COALESCE(menu_rows.item_data->>'estimated_cost', menu_rows.item_data->>'estimated_batch_cost'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(menu_rows.item_data->>'actual_cost', menu_rows.item_data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(menu_rows.item_data->>'status', ''), 'active'),
  NULLIF(menu_rows.item_data->>'source_name', ''),
  menu_rows.created_at,
  menu_rows.updated_at
FROM menu_rows
ON CONFLICT (report_menu_item_id) DO NOTHING;

WITH report_data AS (
  SELECT record.id AS report_id, record.data
  FROM entity_records record
  JOIN production_consumption_reports report ON report.report_id = record.id
  WHERE record.entity_name = 'ProductionConsumptionReport'
), unit_rows AS (
  SELECT report_data.report_id, totals.key AS unit, totals.value AS quantity
  FROM report_data
  CROSS JOIN LATERAL jsonb_each_text(
    CASE WHEN jsonb_typeof(report_data.data->'shortage_totals_by_unit') = 'object'
      THEN report_data.data->'shortage_totals_by_unit'
      ELSE '{}'::jsonb
    END
  ) AS totals(key, value)
)
INSERT INTO production_consumption_report_unit_totals (
  report_unit_total_id, report_id, unit, shortage_quantity
)
SELECT
  unit_rows.report_id || ':unit-total:' || unit_rows.unit,
  unit_rows.report_id,
  unit_rows.unit,
  COALESCE(NULLIF(unit_rows.quantity, '')::numeric, 0)
FROM unit_rows
WHERE COALESCE(BTRIM(unit_rows.unit), '') <> ''
ON CONFLICT (report_unit_total_id) DO NOTHING;

DO $production_consumption_report_payload_cutover$
DECLARE
  has_payload_column BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'production_consumption_reports'
      AND column_name = 'payload'
  ) INTO has_payload_column;

  IF has_payload_column THEN
    UPDATE production_consumption_reports report
       SET report_name = COALESCE(report.report_name, NULLIF(report.payload->>'report_name', '')),
           warehouse_name = COALESCE(report.warehouse_name, NULLIF(report.payload->>'site_name', '')),
           requesting_warehouse_id = COALESCE(report.requesting_warehouse_id, NULLIF(report.payload->>'requesting_site_id', '')),
           requesting_warehouse_name = COALESCE(report.requesting_warehouse_name, NULLIF(report.payload->>'requesting_site_name', '')),
           fulfillment_store_id = COALESCE(report.fulfillment_store_id, NULLIF(report.payload->>'fulfillment_store_id', '')),
           fulfillment_store_name = COALESCE(report.fulfillment_store_name, NULLIF(report.payload->>'fulfillment_store_name', '')),
           recipe_version_id = COALESCE(
             report.recipe_version_id,
             (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(report.payload->>'recipe_id', '') LIMIT 1)
           ),
           recipe_name = COALESCE(report.recipe_name, NULLIF(report.payload->>'recipe_name', '')),
           original_recipe_name = COALESCE(report.original_recipe_name, NULLIF(report.payload->>'original_recipe_name', '')),
           production_name = COALESCE(report.production_name, NULLIF(report.payload->>'production_name', '')),
           original_production_name = COALESCE(report.original_production_name, NULLIF(report.payload->>'original_production_name', '')),
           meal_period = COALESCE(report.meal_period, NULLIF(report.payload->>'meal_type', '')),
           menu_type = COALESCE(report.menu_type, NULLIF(COALESCE(report.payload->>'menu_type', report.payload->>'cuisine_type'), '')),
           menu_category = COALESCE(report.menu_category, NULLIF(report.payload->>'menu_category', '')),
           menu_scope_label = COALESCE(report.menu_scope_label, NULLIF(report.payload->>'menu_scope_label', '')),
           production_issue_grouped = COALESCE(NULLIF(report.payload->>'production_issue_grouped', '')::boolean, report.production_issue_grouped, FALSE),
           production_issue_item_count = COALESCE(report.production_issue_item_count, NULLIF(report.payload->>'production_issue_item_count', '')::integer),
           production_issue_dish_count = COALESCE(report.production_issue_dish_count, NULLIF(report.payload->>'production_issue_dish_count', '')::integer),
           kitchen_station = COALESCE(report.kitchen_station, NULLIF(report.payload->>'kitchen_station', '')),
           target_servings = COALESCE(report.target_servings, NULLIF(report.payload->>'target_servings', '')::numeric),
           completed_by = COALESCE(report.completed_by, NULLIF(report.payload->>'completed_by', '')),
           completed_by_name = COALESCE(report.completed_by_name, NULLIF(report.payload->>'completed_by_name', '')),
           completed_at = COALESCE(report.completed_at, NULLIF(report.payload->>'completed_at', '')::timestamptz),
           quantity_basis = COALESCE(report.quantity_basis, NULLIF(report.payload->>'quantity_basis', '')),
           reconciliation_mode = COALESCE(report.reconciliation_mode, NULLIF(report.payload->>'reconciliation_mode', '')),
           output_calculation_source = COALESCE(report.output_calculation_source, NULLIF(report.payload->>'output_calculation_source', '')),
           recipe_raw_weight_grams = COALESCE(report.recipe_raw_weight_grams, NULLIF(report.payload->>'recipe_raw_weight_grams', '')::numeric),
           expected_finished_weight_grams = COALESCE(report.expected_finished_weight_grams, NULLIF(report.payload->>'expected_finished_weight_grams', '')::numeric),
           total_raw_consumption_weight_grams = COALESCE(report.total_raw_consumption_weight_grams, NULLIF(report.payload->>'total_raw_consumption_weight_grams', '')::numeric),
           total_yielded_weight_grams = COALESCE(report.total_yielded_weight_grams, NULLIF(report.payload->>'total_yielded_weight_grams', '')::numeric),
           portion_size_grams = COALESCE(report.portion_size_grams, NULLIF(report.payload->>'portion_size_grams', '')::numeric),
           expected_yield_servings = COALESCE(report.expected_yield_servings, NULLIF(report.payload->>'expected_yield_servings', '')::numeric),
           shortage_line_count = COALESCE(NULLIF(report.payload->>'shortage_line_count', '')::integer, report.shortage_line_count, 0),
           ingredient_line_count = COALESCE(NULLIF(report.payload->>'ingredient_line_count', '')::integer, report.ingredient_line_count, 0),
           reversed_at = COALESCE(report.reversed_at, NULLIF(report.payload->>'reversed_at', '')::timestamptz),
           reversed_by = COALESCE(report.reversed_by, NULLIF(report.payload->>'reversed_by', '')),
           reversed_by_name = COALESCE(report.reversed_by_name, NULLIF(report.payload->>'reversed_by_name', '')),
           reversal_reason = COALESCE(report.reversal_reason, NULLIF(report.payload->>'reversal_reason', ''))
     WHERE report.payload IS NOT NULL;

    WITH line_rows AS (
      SELECT report.report_id, report.created_at, report.updated_at,
             line.value AS line_data, line.ordinality::integer AS line_number
      FROM production_consumption_reports report
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(report.payload->'ingredient_lines') = 'array'
          THEN report.payload->'ingredient_lines'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS line(value, ordinality)
    )
    INSERT INTO production_consumption_report_lines (
      report_line_id, report_id, line_number, ingredient_id, item_code, ingredient_name,
      unit, recipe_quantity, recipe_unit, inventory_unit, planned_quantity,
      actual_requested_quantity, issued_quantity, shortage_quantity, posted_cost,
      estimated_shortage_cost, quantity_basis, yield_percent, raw_weight_grams,
      yielded_weight_grams, weight_calculation_source, yield_calculation_source,
      unit_status, conversion_note, inventory_transaction_id, status, source_name,
      created_at, updated_at
    )
    SELECT
      line_rows.report_id || ':line:' || line_rows.line_number,
      line_rows.report_id,
      line_rows.line_number,
      (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(line_rows.line_data->>'ingredient_id', '') LIMIT 1),
      NULLIF(line_rows.line_data->>'item_code', ''),
      NULLIF(line_rows.line_data->>'ingredient_name', ''),
      NULLIF(line_rows.line_data->>'unit', ''),
      NULLIF(line_rows.line_data->>'recipe_quantity', '')::numeric,
      NULLIF(line_rows.line_data->>'recipe_unit', ''),
      NULLIF(line_rows.line_data->>'inventory_unit', ''),
      COALESCE(NULLIF(line_rows.line_data->>'planned_quantity', '')::numeric, 0),
      COALESCE(NULLIF(line_rows.line_data->>'actual_requested_quantity', '')::numeric, 0),
      COALESCE(NULLIF(line_rows.line_data->>'issued_quantity', '')::numeric, 0),
      COALESCE(NULLIF(line_rows.line_data->>'shortage_quantity', '')::numeric, 0),
      COALESCE(NULLIF(COALESCE(line_rows.line_data->>'posted_cost', line_rows.line_data->>'total_cost'), '')::numeric, 0),
      COALESCE(NULLIF(line_rows.line_data->>'estimated_shortage_cost', '')::numeric, 0),
      NULLIF(line_rows.line_data->>'quantity_basis', ''),
      NULLIF(line_rows.line_data->>'yield_percent', '')::numeric,
      NULLIF(line_rows.line_data->>'raw_weight_grams', '')::numeric,
      NULLIF(line_rows.line_data->>'yielded_weight_grams', '')::numeric,
      NULLIF(line_rows.line_data->>'weight_calculation_source', ''),
      NULLIF(COALESCE(line_rows.line_data->>'yield_calculation_source', line_rows.line_data->>'yield_source'), ''),
      NULLIF(line_rows.line_data->>'unit_status', ''),
      NULLIF(line_rows.line_data->>'conversion_note', ''),
      NULLIF(line_rows.line_data->>'inventory_transaction_id', ''),
      COALESCE(NULLIF(line_rows.line_data->>'status', ''), 'posted'),
      NULLIF(line_rows.line_data->>'source_name', ''),
      line_rows.created_at,
      line_rows.updated_at
    FROM line_rows
    ON CONFLICT (report_line_id) DO NOTHING;

    WITH line_rows AS (
      SELECT report.report_id, line.value AS line_data, line.ordinality::integer AS line_number
      FROM production_consumption_reports report
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(report.payload->'ingredient_lines') = 'array'
          THEN report.payload->'ingredient_lines'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS line(value, ordinality)
    ), layer_rows AS (
      SELECT line_rows.report_id, line_rows.line_number,
             layer.value AS layer_data, layer.ordinality::integer AS layer_order
      FROM line_rows
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(line_rows.line_data->'movement_layers') = 'array'
          THEN line_rows.line_data->'movement_layers'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS layer(value, ordinality)
    )
    INSERT INTO production_consumption_report_line_layers (
      report_line_layer_id, report_line_id, report_id, layer_order, inventory_lot_id,
      batch_number, stock_date, received_date, expiry_date, quantity, quantity_before,
      quantity_after, reserved_quantity_before, reserved_quantity_after,
      available_quantity_before, available_quantity_after, unit_cost, total_cost,
      accounting_unit_cost, accounting_total_cost, production_id, commitment_revision,
      operation_id, source_name
    )
    SELECT
      layer_rows.report_id || ':line:' || layer_rows.line_number || ':layer:' || layer_rows.layer_order,
      layer_rows.report_id || ':line:' || layer_rows.line_number,
      layer_rows.report_id,
      layer_rows.layer_order,
      (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF(layer_rows.layer_data->>'inventory_lot_id', '') LIMIT 1),
      NULLIF(layer_rows.layer_data->>'batch_number', ''),
      NULLIF(layer_rows.layer_data->>'stock_date', '')::date,
      NULLIF(layer_rows.layer_data->>'received_date', '')::date,
      NULLIF(layer_rows.layer_data->>'expiry_date', '')::date,
      COALESCE(NULLIF(layer_rows.layer_data->>'quantity', '')::numeric, 0),
      NULLIF(layer_rows.layer_data->>'quantity_before', '')::numeric,
      NULLIF(layer_rows.layer_data->>'quantity_after', '')::numeric,
      NULLIF(layer_rows.layer_data->>'reserved_quantity_before', '')::numeric,
      NULLIF(layer_rows.layer_data->>'reserved_quantity_after', '')::numeric,
      NULLIF(layer_rows.layer_data->>'available_quantity_before', '')::numeric,
      NULLIF(layer_rows.layer_data->>'available_quantity_after', '')::numeric,
      COALESCE(NULLIF(layer_rows.layer_data->>'unit_cost', '')::numeric, 0),
      COALESCE(NULLIF(layer_rows.layer_data->>'total_cost', '')::numeric, 0),
      NULLIF(layer_rows.layer_data->>'accounting_unit_cost', '')::numeric,
      NULLIF(layer_rows.layer_data->>'accounting_total_cost', '')::numeric,
      (SELECT production_id FROM production_events WHERE production_id = NULLIF(layer_rows.layer_data->>'production_id', '') LIMIT 1),
      NULLIF(layer_rows.layer_data->>'commitment_revision', '')::integer,
      NULLIF(layer_rows.layer_data->>'operation_id', ''),
      NULLIF(layer_rows.layer_data->>'source_name', '')
    FROM layer_rows
    ON CONFLICT (report_line_layer_id) DO NOTHING;

    WITH menu_rows AS (
      SELECT report.report_id, report.created_at, report.updated_at,
             item.value AS item_data, item.ordinality::integer AS item_order
      FROM production_consumption_reports report
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(report.payload->'menu_issue_items') = 'array'
          THEN report.payload->'menu_issue_items'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS item(value, ordinality)
    )
    INSERT INTO production_consumption_report_menu_items (
      report_menu_item_id, report_id, item_order, production_line_id, recipe_version_id,
      ingredient_id, item_name, recipe_name, line_type, item_key, source_menu_plan_item_key,
      original_source_menu_plan_item_key, recipe_code, ingredient_name, meal_period,
      requested_servings, requested_weight_grams, produced_servings, produced_weight_grams,
      production_covers, raw_weight_grams, yielded_weight_grams, expected_finished_weight_grams,
      portion_size_grams, expected_yield_servings, output_calculation_source,
      weight_calculation_source, yield_calculation_source, weight_snapshot_version,
      estimated_cost, actual_cost, status, source_name, created_at, updated_at
    )
    SELECT
      menu_rows.report_id || ':menu-item:' || menu_rows.item_order,
      menu_rows.report_id,
      menu_rows.item_order,
      (SELECT production_line_id FROM production_manifest_lines WHERE production_line_id = NULLIF(COALESCE(menu_rows.item_data->>'production_line_id', menu_rows.item_data->>'id'), '') LIMIT 1),
      (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(COALESCE(menu_rows.item_data->>'recipe_id', menu_rows.item_data->>'recipe_version_id'), '') LIMIT 1),
      (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(menu_rows.item_data->>'ingredient_id', '') LIMIT 1),
      COALESCE(NULLIF(menu_rows.item_data->>'item_name', ''), NULLIF(menu_rows.item_data->>'recipe_name', ''), NULLIF(menu_rows.item_data->>'name', ''), 'Production menu item'),
      NULLIF(COALESCE(menu_rows.item_data->>'recipe_name', menu_rows.item_data->>'name'), ''),
      NULLIF(menu_rows.item_data->>'line_type', ''),
      NULLIF(COALESCE(menu_rows.item_data->>'key', menu_rows.item_data->>'manifest_item_key'), ''),
      NULLIF(menu_rows.item_data->>'source_menu_plan_item_key', ''),
      NULLIF(menu_rows.item_data->>'original_source_menu_plan_item_key', ''),
      NULLIF(menu_rows.item_data->>'recipe_code', ''),
      NULLIF(menu_rows.item_data->>'ingredient_name', ''),
      NULLIF(menu_rows.item_data->>'meal_type', ''),
      NULLIF(menu_rows.item_data->>'requested_servings', '')::numeric,
      NULLIF(menu_rows.item_data->>'requested_weight_grams', '')::numeric,
      NULLIF(menu_rows.item_data->>'produced_servings', '')::numeric,
      NULLIF(menu_rows.item_data->>'produced_weight_grams', '')::numeric,
      NULLIF(COALESCE(menu_rows.item_data->>'production_covers', menu_rows.item_data->>'expected_servings'), '')::numeric,
      NULLIF(menu_rows.item_data->>'raw_weight_grams', '')::numeric,
      NULLIF(menu_rows.item_data->>'yielded_weight_grams', '')::numeric,
      NULLIF(menu_rows.item_data->>'expected_finished_weight_grams', '')::numeric,
      NULLIF(menu_rows.item_data->>'portion_size_grams', '')::numeric,
      NULLIF(menu_rows.item_data->>'expected_yield_servings', '')::numeric,
      NULLIF(menu_rows.item_data->>'output_calculation_source', ''),
      NULLIF(menu_rows.item_data->>'weight_calculation_source', ''),
      NULLIF(COALESCE(menu_rows.item_data->>'yield_calculation_source', menu_rows.item_data->>'yield_source'), ''),
      NULLIF(menu_rows.item_data->>'weight_snapshot_version', '')::integer,
      COALESCE(NULLIF(COALESCE(menu_rows.item_data->>'estimated_cost', menu_rows.item_data->>'estimated_batch_cost'), '')::numeric, 0),
      COALESCE(NULLIF(COALESCE(menu_rows.item_data->>'actual_cost', menu_rows.item_data->>'total_cost'), '')::numeric, 0),
      COALESCE(NULLIF(menu_rows.item_data->>'status', ''), 'active'),
      NULLIF(menu_rows.item_data->>'source_name', ''),
      menu_rows.created_at,
      menu_rows.updated_at
    FROM menu_rows
    ON CONFLICT (report_menu_item_id) DO NOTHING;

    WITH unit_rows AS (
      SELECT report.report_id, totals.key AS unit, totals.value AS quantity
      FROM production_consumption_reports report
      CROSS JOIN LATERAL jsonb_each_text(
        CASE WHEN jsonb_typeof(report.payload->'shortage_totals_by_unit') = 'object'
          THEN report.payload->'shortage_totals_by_unit'
          ELSE '{}'::jsonb
        END
      ) AS totals(key, value)
    )
    INSERT INTO production_consumption_report_unit_totals (
      report_unit_total_id, report_id, unit, shortage_quantity
    )
    SELECT
      unit_rows.report_id || ':unit-total:' || unit_rows.unit,
      unit_rows.report_id,
      unit_rows.unit,
      COALESCE(NULLIF(unit_rows.quantity, '')::numeric, 0)
    FROM unit_rows
    WHERE COALESCE(BTRIM(unit_rows.unit), '') <> ''
    ON CONFLICT (report_unit_total_id) DO NOTHING;

    ALTER TABLE production_consumption_reports DROP COLUMN payload;
  END IF;
END;
$production_consumption_report_payload_cutover$;

INSERT INTO meal_service_headers (
  meal_service_id, service_reference, idempotency_key, warehouse_id, service_date,
  meal_period, menu_type, menu_category, serving_size_grams, covers, status,
  request_fingerprint, reversal_idempotency_key, reversal_request_fingerprint,
  scope_key, menu_plan_id, menu_plan_name, customer_meal_plan_id,
  customer_meal_plan_name, customer_name, customer_id, category, attendee_count,
  scan_method, notes, required_servings, required_weight_grams, served_servings,
  served_weight_grams, shortage_servings, shortage_weight_grams, recorded_by,
  recorded_by_name, recorded_at, posted_by, reversed_by, reversed_by_name,
  reversed_at, reversal_reason, cutover_version, source_name, created_at, updated_at
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
  NULLIF(record.data->>'request_fingerprint', ''),
  NULLIF(record.data->>'reversal_idempotency_key', ''),
  NULLIF(record.data->>'reversal_request_fingerprint', ''),
  NULLIF(record.data->>'scope_key', ''),
  (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF(record.data->>'menu_plan_id', '') LIMIT 1),
  NULLIF(record.data->>'menu_plan_name', ''),
  NULLIF(record.data->>'customer_meal_plan_id', ''),
  NULLIF(record.data->>'customer_meal_plan_name', ''),
  NULLIF(record.data->>'customer_name', ''),
  NULLIF(record.data->>'customer_id', ''),
  NULLIF(record.data->>'category', ''),
  COALESCE(NULLIF(record.data->>'attendee_count', '')::numeric, 0),
  NULLIF(record.data->>'scan_method', ''),
  NULLIF(record.data->>'notes', ''),
  COALESCE(NULLIF(record.data->>'required_servings', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'required_weight_grams', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'served_servings', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'served_weight_grams', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'shortage_servings', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'shortage_weight_grams', '')::numeric, 0),
  NULLIF(record.data->>'recorded_by', ''),
  NULLIF(record.data->>'recorded_by_name', ''),
  NULLIF(record.data->>'recorded_at', '')::timestamptz,
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(COALESCE(record.data->>'posted_by', record.data->>'performed_by'), '')
      OR LOWER(app_user.email) = LOWER(NULLIF(COALESCE(record.data->>'posted_by', record.data->>'performed_by'), ''))
    LIMIT 1
  ),
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'reversed_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'reversed_by', ''))
    LIMIT 1
  ),
  NULLIF(record.data->>'reversed_by_name', ''),
  NULLIF(record.data->>'reversed_at', '')::timestamptz,
  NULLIF(record.data->>'reversal_reason', ''),
  COALESCE(NULLIF(record.data->>'cutover_version', '')::integer, 1),
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

INSERT INTO meal_service_items (
  meal_service_item_id, meal_service_id, item_order, output_batch_id, production_id,
  recipe_version_id, recipe_name, item_name, attendee_count, portions_per_attendee,
  servings_per_attendee, portion_size_grams, manual_portion_size_grams,
  portion_size_source, required_servings, required_weight_grams, served_servings,
  served_weight_grams, consumed_production_equivalent_servings, shortage_servings,
  shortage_weight_grams, cost, status, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(item.value->>'id', ''), record.id || ':item:' || item.ordinality),
  record.id,
  item.ordinality::integer,
  (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF(COALESCE(item.value->>'output_batch_id', item.value->>'produced_item_batch_id', item.value->>'batch_id'), '') LIMIT 1),
  (SELECT production_id FROM production_events WHERE production_id = NULLIF(item.value->>'production_id', '') LIMIT 1),
  (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(COALESCE(item.value->>'recipe_id', item.value->>'recipe_version_id'), '') LIMIT 1),
  NULLIF(item.value->>'recipe_name', ''),
  NULLIF(COALESCE(item.value->>'item_name', item.value->>'recipe_name'), ''),
  NULLIF(item.value->>'attendee_count', '')::numeric,
  NULLIF(item.value->>'portions_per_attendee', '')::numeric,
  NULLIF(item.value->>'servings_per_attendee', '')::numeric,
  NULLIF(item.value->>'portion_size_grams', '')::numeric,
  NULLIF(item.value->>'manual_portion_size_grams', '')::numeric,
  NULLIF(item.value->>'portion_size_source', ''),
  COALESCE(NULLIF(item.value->>'required_servings', '')::numeric, 0),
  COALESCE(NULLIF(item.value->>'required_weight_grams', '')::numeric, 0),
  COALESCE(NULLIF(item.value->>'served_servings', '')::numeric, 0),
  COALESCE(NULLIF(item.value->>'served_weight_grams', '')::numeric, 0),
  NULLIF(item.value->>'consumed_production_equivalent_servings', '')::numeric,
  COALESCE(NULLIF(COALESCE(item.value->>'shortage_servings', item.value->>'short_servings'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(item.value->>'shortage_weight_grams', item.value->>'short_weight_grams'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(item.value->>'cost', item.value->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(item.value->>'status', ''), 'posted'),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN meal_service_headers header ON header.meal_service_id = record.id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(record.data->'items') = 'array'
    THEN record.data->'items'
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS item(value, ordinality)
WHERE record.entity_name = 'MealServiceAttendance'
ON CONFLICT (meal_service_item_id) DO NOTHING;

INSERT INTO meal_service_consumptions (
  meal_consumption_id, meal_service_id, output_batch_id, production_id, recipe_version_id,
  reverses_consumption_id, idempotency_key, service_reference, movement_type, service_date, meal_period,
  consumed_weight_grams, consumed_servings, cost, status, menu_plan_id, menu_type,
  menu_category, customer_meal_plan_id, recipe_name, attendee_count, portions_per_attendee,
  servings_per_attendee, portion_size_grams, manual_portion_size_grams, portion_size_source,
  covers, required_servings, required_weight_grams, consumed_production_equivalent_servings,
  shortage_servings, shortage_weight_grams, reversal_reason, performed_by, performed_by_name,
  performed_at, cutover_version, created_at, updated_at
)
SELECT
  record.id,
  record.data->>'meal_service_attendance_id',
  output_batch.output_batch_id,
  production.production_id,
  recipe.recipe_version_id,
  NULLIF(COALESCE(record.data->>'reverses_consumption_id', record.data->>'source_consumption_id', record.data->>'original_consumption_id'), ''),
  record.data->>'idempotency_key',
  record.data->>'service_reference',
  COALESCE(NULLIF(record.data->>'movement_type', ''), 'consumption'),
  NULLIF(record.data->>'service_date', '')::date,
  NULLIF(record.data->>'meal_type', ''),
  COALESCE(NULLIF(COALESCE(record.data->>'consumed_weight_grams', record.data->>'required_weight_grams'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'consumed_servings', record.data->>'required_servings'), '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(record.data->>'cost', record.data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF(record.data->>'menu_plan_id', '') LIMIT 1),
  NULLIF(record.data->>'menu_type', ''),
  NULLIF(record.data->>'menu_category', ''),
  NULLIF(record.data->>'customer_meal_plan_id', ''),
  NULLIF(record.data->>'recipe_name', ''),
  NULLIF(record.data->>'attendee_count', '')::numeric,
  NULLIF(record.data->>'portions_per_attendee', '')::numeric,
  NULLIF(record.data->>'servings_per_attendee', '')::numeric,
  NULLIF(record.data->>'portion_size_grams', '')::numeric,
  NULLIF(record.data->>'manual_portion_size_grams', '')::numeric,
  NULLIF(record.data->>'portion_size_source', ''),
  NULLIF(record.data->>'covers', '')::numeric,
  NULLIF(record.data->>'required_servings', '')::numeric,
  NULLIF(record.data->>'required_weight_grams', '')::numeric,
  NULLIF(record.data->>'consumed_production_equivalent_servings', '')::numeric,
  NULLIF(record.data->>'shortage_servings', '')::numeric,
  NULLIF(record.data->>'shortage_weight_grams', '')::numeric,
  NULLIF(record.data->>'reversal_reason', ''),
  NULLIF(record.data->>'performed_by', ''),
  NULLIF(record.data->>'performed_by_name', ''),
  NULLIF(record.data->>'performed_at', '')::timestamptz,
  COALESCE(NULLIF(record.data->>'cutover_version', '')::integer, 1),
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

INSERT INTO meal_service_consumption_allocations (
  meal_service_consumption_allocation_id, meal_consumption_id, allocation_order,
  output_batch_id, production_id, batch_number, portion_size_grams,
  service_portion_size_grams, servings, production_equivalent_servings,
  meal_portions, weight_grams, remaining_servings_before,
  remaining_servings_after, remaining_weight_grams_before,
  remaining_weight_grams_after, status, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(allocation.value->>'id', ''), record.id || ':allocation:' || allocation.ordinality),
  record.id,
  allocation.ordinality::integer,
  (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF(COALESCE(allocation.value->>'output_batch_id', allocation.value->>'produced_item_batch_id', allocation.value->>'batch_id'), '') LIMIT 1),
  (SELECT production_id FROM production_events WHERE production_id = NULLIF(allocation.value->>'production_id', '') LIMIT 1),
  NULLIF(allocation.value->>'batch_number', ''),
  NULLIF(allocation.value->>'portion_size_grams', '')::numeric,
  NULLIF(allocation.value->>'service_portion_size_grams', '')::numeric,
  COALESCE(NULLIF(allocation.value->>'servings', '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(allocation.value->>'production_equivalent_servings', allocation.value->>'servings'), '')::numeric, 0),
  COALESCE(NULLIF(allocation.value->>'meal_portions', '')::numeric, 0),
  COALESCE(NULLIF(allocation.value->>'weight_grams', '')::numeric, 0),
  NULLIF(allocation.value->>'remaining_servings_before', '')::numeric,
  NULLIF(allocation.value->>'remaining_servings_after', '')::numeric,
  NULLIF(allocation.value->>'remaining_weight_grams_before', '')::numeric,
  NULLIF(allocation.value->>'remaining_weight_grams_after', '')::numeric,
  COALESCE(NULLIF(allocation.value->>'status', ''), 'posted'),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN meal_service_consumptions consumption ON consumption.meal_consumption_id = record.id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(record.data->'allocations') = 'array'
    THEN record.data->'allocations'
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS allocation(value, ordinality)
WHERE record.entity_name = 'MealServiceConsumption'
ON CONFLICT (meal_service_consumption_allocation_id) DO NOTHING;

INSERT INTO food_waste_records (
  food_waste_id, waste_reference, idempotency_key, warehouse_id, waste_date, meal_period,
  menu_type, menu_category, waste_category, reason_code, reason, waste_scope,
  source_type, avoidable_type, preventable, auto_generated, high_value,
  quantity_grams, unit, estimated_cost, menu_plan_id, menu_plan_name,
  meal_service_id, production_id, recipe_version_id, ingredient_id,
  production_name, recipe_name, ingredient_name, batch_reference,
  batch_overproduction_item_key, manifest_item_key, source_menu_plan_item_key,
  batch_recipe_id, batch_recipe_name, produced_weight_grams,
  available_weight_grams_before, wasted_production_equivalent_servings,
  served_at, production_completed_at, recording_window_basis,
  recording_window_open_at, recording_deadline_at, meal_service_adjustment_cost,
  inventory_transaction_id, inventory_deduction_quantity, inventory_shortage_quantity,
  notes, approval_status, status, recorded_by, reversed_by, reversed_at,
  reversal_reason, source_name, created_at, updated_at
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
  NULLIF(record.data->>'reason', ''),
  COALESCE(NULLIF(record.data->>'waste_scope', ''), 'ingredient'),
  COALESCE(NULLIF(record.data->>'source_type', ''), 'manual_entry'),
  COALESCE(NULLIF(record.data->>'avoidable_type', ''), 'avoidable'),
  CASE
    WHEN record.data ? 'preventable' THEN COALESCE((record.data->>'preventable')::boolean, TRUE)
    ELSE TRUE
  END,
  CASE
    WHEN record.data ? 'auto_generated' THEN COALESCE((record.data->>'auto_generated')::boolean, FALSE)
    ELSE FALSE
  END,
  CASE
    WHEN record.data ? 'high_value' THEN COALESCE((record.data->>'high_value')::boolean, FALSE)
    ELSE FALSE
  END,
  COALESCE(
    NULLIF(COALESCE(record.data->>'waste_weight_grams', record.data->>'quantity_grams', record.data->>'wasted_weight_grams'), '')::numeric,
    CASE WHEN LOWER(COALESCE(record.data->>'unit', 'g')) = 'kg'
      THEN COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0) * 1000
      ELSE COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0)
    END
  ),
  COALESCE(NULLIF(record.data->>'unit', ''), 'g'),
  COALESCE(NULLIF(COALESCE(record.data->>'estimated_cost', record.data->>'waste_cost', record.data->>'cost'), '')::numeric, 0),
  (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF(record.data->>'menu_plan_id', '') LIMIT 1),
  NULLIF(record.data->>'menu_plan_name', ''),
  (SELECT meal_service_id FROM meal_service_headers WHERE meal_service_id = NULLIF(record.data->>'meal_service_attendance_id', '') LIMIT 1),
  (SELECT production_id FROM production_events WHERE production_id = NULLIF(record.data->>'production_id', '') LIMIT 1),
  (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(record.data->>'recipe_id', '') LIMIT 1),
  (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(record.data->>'ingredient_id', '') LIMIT 1),
  NULLIF(record.data->>'production_name', ''),
  NULLIF(record.data->>'recipe_name', ''),
  NULLIF(record.data->>'ingredient_name', ''),
  NULLIF(record.data->>'batch_reference', ''),
  NULLIF(record.data->>'batch_overproduction_item_key', ''),
  NULLIF(record.data->>'manifest_item_key', ''),
  NULLIF(record.data->>'source_menu_plan_item_key', ''),
  NULLIF(record.data->>'batch_recipe_id', ''),
  NULLIF(record.data->>'batch_recipe_name', ''),
  NULLIF(record.data->>'produced_weight_grams', '')::numeric,
  NULLIF(record.data->>'available_weight_grams_before', '')::numeric,
  NULLIF(record.data->>'wasted_production_equivalent_servings', '')::numeric,
  NULLIF(record.data->>'served_at', '')::timestamptz,
  NULLIF(record.data->>'production_completed_at', '')::timestamptz,
  NULLIF(record.data->>'recording_window_basis', ''),
  NULLIF(record.data->>'recording_window_open_at', '')::timestamptz,
  NULLIF(record.data->>'recording_deadline_at', '')::timestamptz,
  COALESCE(NULLIF(record.data->>'meal_service_adjustment_cost', '')::numeric, 0),
  NULLIF(record.data->>'inventory_transaction_id', ''),
  COALESCE(NULLIF(record.data->>'inventory_deduction_quantity', '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'inventory_shortage_quantity', '')::numeric, 0),
  NULLIF(record.data->>'notes', ''),
  COALESCE(NULLIF(record.data->>'approval_status', ''), 'pending'),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'recorded_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'recorded_by', ''))
    LIMIT 1
  ),
  (
    SELECT app_user.id
    FROM users app_user
    WHERE app_user.id = NULLIF(record.data->>'reversed_by', '')
      OR LOWER(app_user.email) = LOWER(NULLIF(record.data->>'reversed_by', ''))
    LIMIT 1
  ),
  NULLIF(record.data->>'reversed_at', '')::timestamptz,
  NULLIF(record.data->>'reversal_reason', ''),
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
JOIN warehouses warehouse ON warehouse.warehouse_id = record.data->>'site_id'
WHERE record.entity_name = 'FoodWaste'
  AND COALESCE(record.data->>'waste_date', '') <> ''
ON CONFLICT (food_waste_id) DO NOTHING;

INSERT INTO food_waste_lines (
  food_waste_line_id, food_waste_id, output_batch_id, production_line_id,
  production_id, recipe_version_id, ingredient_id, line_number, item_name,
  batch_number, batch_overproduction_item_key, manifest_item_key,
  source_menu_plan_item_key, wasted_production_equivalent_servings,
  produced_weight_grams_before, available_weight_grams_before,
  waste_weight_grams, cost, status, created_at, updated_at
)
SELECT
  record.id || ':line:1',
  record.id,
  output_batch.output_batch_id,
  NULL,
  (SELECT production_id FROM production_events WHERE production_id = NULLIF(record.data->>'production_id', '') LIMIT 1),
  (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(record.data->>'recipe_id', '') LIMIT 1),
  ingredient.ingredient_id,
  1,
  COALESCE(NULLIF(record.data->>'recipe_name', ''), NULLIF(record.data->>'ingredient_name', '')),
  NULLIF(record.data->>'batch_reference', ''),
  NULLIF(record.data->>'batch_overproduction_item_key', ''),
  NULLIF(record.data->>'manifest_item_key', ''),
  NULLIF(record.data->>'source_menu_plan_item_key', ''),
  NULLIF(record.data->>'wasted_production_equivalent_servings', '')::numeric,
  NULLIF(record.data->>'produced_weight_grams', '')::numeric,
  NULLIF(record.data->>'available_weight_grams_before', '')::numeric,
  COALESCE(
    NULLIF(COALESCE(record.data->>'waste_weight_grams', record.data->>'quantity_grams'), '')::numeric,
    CASE WHEN LOWER(COALESCE(record.data->>'unit', 'g')) = 'kg'
      THEN COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0) * 1000
      ELSE COALESCE(NULLIF(record.data->>'quantity', '')::numeric, 0)
    END
  ),
  COALESCE(NULLIF(COALESCE(record.data->>'estimated_cost', record.data->>'waste_cost', record.data->>'total_cost'), '')::numeric, 0),
  COALESCE(NULLIF(record.data->>'status', ''), 'posted'),
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

WITH food_waste_image_source AS (
  SELECT
    record.id AS food_waste_id,
    btrim(raw.image_url) AS image_url,
    MIN(raw.image_order) AS image_order
  FROM entity_records record
  CROSS JOIN LATERAL (
    SELECT image_value AS image_url, image_ordinal::integer AS image_order
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(record.data->'evidence_image_urls') = 'array'
          THEN record.data->'evidence_image_urls'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS image_values(image_value, image_ordinal)
    UNION ALL
    SELECT image_value AS image_url, (100 + image_ordinal)::integer AS image_order
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(record.data->'image_urls') = 'array'
          THEN record.data->'image_urls'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS image_values(image_value, image_ordinal)
    UNION ALL
    SELECT record.data->>'evidence_image_url' AS image_url, 1 AS image_order
    WHERE COALESCE(record.data->>'evidence_image_url', '') <> ''
    UNION ALL
    SELECT record.data->>'image_url' AS image_url, 2 AS image_order
    WHERE COALESCE(record.data->>'image_url', '') <> ''
  ) raw
  JOIN food_waste_records waste ON waste.food_waste_id = record.id
  WHERE record.entity_name = 'FoodWaste'
    AND COALESCE(btrim(raw.image_url), '') <> ''
  GROUP BY record.id, btrim(raw.image_url)
)
INSERT INTO food_waste_images (
  food_waste_image_id, food_waste_id, image_url, image_order, created_at
)
SELECT
  food_waste_id || ':image:' || ROW_NUMBER() OVER (
    PARTITION BY food_waste_id
    ORDER BY image_order, image_url
  ),
  food_waste_id,
  image_url,
  ROW_NUMBER() OVER (
    PARTITION BY food_waste_id
    ORDER BY image_order, image_url
  ),
  NOW()
FROM food_waste_image_source
ON CONFLICT (food_waste_id, image_url) DO UPDATE SET
  image_order = LEAST(food_waste_images.image_order, EXCLUDED.image_order);

WITH food_waste_inventory_movement_source AS (
  SELECT
    record.id AS food_waste_id,
    movement.value AS movement_data,
    movement.ordinality::integer AS movement_order
  FROM entity_records record
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(record.data->'inventory_movement_layers') = 'array'
        THEN record.data->'inventory_movement_layers'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS movement(value, ordinality)
  JOIN food_waste_records waste ON waste.food_waste_id = record.id
  WHERE record.entity_name = 'FoodWaste'
)
INSERT INTO food_waste_inventory_movements (
  food_waste_inventory_movement_id, food_waste_id, movement_order,
  inventory_transaction_id, inventory_id, lot_id, ingredient_id,
  quantity, unit, unit_cost, total_cost, stock_date, expiry_date, source_name,
  created_at
)
SELECT
  food_waste_id || ':movement:' || movement_order,
  food_waste_id,
  movement_order,
  NULLIF(movement_data->>'inventory_transaction_id', ''),
  (SELECT inventory_id FROM warehouse_inventory WHERE inventory_id = NULLIF(movement_data->>'inventory_id', '') LIMIT 1),
  (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF(movement_data->>'lot_id', '') LIMIT 1),
  (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(movement_data->>'ingredient_id', '') LIMIT 1),
  COALESCE(NULLIF(COALESCE(movement_data->>'quantity', movement_data->>'deducted_quantity'), '')::numeric, 0),
  NULLIF(movement_data->>'unit', ''),
  COALESCE(NULLIF(movement_data->>'unit_cost', '')::numeric, 0),
  COALESCE(NULLIF(COALESCE(movement_data->>'total_cost', movement_data->>'cost'), '')::numeric, 0),
  NULLIF(movement_data->>'stock_date', '')::date,
  NULLIF(movement_data->>'expiry_date', '')::date,
  NULLIF(movement_data->>'source_name', ''),
  NOW()
FROM food_waste_inventory_movement_source
ON CONFLICT (food_waste_inventory_movement_id) DO NOTHING;

DO $production_payload_cutover$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'production_events'
      AND column_name = 'payload'
  ) THEN
    UPDATE production_events production
       SET source_type = COALESCE(production.source_type, NULLIF(production.payload->>'source_type', '')),
           source_event_id = COALESCE(production.source_event_id, NULLIF(production.payload->>'source_event_id', '')),
           source_event_name = COALESCE(production.source_event_name, NULLIF(production.payload->>'source_event_name', '')),
           source_event_recipe_id = COALESCE(production.source_event_recipe_id, NULLIF(production.payload->>'source_event_recipe_id', '')),
           source_menu_plan_item_key = COALESCE(production.source_menu_plan_item_key, NULLIF(production.payload->>'source_menu_plan_item_key', '')),
           production_issue_grouped = CASE
             WHEN production.payload ? 'production_issue_grouped' THEN COALESCE((production.payload->>'production_issue_grouped')::boolean, FALSE)
             ELSE production.production_issue_grouped
           END,
           production_issue_group_key = COALESCE(production.production_issue_group_key, NULLIF(production.payload->>'production_issue_group_key', '')),
           production_issue_scope = COALESCE(production.production_issue_scope, NULLIF(production.payload->>'production_issue_scope', '')),
           production_issue_item_count = COALESCE(production.production_issue_item_count, NULLIF(production.payload->>'production_issue_item_count', '')::integer),
           production_issue_dish_count = COALESCE(production.production_issue_dish_count, NULLIF(production.payload->>'production_issue_dish_count', '')::integer),
           production_issue_admin_reissue = CASE
             WHEN production.payload ? 'production_issue_admin_reissue' THEN COALESCE((production.payload->>'production_issue_admin_reissue')::boolean, FALSE)
             ELSE production.production_issue_admin_reissue
           END,
           production_issue_reissue_run_id = COALESCE(production.production_issue_reissue_run_id, NULLIF(production.payload->>'production_issue_reissue_run_id', '')),
           production_issue_reissue_original_group_key = COALESCE(production.production_issue_reissue_original_group_key, NULLIF(production.payload->>'production_issue_reissue_original_group_key', '')),
           target_servings = COALESCE(production.target_servings, NULLIF(COALESCE(production.payload->>'target_servings', production.payload->>'production_covers'), '')::numeric),
           ingredient_cost_total = COALESCE(NULLIF(production.payload->>'ingredient_cost_total', '')::numeric, production.ingredient_cost_total, 0),
           production_cost_total = COALESCE(NULLIF(COALESCE(production.payload->>'production_cost_total', production.payload->>'total_cost'), '')::numeric, production.production_cost_total, 0),
           cost_per_serving = COALESCE(NULLIF(production.payload->>'cost_per_serving', '')::numeric, production.cost_per_serving, 0),
           total_shortage_quantity = COALESCE(NULLIF(production.payload->>'total_shortage_quantity', '')::numeric, production.total_shortage_quantity, 0),
           consumption_report_id = COALESCE(production.consumption_report_id, NULLIF(production.payload->>'consumption_report_id', '')),
           consumption_report_number = COALESCE(production.consumption_report_number, NULLIF(production.payload->>'consumption_report_number', '')),
           consumption_report_name = COALESCE(production.consumption_report_name, NULLIF(production.payload->>'consumption_report_name', '')),
           consumption_report_generated_at = COALESCE(production.consumption_report_generated_at, NULLIF(production.payload->>'consumption_report_generated_at', '')::timestamptz),
           produced_item_batch_id = COALESCE(production.produced_item_batch_id, NULLIF(production.payload->>'produced_item_batch_id', '')),
           produced_item_batch_number = COALESCE(production.produced_item_batch_number, NULLIF(production.payload->>'produced_item_batch_number', '')),
           yield_adjustment_applied = CASE
             WHEN production.payload ? 'yield_adjustment_applied' THEN COALESCE((production.payload->>'yield_adjustment_applied')::boolean, FALSE)
             ELSE production.yield_adjustment_applied
           END,
           yield_adjustment_version = COALESCE(production.yield_adjustment_version, NULLIF(production.payload->>'yield_adjustment_version', '')::integer),
           yield_adjustment_updated_at = COALESCE(production.yield_adjustment_updated_at, NULLIF(production.payload->>'yield_adjustment_updated_at', '')::timestamptz),
           yield_snapshot_source = COALESCE(production.yield_snapshot_source, NULLIF(production.payload->>'yield_snapshot_source', '')),
           quantity_semantics = COALESCE(production.quantity_semantics, NULLIF(production.payload->>'quantity_semantics', '')),
           reconciliation_mode = COALESCE(production.reconciliation_mode, NULLIF(production.payload->>'reconciliation_mode', '')),
           output_calculation_source = COALESCE(production.output_calculation_source, NULLIF(production.payload->>'output_calculation_source', '')),
           recipe_raw_weight_grams = COALESCE(production.recipe_raw_weight_grams, NULLIF(production.payload->>'recipe_raw_weight_grams', '')::numeric),
           total_raw_consumption_weight_grams = COALESCE(production.total_raw_consumption_weight_grams, NULLIF(production.payload->>'total_raw_consumption_weight_grams', '')::numeric),
           total_yielded_weight_grams = COALESCE(production.total_yielded_weight_grams, NULLIF(production.payload->>'total_yielded_weight_grams', '')::numeric),
           expected_finished_weight_grams = COALESCE(production.expected_finished_weight_grams, NULLIF(production.payload->>'expected_finished_weight_grams', '')::numeric),
           actual_finished_weight_grams = COALESCE(production.actual_finished_weight_grams, NULLIF(production.payload->>'actual_finished_weight_grams', '')::numeric),
           portion_size_grams = COALESCE(production.portion_size_grams, NULLIF(production.payload->>'portion_size_grams', '')::numeric),
           portion_size_source = COALESCE(production.portion_size_source, NULLIF(production.payload->>'portion_size_source', '')),
           expected_yield_servings = COALESCE(production.expected_yield_servings, NULLIF(production.payload->>'expected_yield_servings', '')::numeric),
           produced_servings = COALESCE(production.produced_servings, NULLIF(production.payload->>'produced_servings', '')::numeric),
           produced_weight_grams = COALESCE(production.produced_weight_grams, NULLIF(production.payload->>'produced_weight_grams', '')::numeric),
           completed_by_name = COALESCE(production.completed_by_name, NULLIF(production.payload->>'completed_by_name', '')),
           fulfillment_store_name = COALESCE(production.fulfillment_store_name, NULLIF(production.payload->>'fulfillment_store_name', '')),
           linked_material_request_id = COALESCE(production.linked_material_request_id, NULLIF(production.payload->>'linked_material_request_id', '')),
           linked_material_request_number = COALESCE(production.linked_material_request_number, NULLIF(production.payload->>'linked_material_request_number', '')),
           material_request_status = COALESCE(production.material_request_status, NULLIF(production.payload->>'material_request_status', '')),
           last_review_action = COALESCE(production.last_review_action, NULLIF(production.payload->>'last_review_action', '')),
           rejection_reason = COALESCE(production.rejection_reason, NULLIF(production.payload->>'rejection_reason', '')),
           cancellation_reason = COALESCE(production.cancellation_reason, NULLIF(production.payload->>'cancellation_reason', '')),
           cancelled_at = COALESCE(production.cancelled_at, NULLIF(production.payload->>'cancelled_at', '')::timestamptz),
           cancelled_by = COALESCE(production.cancelled_by, (
             SELECT app_user.id
             FROM users app_user
             WHERE app_user.id = NULLIF(production.payload->>'cancelled_by', '')
                OR LOWER(app_user.email) = LOWER(NULLIF(production.payload->>'cancelled_by', ''))
             LIMIT 1
           )),
           cancelled_by_name = COALESCE(production.cancelled_by_name, NULLIF(production.payload->>'cancelled_by_name', ''));

    ALTER TABLE production_events DROP COLUMN payload;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'production_manifest_lines'
      AND column_name = 'payload'
  ) THEN
    UPDATE production_manifest_lines line
       SET line_type = COALESCE(NULLIF(line.line_type, ''), NULLIF(line.payload->>'line_type', ''), 'recipe'),
           item_key = COALESCE(line.item_key, NULLIF(COALESCE(line.payload->>'key', line.payload->>'manifest_item_key'), '')),
           source_menu_plan_item_key = COALESCE(line.source_menu_plan_item_key, NULLIF(line.payload->>'source_menu_plan_item_key', '')),
           recipe_code = COALESCE(line.recipe_code, NULLIF(line.payload->>'recipe_code', '')),
           ingredient_name = COALESCE(line.ingredient_name, NULLIF(line.payload->>'ingredient_name', '')),
           meal_period = COALESCE(line.meal_period, NULLIF(line.payload->>'meal_type', '')),
           production_covers = COALESCE(line.production_covers, NULLIF(COALESCE(line.payload->>'production_covers', line.payload->>'expected_servings'), '')::numeric),
           raw_weight_grams = COALESCE(line.raw_weight_grams, NULLIF(line.payload->>'raw_weight_grams', '')::numeric),
           yielded_weight_grams = COALESCE(line.yielded_weight_grams, NULLIF(line.payload->>'yielded_weight_grams', '')::numeric),
           expected_finished_weight_grams = COALESCE(line.expected_finished_weight_grams, NULLIF(line.payload->>'expected_finished_weight_grams', '')::numeric),
           portion_size_grams = COALESCE(line.portion_size_grams, NULLIF(line.payload->>'portion_size_grams', '')::numeric),
           expected_yield_servings = COALESCE(line.expected_yield_servings, NULLIF(line.payload->>'expected_yield_servings', '')::numeric),
           output_calculation_source = COALESCE(line.output_calculation_source, NULLIF(line.payload->>'output_calculation_source', '')),
           weight_calculation_source = COALESCE(line.weight_calculation_source, NULLIF(line.payload->>'weight_calculation_source', '')),
           yield_calculation_source = COALESCE(line.yield_calculation_source, NULLIF(COALESCE(line.payload->>'yield_calculation_source', line.payload->>'yield_source'), '')),
           weight_snapshot_version = COALESCE(line.weight_snapshot_version, NULLIF(line.payload->>'weight_snapshot_version', '')::integer);

    ALTER TABLE production_manifest_lines DROP COLUMN payload;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'produced_output_batches'
      AND column_name = 'payload'
  ) THEN
    UPDATE produced_output_batches batch
       SET served_weight_grams = COALESCE(NULLIF(batch.payload->>'served_weight_grams', '')::numeric, batch.served_weight_grams, 0),
           wasted_weight_grams = COALESCE(NULLIF(batch.payload->>'wasted_weight_grams', '')::numeric, batch.wasted_weight_grams, 0),
           served_servings = COALESCE(NULLIF(batch.payload->>'served_servings', '')::numeric, batch.served_servings, 0),
           wasted_servings = COALESCE(NULLIF(batch.payload->>'wasted_servings', '')::numeric, batch.wasted_servings, 0),
           portion_size_grams = COALESCE(batch.portion_size_grams, NULLIF(batch.payload->>'portion_size_grams', '')::numeric),
           service_portion_size_grams = COALESCE(batch.service_portion_size_grams, NULLIF(batch.payload->>'service_portion_size_grams', '')::numeric),
           service_portion_updated_by = COALESCE(batch.service_portion_updated_by, NULLIF(batch.payload->>'service_portion_updated_by', '')),
           service_portion_updated_by_name = COALESCE(batch.service_portion_updated_by_name, NULLIF(batch.payload->>'service_portion_updated_by_name', '')),
           service_portion_updated_at = COALESCE(batch.service_portion_updated_at, NULLIF(batch.payload->>'service_portion_updated_at', '')::timestamptz),
           expected_servings = COALESCE(batch.expected_servings, NULLIF(COALESCE(batch.payload->>'expected_servings', batch.payload->>'produced_servings'), '')::numeric),
           expected_finished_weight_grams = COALESCE(batch.expected_finished_weight_grams, NULLIF(COALESCE(batch.payload->>'expected_finished_weight_grams', batch.payload->>'produced_weight_grams'), '')::numeric),
           actual_finished_weight_grams = COALESCE(batch.actual_finished_weight_grams, NULLIF(COALESCE(batch.payload->>'actual_finished_weight_grams', batch.payload->>'produced_weight_grams'), '')::numeric),
           source_type = COALESCE(batch.source_type, NULLIF(batch.payload->>'source_type', '')),
           source_event_id = COALESCE(batch.source_event_id, NULLIF(batch.payload->>'source_event_id', '')),
           menu_plan_id = COALESCE(batch.menu_plan_id, NULLIF(batch.payload->>'menu_plan_id', '')),
           consumption_report_id = COALESCE(batch.consumption_report_id, NULLIF(batch.payload->>'consumption_report_id', '')),
           consumption_report_number = COALESCE(batch.consumption_report_number, NULLIF(batch.payload->>'consumption_report_number', '')),
           production_issue_grouped = CASE
             WHEN batch.payload ? 'production_issue_grouped' THEN COALESCE((batch.payload->>'production_issue_grouped')::boolean, FALSE)
             ELSE batch.production_issue_grouped
           END,
           production_issue_item_count = COALESCE(batch.production_issue_item_count, NULLIF(batch.payload->>'production_issue_item_count', '')::integer),
           production_issue_dish_count = COALESCE(batch.production_issue_dish_count, NULLIF(batch.payload->>'production_issue_dish_count', '')::integer),
           completed_by = COALESCE(batch.completed_by, NULLIF(batch.payload->>'completed_by', '')),
           completed_by_name = COALESCE(batch.completed_by_name, NULLIF(batch.payload->>'completed_by_name', '')),
           reconciliation_mode = COALESCE(batch.reconciliation_mode, NULLIF(batch.payload->>'reconciliation_mode', '')),
           output_calculation_source = COALESCE(batch.output_calculation_source, NULLIF(batch.payload->>'output_calculation_source', '')),
           cutover_version = COALESCE(NULLIF(batch.payload->>'cutover_version', '')::integer, batch.cutover_version, 1);

    ALTER TABLE produced_output_batches DROP COLUMN payload;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'production_consumption_lines'
      AND column_name = 'payload'
  ) THEN
    ALTER TABLE production_consumption_lines DROP COLUMN payload;
  END IF;
END;
$production_payload_cutover$;

DO $meal_service_payload_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meal_service_headers'
       AND column_name = 'payload'
  ) THEN
    UPDATE meal_service_headers header
       SET request_fingerprint = COALESCE(header.request_fingerprint, NULLIF(header.payload->>'request_fingerprint', '')),
           reversal_idempotency_key = COALESCE(header.reversal_idempotency_key, NULLIF(header.payload->>'reversal_idempotency_key', '')),
           reversal_request_fingerprint = COALESCE(header.reversal_request_fingerprint, NULLIF(header.payload->>'reversal_request_fingerprint', '')),
           scope_key = COALESCE(header.scope_key, NULLIF(header.payload->>'scope_key', '')),
           menu_plan_id = COALESCE(header.menu_plan_id, (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF(header.payload->>'menu_plan_id', '') LIMIT 1)),
           menu_plan_name = COALESCE(header.menu_plan_name, NULLIF(header.payload->>'menu_plan_name', '')),
           customer_meal_plan_id = COALESCE(header.customer_meal_plan_id, NULLIF(header.payload->>'customer_meal_plan_id', '')),
           customer_meal_plan_name = COALESCE(header.customer_meal_plan_name, NULLIF(header.payload->>'customer_meal_plan_name', '')),
           customer_name = COALESCE(header.customer_name, NULLIF(header.payload->>'customer_name', '')),
           customer_id = COALESCE(header.customer_id, NULLIF(header.payload->>'customer_id', '')),
           category = COALESCE(header.category, NULLIF(header.payload->>'category', '')),
           attendee_count = COALESCE(NULLIF(header.payload->>'attendee_count', '')::numeric, header.attendee_count, 0),
           scan_method = COALESCE(header.scan_method, NULLIF(header.payload->>'scan_method', '')),
           notes = COALESCE(header.notes, NULLIF(header.payload->>'notes', '')),
           required_servings = COALESCE(NULLIF(header.payload->>'required_servings', '')::numeric, header.required_servings, 0),
           required_weight_grams = COALESCE(NULLIF(header.payload->>'required_weight_grams', '')::numeric, header.required_weight_grams, 0),
           served_servings = COALESCE(NULLIF(header.payload->>'served_servings', '')::numeric, header.served_servings, 0),
           served_weight_grams = COALESCE(NULLIF(header.payload->>'served_weight_grams', '')::numeric, header.served_weight_grams, 0),
           shortage_servings = COALESCE(NULLIF(COALESCE(header.payload->>'shortage_servings', header.payload->>'short_servings'), '')::numeric, header.shortage_servings, 0),
           shortage_weight_grams = COALESCE(NULLIF(COALESCE(header.payload->>'shortage_weight_grams', header.payload->>'short_weight_grams'), '')::numeric, header.shortage_weight_grams, 0),
           recorded_by = COALESCE(header.recorded_by, NULLIF(header.payload->>'recorded_by', '')),
           recorded_by_name = COALESCE(header.recorded_by_name, NULLIF(header.payload->>'recorded_by_name', '')),
           recorded_at = COALESCE(header.recorded_at, NULLIF(header.payload->>'recorded_at', '')::timestamptz),
           reversed_by_name = COALESCE(header.reversed_by_name, NULLIF(header.payload->>'reversed_by_name', '')),
           reversal_reason = COALESCE(header.reversal_reason, NULLIF(header.payload->>'reversal_reason', '')),
           cutover_version = COALESCE(NULLIF(header.payload->>'cutover_version', '')::integer, header.cutover_version, 1);

    INSERT INTO meal_service_items (
      meal_service_item_id, meal_service_id, item_order, output_batch_id, production_id,
      recipe_version_id, recipe_name, item_name, attendee_count, portions_per_attendee,
      servings_per_attendee, portion_size_grams, manual_portion_size_grams,
      portion_size_source, required_servings, required_weight_grams, served_servings,
      served_weight_grams, consumed_production_equivalent_servings, shortage_servings,
      shortage_weight_grams, cost, status, created_at, updated_at
    )
    SELECT
      COALESCE(NULLIF(item.value->>'id', ''), header.meal_service_id || ':item:' || item.ordinality),
      header.meal_service_id,
      item.ordinality::integer,
      (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF(COALESCE(item.value->>'output_batch_id', item.value->>'produced_item_batch_id', item.value->>'batch_id'), '') LIMIT 1),
      (SELECT production_id FROM production_events WHERE production_id = NULLIF(item.value->>'production_id', '') LIMIT 1),
      (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(COALESCE(item.value->>'recipe_id', item.value->>'recipe_version_id'), '') LIMIT 1),
      NULLIF(item.value->>'recipe_name', ''),
      NULLIF(COALESCE(item.value->>'item_name', item.value->>'recipe_name'), ''),
      NULLIF(item.value->>'attendee_count', '')::numeric,
      NULLIF(item.value->>'portions_per_attendee', '')::numeric,
      NULLIF(item.value->>'servings_per_attendee', '')::numeric,
      NULLIF(item.value->>'portion_size_grams', '')::numeric,
      NULLIF(item.value->>'manual_portion_size_grams', '')::numeric,
      NULLIF(item.value->>'portion_size_source', ''),
      COALESCE(NULLIF(item.value->>'required_servings', '')::numeric, 0),
      COALESCE(NULLIF(item.value->>'required_weight_grams', '')::numeric, 0),
      COALESCE(NULLIF(item.value->>'served_servings', '')::numeric, 0),
      COALESCE(NULLIF(item.value->>'served_weight_grams', '')::numeric, 0),
      NULLIF(item.value->>'consumed_production_equivalent_servings', '')::numeric,
      COALESCE(NULLIF(COALESCE(item.value->>'shortage_servings', item.value->>'short_servings'), '')::numeric, 0),
      COALESCE(NULLIF(COALESCE(item.value->>'shortage_weight_grams', item.value->>'short_weight_grams'), '')::numeric, 0),
      COALESCE(NULLIF(COALESCE(item.value->>'cost', item.value->>'total_cost'), '')::numeric, 0),
      COALESCE(NULLIF(item.value->>'status', ''), 'posted'),
      header.created_at,
      header.updated_at
    FROM meal_service_headers header
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(header.payload->'items') = 'array'
        THEN header.payload->'items'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS item(value, ordinality)
    ON CONFLICT (meal_service_item_id) DO NOTHING;

    ALTER TABLE meal_service_headers DROP COLUMN payload;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meal_service_consumptions'
       AND column_name = 'payload'
  ) THEN
    UPDATE meal_service_consumptions consumption
       SET menu_plan_id = COALESCE(consumption.menu_plan_id, (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF(consumption.payload->>'menu_plan_id', '') LIMIT 1)),
           menu_type = COALESCE(consumption.menu_type, NULLIF(consumption.payload->>'menu_type', '')),
           menu_category = COALESCE(consumption.menu_category, NULLIF(consumption.payload->>'menu_category', '')),
           customer_meal_plan_id = COALESCE(consumption.customer_meal_plan_id, NULLIF(consumption.payload->>'customer_meal_plan_id', '')),
           recipe_name = COALESCE(consumption.recipe_name, NULLIF(consumption.payload->>'recipe_name', '')),
           attendee_count = COALESCE(consumption.attendee_count, NULLIF(consumption.payload->>'attendee_count', '')::numeric),
           portions_per_attendee = COALESCE(consumption.portions_per_attendee, NULLIF(consumption.payload->>'portions_per_attendee', '')::numeric),
           servings_per_attendee = COALESCE(consumption.servings_per_attendee, NULLIF(consumption.payload->>'servings_per_attendee', '')::numeric),
           portion_size_grams = COALESCE(consumption.portion_size_grams, NULLIF(consumption.payload->>'portion_size_grams', '')::numeric),
           manual_portion_size_grams = COALESCE(consumption.manual_portion_size_grams, NULLIF(consumption.payload->>'manual_portion_size_grams', '')::numeric),
           portion_size_source = COALESCE(consumption.portion_size_source, NULLIF(consumption.payload->>'portion_size_source', '')),
           covers = COALESCE(consumption.covers, NULLIF(consumption.payload->>'covers', '')::numeric),
           required_servings = COALESCE(consumption.required_servings, NULLIF(consumption.payload->>'required_servings', '')::numeric),
           required_weight_grams = COALESCE(consumption.required_weight_grams, NULLIF(consumption.payload->>'required_weight_grams', '')::numeric),
           consumed_production_equivalent_servings = COALESCE(consumption.consumed_production_equivalent_servings, NULLIF(consumption.payload->>'consumed_production_equivalent_servings', '')::numeric),
           shortage_servings = COALESCE(consumption.shortage_servings, NULLIF(consumption.payload->>'shortage_servings', '')::numeric),
           shortage_weight_grams = COALESCE(consumption.shortage_weight_grams, NULLIF(consumption.payload->>'shortage_weight_grams', '')::numeric),
           reversal_reason = COALESCE(consumption.reversal_reason, NULLIF(consumption.payload->>'reversal_reason', '')),
           performed_by = COALESCE(consumption.performed_by, NULLIF(consumption.payload->>'performed_by', '')),
           performed_by_name = COALESCE(consumption.performed_by_name, NULLIF(consumption.payload->>'performed_by_name', '')),
           performed_at = COALESCE(consumption.performed_at, NULLIF(consumption.payload->>'performed_at', '')::timestamptz),
           cutover_version = COALESCE(NULLIF(consumption.payload->>'cutover_version', '')::integer, consumption.cutover_version, 1);

    INSERT INTO meal_service_consumption_allocations (
      meal_service_consumption_allocation_id, meal_consumption_id, allocation_order,
      output_batch_id, production_id, batch_number, portion_size_grams,
      service_portion_size_grams, servings, production_equivalent_servings,
      meal_portions, weight_grams, remaining_servings_before,
      remaining_servings_after, remaining_weight_grams_before,
      remaining_weight_grams_after, status, created_at, updated_at
    )
    SELECT
      COALESCE(NULLIF(allocation.value->>'id', ''), consumption.meal_consumption_id || ':allocation:' || allocation.ordinality),
      consumption.meal_consumption_id,
      allocation.ordinality::integer,
      (SELECT output_batch_id FROM produced_output_batches WHERE output_batch_id = NULLIF(COALESCE(allocation.value->>'output_batch_id', allocation.value->>'produced_item_batch_id', allocation.value->>'batch_id'), '') LIMIT 1),
      (SELECT production_id FROM production_events WHERE production_id = NULLIF(allocation.value->>'production_id', '') LIMIT 1),
      NULLIF(allocation.value->>'batch_number', ''),
      NULLIF(allocation.value->>'portion_size_grams', '')::numeric,
      NULLIF(allocation.value->>'service_portion_size_grams', '')::numeric,
      COALESCE(NULLIF(allocation.value->>'servings', '')::numeric, 0),
      COALESCE(NULLIF(COALESCE(allocation.value->>'production_equivalent_servings', allocation.value->>'servings'), '')::numeric, 0),
      COALESCE(NULLIF(allocation.value->>'meal_portions', '')::numeric, 0),
      COALESCE(NULLIF(allocation.value->>'weight_grams', '')::numeric, 0),
      NULLIF(allocation.value->>'remaining_servings_before', '')::numeric,
      NULLIF(allocation.value->>'remaining_servings_after', '')::numeric,
      NULLIF(allocation.value->>'remaining_weight_grams_before', '')::numeric,
      NULLIF(allocation.value->>'remaining_weight_grams_after', '')::numeric,
      COALESCE(NULLIF(allocation.value->>'status', ''), 'posted'),
      consumption.created_at,
      consumption.updated_at
    FROM meal_service_consumptions consumption
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(consumption.payload->'allocations') = 'array'
        THEN consumption.payload->'allocations'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS allocation(value, ordinality)
    ON CONFLICT (meal_service_consumption_allocation_id) DO NOTHING;

    ALTER TABLE meal_service_consumptions DROP COLUMN payload;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meal_service_lines'
       AND column_name = 'payload'
  ) THEN
    ALTER TABLE meal_service_lines DROP COLUMN payload;
  END IF;
END;
$meal_service_payload_cutover$;

DO $food_waste_payload_cutover$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'food_waste_records'
      AND column_name = 'payload'
  ) THEN
    EXECUTE $sql$
      UPDATE food_waste_records waste
         SET reason = COALESCE(waste.reason, NULLIF(waste.payload->>'reason', '')),
             waste_scope = COALESCE(NULLIF(waste.waste_scope, ''), NULLIF(waste.payload->>'waste_scope', ''), 'ingredient'),
             source_type = COALESCE(NULLIF(waste.source_type, ''), NULLIF(waste.payload->>'source_type', ''), 'manual_entry'),
             avoidable_type = COALESCE(NULLIF(waste.avoidable_type, ''), NULLIF(waste.payload->>'avoidable_type', ''), 'avoidable'),
             preventable = CASE
               WHEN waste.payload ? 'preventable' THEN COALESCE((waste.payload->>'preventable')::boolean, TRUE)
               ELSE waste.preventable
             END,
             auto_generated = CASE
               WHEN waste.payload ? 'auto_generated' THEN COALESCE((waste.payload->>'auto_generated')::boolean, FALSE)
               ELSE waste.auto_generated
             END,
             high_value = CASE
               WHEN waste.payload ? 'high_value' THEN COALESCE((waste.payload->>'high_value')::boolean, FALSE)
               ELSE waste.high_value
             END,
             quantity_grams = COALESCE(NULLIF(COALESCE(waste.payload->>'waste_weight_grams', waste.payload->>'quantity_grams', waste.payload->>'wasted_weight_grams'), '')::numeric, waste.quantity_grams, 0),
             unit = COALESCE(NULLIF(waste.unit, ''), NULLIF(waste.payload->>'unit', ''), 'g'),
             estimated_cost = COALESCE(NULLIF(COALESCE(waste.payload->>'estimated_cost', waste.payload->>'waste_cost', waste.payload->>'cost'), '')::numeric, waste.estimated_cost, 0),
             menu_plan_id = COALESCE(waste.menu_plan_id, (SELECT menu_plan_id FROM menu_plans WHERE menu_plan_id = NULLIF(waste.payload->>'menu_plan_id', '') LIMIT 1)),
             menu_plan_name = COALESCE(waste.menu_plan_name, NULLIF(waste.payload->>'menu_plan_name', '')),
             meal_service_id = COALESCE(waste.meal_service_id, (SELECT meal_service_id FROM meal_service_headers WHERE meal_service_id = NULLIF(waste.payload->>'meal_service_attendance_id', '') LIMIT 1)),
             production_id = COALESCE(waste.production_id, (SELECT production_id FROM production_events WHERE production_id = NULLIF(waste.payload->>'production_id', '') LIMIT 1)),
             recipe_version_id = COALESCE(waste.recipe_version_id, (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(waste.payload->>'recipe_id', '') LIMIT 1)),
             ingredient_id = COALESCE(waste.ingredient_id, (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(waste.payload->>'ingredient_id', '') LIMIT 1)),
             production_name = COALESCE(waste.production_name, NULLIF(waste.payload->>'production_name', '')),
             recipe_name = COALESCE(waste.recipe_name, NULLIF(waste.payload->>'recipe_name', '')),
             ingredient_name = COALESCE(waste.ingredient_name, NULLIF(waste.payload->>'ingredient_name', '')),
             batch_reference = COALESCE(waste.batch_reference, NULLIF(waste.payload->>'batch_reference', '')),
             batch_overproduction_item_key = COALESCE(waste.batch_overproduction_item_key, NULLIF(waste.payload->>'batch_overproduction_item_key', '')),
             manifest_item_key = COALESCE(waste.manifest_item_key, NULLIF(waste.payload->>'manifest_item_key', '')),
             source_menu_plan_item_key = COALESCE(waste.source_menu_plan_item_key, NULLIF(waste.payload->>'source_menu_plan_item_key', '')),
             batch_recipe_id = COALESCE(waste.batch_recipe_id, NULLIF(waste.payload->>'batch_recipe_id', '')),
             batch_recipe_name = COALESCE(waste.batch_recipe_name, NULLIF(waste.payload->>'batch_recipe_name', '')),
             produced_weight_grams = COALESCE(waste.produced_weight_grams, NULLIF(waste.payload->>'produced_weight_grams', '')::numeric),
             available_weight_grams_before = COALESCE(waste.available_weight_grams_before, NULLIF(waste.payload->>'available_weight_grams_before', '')::numeric),
             wasted_production_equivalent_servings = COALESCE(waste.wasted_production_equivalent_servings, NULLIF(waste.payload->>'wasted_production_equivalent_servings', '')::numeric),
             served_at = COALESCE(waste.served_at, NULLIF(waste.payload->>'served_at', '')::timestamptz),
             production_completed_at = COALESCE(waste.production_completed_at, NULLIF(waste.payload->>'production_completed_at', '')::timestamptz),
             recording_window_basis = COALESCE(waste.recording_window_basis, NULLIF(waste.payload->>'recording_window_basis', '')),
             recording_window_open_at = COALESCE(waste.recording_window_open_at, NULLIF(waste.payload->>'recording_window_open_at', '')::timestamptz),
             recording_deadline_at = COALESCE(waste.recording_deadline_at, NULLIF(waste.payload->>'recording_deadline_at', '')::timestamptz),
             meal_service_adjustment_cost = COALESCE(NULLIF(waste.payload->>'meal_service_adjustment_cost', '')::numeric, waste.meal_service_adjustment_cost, 0),
             inventory_transaction_id = COALESCE(waste.inventory_transaction_id, NULLIF(waste.payload->>'inventory_transaction_id', '')),
             inventory_deduction_quantity = COALESCE(NULLIF(waste.payload->>'inventory_deduction_quantity', '')::numeric, waste.inventory_deduction_quantity, 0),
             inventory_shortage_quantity = COALESCE(NULLIF(waste.payload->>'inventory_shortage_quantity', '')::numeric, waste.inventory_shortage_quantity, 0),
             notes = COALESCE(waste.notes, NULLIF(waste.payload->>'notes', ''));
    $sql$;

    EXECUTE $sql$
      WITH food_waste_image_source AS (
        SELECT
          waste.food_waste_id,
          btrim(raw.image_url) AS image_url,
          MIN(raw.image_order) AS image_order
        FROM food_waste_records waste
        CROSS JOIN LATERAL (
          SELECT image_value AS image_url, image_ordinal::integer AS image_order
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(waste.payload->'evidence_image_urls') = 'array'
                THEN waste.payload->'evidence_image_urls'
              ELSE '[]'::jsonb
            END
          ) WITH ORDINALITY AS image_values(image_value, image_ordinal)
          UNION ALL
          SELECT image_value AS image_url, (100 + image_ordinal)::integer AS image_order
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(waste.payload->'image_urls') = 'array'
                THEN waste.payload->'image_urls'
              ELSE '[]'::jsonb
            END
          ) WITH ORDINALITY AS image_values(image_value, image_ordinal)
          UNION ALL
          SELECT waste.payload->>'evidence_image_url' AS image_url, 1 AS image_order
          WHERE COALESCE(waste.payload->>'evidence_image_url', '') <> ''
          UNION ALL
          SELECT waste.payload->>'image_url' AS image_url, 2 AS image_order
          WHERE COALESCE(waste.payload->>'image_url', '') <> ''
        ) raw
        WHERE COALESCE(btrim(raw.image_url), '') <> ''
        GROUP BY waste.food_waste_id, btrim(raw.image_url)
      )
      INSERT INTO food_waste_images (
        food_waste_image_id, food_waste_id, image_url, image_order, created_at
      )
      SELECT
        food_waste_id || ':image:' || ROW_NUMBER() OVER (
          PARTITION BY food_waste_id
          ORDER BY image_order, image_url
        ),
        food_waste_id,
        image_url,
        ROW_NUMBER() OVER (
          PARTITION BY food_waste_id
          ORDER BY image_order, image_url
        ),
        NOW()
      FROM food_waste_image_source
      ON CONFLICT (food_waste_id, image_url) DO UPDATE SET
        image_order = LEAST(food_waste_images.image_order, EXCLUDED.image_order);
    $sql$;

    EXECUTE $sql$
      WITH food_waste_inventory_movement_source AS (
        SELECT
          waste.food_waste_id,
          movement.value AS movement_data,
          movement.ordinality::integer AS movement_order
        FROM food_waste_records waste
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(waste.payload->'inventory_movement_layers') = 'array'
              THEN waste.payload->'inventory_movement_layers'
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS movement(value, ordinality)
      )
      INSERT INTO food_waste_inventory_movements (
        food_waste_inventory_movement_id, food_waste_id, movement_order,
        inventory_transaction_id, inventory_id, lot_id, ingredient_id,
        quantity, unit, unit_cost, total_cost, stock_date, expiry_date, source_name,
        created_at
      )
      SELECT
        food_waste_id || ':movement:' || movement_order,
        food_waste_id,
        movement_order,
        NULLIF(movement_data->>'inventory_transaction_id', ''),
        (SELECT inventory_id FROM warehouse_inventory WHERE inventory_id = NULLIF(movement_data->>'inventory_id', '') LIMIT 1),
        (SELECT lot_id FROM inventory_lots WHERE lot_id = NULLIF(movement_data->>'lot_id', '') LIMIT 1),
        (SELECT ingredient_id FROM ingredients WHERE ingredient_id = NULLIF(movement_data->>'ingredient_id', '') LIMIT 1),
        COALESCE(NULLIF(COALESCE(movement_data->>'quantity', movement_data->>'deducted_quantity'), '')::numeric, 0),
        NULLIF(movement_data->>'unit', ''),
        COALESCE(NULLIF(movement_data->>'unit_cost', '')::numeric, 0),
        COALESCE(NULLIF(COALESCE(movement_data->>'total_cost', movement_data->>'cost'), '')::numeric, 0),
        NULLIF(movement_data->>'stock_date', '')::date,
        NULLIF(movement_data->>'expiry_date', '')::date,
        NULLIF(movement_data->>'source_name', ''),
        NOW()
      FROM food_waste_inventory_movement_source
      ON CONFLICT (food_waste_inventory_movement_id) DO NOTHING;
    $sql$;

    ALTER TABLE food_waste_records DROP COLUMN payload;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'food_waste_lines'
      AND column_name = 'payload'
  ) THEN
    EXECUTE $sql$
      UPDATE food_waste_lines line
         SET production_id = COALESCE(line.production_id, (SELECT production_id FROM production_events WHERE production_id = NULLIF(line.payload->>'production_id', '') LIMIT 1)),
             recipe_version_id = COALESCE(line.recipe_version_id, (SELECT recipe_version_id FROM recipe_versions WHERE recipe_version_id = NULLIF(COALESCE(line.payload->>'recipe_id', line.payload->>'recipe_version_id'), '') LIMIT 1)),
             line_number = COALESCE(NULLIF(line.payload->>'line_number', '')::integer, line.line_number, 1),
             item_name = COALESCE(line.item_name, NULLIF(COALESCE(line.payload->>'item_name', line.payload->>'recipe_name', line.payload->>'ingredient_name'), '')),
             batch_number = COALESCE(line.batch_number, NULLIF(line.payload->>'batch_number', '')),
             batch_overproduction_item_key = COALESCE(line.batch_overproduction_item_key, NULLIF(line.payload->>'batch_overproduction_item_key', '')),
             manifest_item_key = COALESCE(line.manifest_item_key, NULLIF(line.payload->>'manifest_item_key', '')),
             source_menu_plan_item_key = COALESCE(line.source_menu_plan_item_key, NULLIF(line.payload->>'source_menu_plan_item_key', '')),
             wasted_production_equivalent_servings = COALESCE(line.wasted_production_equivalent_servings, NULLIF(line.payload->>'wasted_production_equivalent_servings', '')::numeric),
             produced_weight_grams_before = COALESCE(line.produced_weight_grams_before, NULLIF(line.payload->>'produced_weight_grams', '')::numeric),
             available_weight_grams_before = COALESCE(line.available_weight_grams_before, NULLIF(line.payload->>'available_weight_grams_before', '')::numeric);
    $sql$;

    ALTER TABLE food_waste_lines DROP COLUMN payload;
  END IF;
	END;
	$food_waste_payload_cutover$;

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
  action TEXT,
  site_id TEXT,
  reference_id TEXT,
  details_text TEXT,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log_details (
  id TEXT PRIMARY KEY,
  audit_log_id TEXT NOT NULL REFERENCES audit_logs(id) ON DELETE CASCADE,
  detail_path TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  value_type TEXT NOT NULL,
  string_value TEXT,
  numeric_value NUMERIC,
  boolean_value BOOLEAN,
  value_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $audit_log_details_json_cutover$
DECLARE
  has_details BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_logs'
      AND column_name = 'details'
  ) INTO has_details;

  IF has_details THEN
    EXECUTE $sql$
      WITH RECURSIVE audit_json(audit_id, detail_path, detail_value, sort_path) AS (
        SELECT id, ARRAY[]::TEXT[], details, ARRAY[0]::INTEGER[]
        FROM audit_logs
        WHERE details IS NOT NULL

        UNION ALL

        SELECT parent.audit_id,
               parent.detail_path || child.key,
               child.value,
               parent.sort_path || child.ordinality::INTEGER
        FROM audit_json parent
        CROSS JOIN LATERAL (
          SELECT entry.key, entry.value, ROW_NUMBER() OVER (ORDER BY entry.key)::INTEGER AS ordinality
          FROM jsonb_each(parent.detail_value) AS entry(key, value)
        ) AS child
        WHERE jsonb_typeof(parent.detail_value) = 'object'

        UNION ALL

        SELECT parent.audit_id,
               parent.detail_path || (child.ordinality - 1)::TEXT,
               child.value,
               parent.sort_path || child.ordinality::INTEGER
        FROM audit_json parent
        CROSS JOIN LATERAL jsonb_array_elements(parent.detail_value) WITH ORDINALITY AS child(value, ordinality)
        WHERE jsonb_typeof(parent.detail_value) = 'array'
      ),
      flattened AS (
        SELECT audit_id,
               detail_path,
               detail_value,
               jsonb_typeof(detail_value) AS value_type,
               ROW_NUMBER() OVER (PARTITION BY audit_id ORDER BY sort_path)::INTEGER AS value_order
        FROM audit_json
        WHERE cardinality(detail_path) > 0
      )
      INSERT INTO audit_log_details (
        id, audit_log_id, detail_path, value_type, string_value, numeric_value,
        boolean_value, value_order, created_at
      )
      SELECT 'auditdet_' || gen_random_uuid()::TEXT,
             audit_id,
             detail_path,
             value_type,
             CASE WHEN value_type = 'string' THEN detail_value #>> '{}' ELSE NULL END,
             CASE WHEN value_type = 'number' THEN (detail_value #>> '{}')::NUMERIC ELSE NULL END,
             CASE WHEN value_type = 'boolean' THEN (detail_value #>> '{}')::BOOLEAN ELSE NULL END,
             value_order,
             NOW()
      FROM flattened source
      WHERE NOT EXISTS (
        SELECT 1
        FROM audit_log_details existing
        WHERE existing.audit_log_id = source.audit_id
      )
    $sql$;

    EXECUTE 'ALTER TABLE audit_logs DROP COLUMN details';
  END IF;
END;
$audit_log_details_json_cutover$;

CREATE OR REPLACE FUNCTION foodpro_jsonb_text_array(value JSONB)
RETURNS TEXT[]
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(
    array_agg(BTRIM(item_value)) FILTER (WHERE COALESCE(BTRIM(item_value), '') <> ''),
    ARRAY[]::TEXT[]
  )
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END
  ) AS array_values(item_value);
$$;

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
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_name TEXT,
  role TEXT,
  site_id TEXT,
  site_name TEXT,
  source_name TEXT,
  recipe_type TEXT,
  menu_cuisine TEXT,
  menu_category TEXT,
  actor_role_access_level TEXT,
  actor_role_is_active BOOLEAN NOT NULL DEFAULT TRUE,
  actor_site_id TEXT,
  actor_site_name TEXT,
  actor_visibility_scope TEXT,
  actor_allowed_site_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  actor_allowed_site_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  actor_role_permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bulk_upload_jobs
  ADD COLUMN IF NOT EXISTS source_name TEXT,
  ADD COLUMN IF NOT EXISTS recipe_type TEXT,
  ADD COLUMN IF NOT EXISTS menu_cuisine TEXT,
  ADD COLUMN IF NOT EXISTS menu_category TEXT,
  ADD COLUMN IF NOT EXISTS actor_role_access_level TEXT,
  ADD COLUMN IF NOT EXISTS actor_role_is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS actor_site_id TEXT,
  ADD COLUMN IF NOT EXISTS actor_site_name TEXT,
  ADD COLUMN IF NOT EXISTS actor_visibility_scope TEXT,
  ADD COLUMN IF NOT EXISTS actor_allowed_site_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS actor_allowed_site_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS actor_role_permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS bulk_upload_job_errors (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES bulk_upload_jobs(id) ON DELETE CASCADE,
  row_number INTEGER,
  message TEXT NOT NULL,
  error_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $bulk_upload_jobs_json_cutover$
DECLARE
  has_actor_snapshot BOOLEAN;
  has_errors BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bulk_upload_jobs'
      AND column_name = 'actor_snapshot'
  ) INTO has_actor_snapshot;

  IF has_actor_snapshot THEN
    UPDATE bulk_upload_jobs
       SET recipe_type = COALESCE(recipe_type, NULLIF(actor_snapshot->'bulk_options'->>'recipe_type', '')),
           menu_cuisine = COALESCE(menu_cuisine, NULLIF(actor_snapshot->'bulk_options'->>'menu_cuisine', '')),
           menu_category = COALESCE(menu_category, NULLIF(actor_snapshot->'bulk_options'->>'menu_category', '')),
           actor_role_access_level = COALESCE(
             actor_role_access_level,
             NULLIF(actor_snapshot->>'role_access_level', ''),
             NULLIF(actor_snapshot->>'access_level', '')
           ),
           actor_role_is_active = CASE
             WHEN actor_snapshot ? 'role_is_active' THEN COALESCE((actor_snapshot->>'role_is_active')::boolean, TRUE)
             ELSE COALESCE(actor_role_is_active, TRUE)
           END,
           actor_site_id = COALESCE(actor_site_id, NULLIF(actor_snapshot->>'site_id', '')),
           actor_site_name = COALESCE(actor_site_name, NULLIF(actor_snapshot->>'site_name', '')),
           actor_visibility_scope = COALESCE(actor_visibility_scope, NULLIF(actor_snapshot->>'visibility_scope', '')),
           actor_allowed_site_ids = CASE
             WHEN cardinality(actor_allowed_site_ids) > 0 THEN actor_allowed_site_ids
             ELSE foodpro_jsonb_text_array(actor_snapshot->'allowed_site_ids')
           END,
           actor_allowed_site_names = CASE
             WHEN cardinality(actor_allowed_site_names) > 0 THEN actor_allowed_site_names
             ELSE foodpro_jsonb_text_array(actor_snapshot->'allowed_site_names')
           END,
           actor_role_permissions = CASE
             WHEN cardinality(actor_role_permissions) > 0 THEN actor_role_permissions
             ELSE foodpro_jsonb_text_array(actor_snapshot->'role_permissions')
           END;

    EXECUTE 'ALTER TABLE bulk_upload_jobs DROP COLUMN actor_snapshot';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bulk_upload_jobs'
      AND column_name = 'errors'
  ) INTO has_errors;

  IF has_errors THEN
    INSERT INTO bulk_upload_job_errors (id, job_id, row_number, message, error_order, created_at)
    SELECT
      'bulkerr_' || gen_random_uuid()::text,
      job.id,
      CASE
        WHEN COALESCE(error_item.value->>'row', '') ~ '^[0-9]+$'
          THEN (error_item.value->>'row')::integer
        ELSE NULL
      END,
      COALESCE(NULLIF(error_item.value->>'message', ''), 'Bulk upload failed.'),
      error_item.ordinality::integer,
      job.updated_at
    FROM bulk_upload_jobs job
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(job.errors) = 'array' THEN job.errors ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS error_item(value, ordinality)
    WHERE NOT EXISTS (
      SELECT 1
      FROM bulk_upload_job_errors existing
      WHERE existing.job_id = job.id
    );

    EXECUTE 'ALTER TABLE bulk_upload_jobs DROP COLUMN errors';
  END IF;
END;
$bulk_upload_jobs_json_cutover$;

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
  body_html TEXT,
  body_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS body_html TEXT,
  ADD COLUMN IF NOT EXISTS body_text TEXT;

DO $email_logs_payload_cutover$
DECLARE
  has_payload BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'email_logs'
      AND column_name = 'payload'
  ) INTO has_payload;

  IF has_payload THEN
    EXECUTE $sql$
      UPDATE email_logs
         SET recipient = COALESCE(recipient, NULLIF(payload->>'to', '')),
             subject = COALESCE(subject, NULLIF(payload->>'subject', '')),
             body_html = COALESCE(body_html, NULLIF(payload->>'html', '')),
             body_text = COALESCE(body_text, NULLIF(payload->>'body', '')),
             status = COALESCE(NULLIF(status, ''), NULLIF(payload->>'status', ''), 'queued')
       WHERE payload IS NOT NULL
    $sql$;

    EXECUTE 'ALTER TABLE email_logs DROP COLUMN payload';
  END IF;
END;
$email_logs_payload_cutover$;

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_source_headers (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES pos_sources(id) ON DELETE CASCADE,
  header_name TEXT NOT NULL,
  header_value TEXT NOT NULL,
  header_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $pos_source_settings_cutover$
DECLARE
  has_settings BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pos_sources'
      AND column_name = 'settings'
  ) INTO has_settings;

  IF has_settings THEN
    EXECUTE $sql$
      INSERT INTO pos_source_headers (
        id, source_id, header_name, header_value, header_order, created_at, updated_at
      )
      SELECT 'poshdr_' || gen_random_uuid()::TEXT,
             source.id,
             header.key,
             header.value #>> '{}',
             ROW_NUMBER() OVER (PARTITION BY source.id ORDER BY header.key)::INTEGER,
             NOW(),
             NOW()
      FROM pos_sources source
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(source.settings->'headers') = 'object'
            THEN source.settings->'headers'
          ELSE '{}'::jsonb
        END
      ) AS header(key, value)
      WHERE COALESCE(header.key, '') <> ''
        AND COALESCE(header.value #>> '{}', '') <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM pos_source_headers existing
          WHERE existing.source_id = source.id
        )
    $sql$;

    EXECUTE 'ALTER TABLE pos_sources DROP COLUMN settings';
  END IF;
END;
$pos_source_settings_cutover$;

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
  request_url TEXT,
  request_summary TEXT,
  response_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pos_sync_logs
  ADD COLUMN IF NOT EXISTS request_url TEXT,
  ADD COLUMN IF NOT EXISTS request_summary TEXT,
  ADD COLUMN IF NOT EXISTS response_summary TEXT;

ALTER TABLE pos_sales_orders DROP COLUMN IF EXISTS raw_payload;
ALTER TABLE pos_sales_items DROP COLUMN IF EXISTS raw_payload;
ALTER TABLE pos_sync_logs DROP COLUMN IF EXISTS request_payload;
ALTER TABLE pos_sync_logs DROP COLUMN IF EXISTS response_payload;

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  supplier_code TEXT,
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
  categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supplier_code TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS source_name TEXT;
ALTER TABLE suppliers DROP COLUMN IF EXISTS payload;

DO $supplier_categories_text_array$
DECLARE
  category_column_type TEXT;
BEGIN
  SELECT udt_name
    INTO category_column_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'suppliers'
    AND column_name = 'categories';

  IF category_column_type = 'jsonb' THEN
    ALTER TABLE suppliers ALTER COLUMN categories DROP DEFAULT;
    ALTER TABLE suppliers ALTER COLUMN categories TYPE TEXT[] USING foodpro_jsonb_text_array(categories);
    ALTER TABLE suppliers ALTER COLUMN categories SET DEFAULT ARRAY[]::TEXT[];
    ALTER TABLE suppliers ALTER COLUMN categories SET NOT NULL;
  ELSIF category_column_type = '_text' THEN
    UPDATE suppliers SET categories = ARRAY[]::TEXT[] WHERE categories IS NULL;
    ALTER TABLE suppliers ALTER COLUMN categories SET DEFAULT ARRAY[]::TEXT[];
    ALTER TABLE suppliers ALTER COLUMN categories SET NOT NULL;
  END IF;
END;
$supplier_categories_text_array$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_supplier_code_unique
  ON suppliers (LOWER(BTRIM(supplier_code)))
  WHERE COALESCE(BTRIM(supplier_code), '') <> '';

CREATE INDEX IF NOT EXISTS idx_suppliers_source_status
  ON suppliers (source_name, status, updated_at DESC);

INSERT INTO suppliers (
  id, name, supplier_code, contact_person, email, phone, address, city, country, payment_terms,
  lead_time_days, status, rating, categories, notes, source_name, created_at, updated_at
)
SELECT
  record.id,
  COALESCE(NULLIF(record.data->>'name', ''), NULLIF(record.data->>'supplier_name', ''), record.id),
  NULLIF(record.data->>'supplier_code', ''),
  NULLIF(record.data->>'contact_person', ''),
  NULLIF(record.data->>'email', ''),
  NULLIF(record.data->>'phone', ''),
  NULLIF(record.data->>'address', ''),
  NULLIF(record.data->>'city', ''),
  NULLIF(record.data->>'country', ''),
  NULLIF(record.data->>'payment_terms', ''),
  CASE WHEN COALESCE(record.data->>'lead_time_days', '') ~ '^[0-9]+$'
    THEN (record.data->>'lead_time_days')::integer ELSE 0 END,
  COALESCE(NULLIF(record.data->>'status', ''), CASE WHEN record.data->>'is_active' = 'false' THEN 'inactive' ELSE 'active' END),
  CASE WHEN COALESCE(record.data->>'rating', '') ~ '^-?[0-9]+([.][0-9]+)?$'
    THEN (record.data->>'rating')::numeric ELSE 0 END,
  foodpro_jsonb_text_array(record.data->'categories'),
  NULLIF(record.data->>'notes', ''),
  NULLIF(record.data->>'source_name', ''),
  record.created_at,
  record.updated_at
FROM entity_records record
WHERE record.entity_name = 'Supplier'
ON CONFLICT (id) DO NOTHING;

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
ALTER TABLE app_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE app_logs ADD COLUMN IF NOT EXISTS site_id TEXT;
ALTER TABLE app_logs ADD COLUMN IF NOT EXISTS reference_id TEXT;
ALTER TABLE app_logs ADD COLUMN IF NOT EXISTS details_text TEXT;
DO $app_logs_payload_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'app_logs'
      AND column_name = 'payload'
  ) THEN
    UPDATE app_logs
       SET action = COALESCE(action, NULLIF(payload->>'action', ''), NULLIF(payload->>'event', ''), NULLIF(payload->>'type', '')),
           site_id = COALESCE(site_id, NULLIF(payload->>'site_id', ''), NULLIF(payload->>'location_id', ''), NULLIF(payload->>'warehouse_id', '')),
           reference_id = COALESCE(
             reference_id,
             NULLIF(payload->>'reference_id', ''),
             NULLIF(payload->>'generated_pr_id', ''),
             NULLIF(payload->>'request_id', ''),
             NULLIF(payload->>'scenario_id', ''),
             NULLIF(payload->>'snapshot_id', '')
           ),
           details_text = COALESCE(details_text, payload::text);
    ALTER TABLE app_logs DROP COLUMN payload;
  END IF;
END;
$app_logs_payload_cutover$;
CREATE INDEX IF NOT EXISTS idx_app_logs_user ON app_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_app_logs_site_action ON app_logs(site_id, action, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_site ON audit_logs(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_details_log_order
  ON audit_log_details(audit_log_id, value_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_audit_log_details_path
  ON audit_log_details USING GIN (detail_path);
CREATE INDEX IF NOT EXISTS idx_audit_log_details_string_search
  ON audit_log_details USING GIN (string_value gin_trgm_ops)
  WHERE string_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bulk_upload_jobs_status ON bulk_upload_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_upload_jobs_actor ON bulk_upload_jobs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_upload_jobs_site ON bulk_upload_jobs(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_upload_job_errors_job_order
  ON bulk_upload_job_errors(job_id, error_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_pos_source_headers_source_order
  ON pos_source_headers(source_id, header_order ASC, header_name ASC);
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

-- ---------------------------------------------------------------------------
-- Monthly menu-plan based purchase requests
-- ---------------------------------------------------------------------------
-- This workflow is separate from the older ad-hoc purchase request/order flow.
-- It stores the monthly PR header, aggregated D365-ready ingredient lines,
-- source menu plan lines, low-pax warnings, business approvals, and export log
-- in normalized tables so the feature can scale without JSON scans.
CREATE TABLE IF NOT EXISTS monthly_purchase_requests (
  request_id TEXT PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE,
  selected_site_id TEXT NOT NULL,
  selected_site_name TEXT NOT NULL,
  area_id TEXT,
  area_name TEXT,
  project_id TEXT,
  project_name TEXT,
  primary_warehouse_id TEXT,
  primary_warehouse_name TEXT,
  warehouse_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  month_key TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  inclusions TEXT NOT NULL DEFAULT 'all_meals',
  status TEXT NOT NULL DEFAULT 'pending_project_manager',
  current_step TEXT NOT NULL DEFAULT 'project_manager',
  prepared_by TEXT,
  prepared_by_name TEXT,
  project_manager_approved_by TEXT,
  project_manager_approved_by_name TEXT,
  project_manager_approved_at TIMESTAMPTZ,
  area_manager_approved_by TEXT,
  area_manager_approved_by_name TEXT,
  area_manager_approved_at TIMESTAMPTZ,
  exported_by TEXT,
  exported_by_name TEXT,
  exported_at TIMESTAMPTZ,
  d365_status TEXT NOT NULL DEFAULT 'placeholder',
  warning_count INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  total_estimated_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  chef_warning_note TEXT,
  return_reason TEXT,
  notes TEXT,
  missing_recipe_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  missing_ingredient_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_scope
  ON monthly_purchase_requests (month_key, selected_site_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_status
  ON monthly_purchase_requests (status, current_step, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_warehouse_ids
  ON monthly_purchase_requests USING GIN (warehouse_ids);

CREATE TABLE IF NOT EXISTS monthly_purchase_request_lines (
  line_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES monthly_purchase_requests(request_id) ON DELETE CASCADE,
  ingredient_id TEXT,
  item_code TEXT,
  item_name TEXT NOT NULL,
  warehouse_id TEXT,
  project_id TEXT,
  delivery_date DATE,
  requested_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,
  unit TEXT NOT NULL,
  estimated_unit_price NUMERIC(18, 6) NOT NULL DEFAULT 0,
  estimated_line_amount NUMERIC(18, 6) NOT NULL DEFAULT 0,
  source_line_count INTEGER NOT NULL DEFAULT 0,
  source_line_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_lines_request
  ON monthly_purchase_request_lines (request_id, item_name);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_lines_item
  ON monthly_purchase_request_lines (ingredient_id, warehouse_id);

CREATE TABLE IF NOT EXISTS monthly_purchase_request_source_lines (
  source_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES monthly_purchase_requests(request_id) ON DELETE CASCADE,
  menu_plan_id TEXT,
  menu_plan_line_id TEXT,
  warehouse_id TEXT,
  plan_date DATE,
  meal_period TEXT,
  menu_type TEXT,
  menu_category TEXT,
  recipe_id TEXT,
  recipe_name TEXT,
  planned_covers NUMERIC(18, 6) NOT NULL DEFAULT 0,
  warning_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_source_request
  ON monthly_purchase_request_source_lines (request_id, plan_date, meal_period, menu_category);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_source_plan
  ON monthly_purchase_request_source_lines (menu_plan_id, menu_plan_line_id);

ALTER TABLE monthly_purchase_requests
  ADD COLUMN IF NOT EXISTS missing_recipe_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE monthly_purchase_requests
  ADD COLUMN IF NOT EXISTS missing_ingredient_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE monthly_purchase_requests DROP COLUMN IF EXISTS payload;

ALTER TABLE monthly_purchase_request_lines
  ADD COLUMN IF NOT EXISTS source_line_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE monthly_purchase_request_lines DROP COLUMN IF EXISTS payload;

ALTER TABLE monthly_purchase_request_source_lines DROP COLUMN IF EXISTS payload;
DO $monthly_purchase_request_warning_codes_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'monthly_purchase_request_source_lines'
      AND column_name = 'warning_codes'
      AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE monthly_purchase_request_source_lines RENAME COLUMN warning_codes TO warning_codes_jsonb;
    ALTER TABLE monthly_purchase_request_source_lines ADD COLUMN warning_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
    UPDATE monthly_purchase_request_source_lines
       SET warning_codes = COALESCE((
         SELECT ARRAY_AGG(value)
         FROM jsonb_array_elements_text(warning_codes_jsonb) AS extracted(value)
       ), ARRAY[]::text[]);
    ALTER TABLE monthly_purchase_request_source_lines DROP COLUMN warning_codes_jsonb;
  ELSE
    ALTER TABLE monthly_purchase_request_source_lines
      ADD COLUMN IF NOT EXISTS warning_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
  END IF;
END;
$monthly_purchase_request_warning_codes_cutover$;

CREATE TABLE IF NOT EXISTS monthly_purchase_request_warnings (
  warning_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES monthly_purchase_requests(request_id) ON DELETE CASCADE,
  warning_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  menu_plan_id TEXT,
  menu_plan_line_id TEXT,
  plan_date DATE,
  meal_period TEXT,
  menu_type TEXT,
  menu_category TEXT,
  recipe_id TEXT,
  recipe_name TEXT,
  planned_covers NUMERIC(18, 6) NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'open',
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_warnings_request
  ON monthly_purchase_request_warnings (request_id, severity, plan_date);

CREATE TABLE IF NOT EXISTS monthly_purchase_request_workflow_actions (
  action_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES monthly_purchase_requests(request_id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  stage TEXT NOT NULL,
  actor_email TEXT,
  actor_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_actions_request
  ON monthly_purchase_request_workflow_actions (request_id, created_at);

CREATE TABLE IF NOT EXISTS monthly_purchase_request_exports (
  export_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES monthly_purchase_requests(request_id) ON DELETE CASCADE,
  export_format TEXT NOT NULL DEFAULT 'csv',
  exported_by TEXT,
  exported_by_name TEXT,
  d365_status TEXT NOT NULL DEFAULT 'manual_exported',
  notes TEXT,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monthly_pr_exports_request
  ON monthly_purchase_request_exports (request_id, exported_at DESC);

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
