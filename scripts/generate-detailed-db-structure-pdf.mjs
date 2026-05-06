import fs from 'fs';
import path from 'path';
import { jsPDF } from 'jspdf';

const outputDir = path.resolve('artifacts');
const outputPath = path.join(outputDir, 'FoodPro_Detailed_Database_Structure.pdf');

const relationalTables = [
  {
    name: 'users',
    purpose: 'Application user master for authentication, role assignment, and project/location scoping.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'email TEXT UNIQUE',
      'full_name TEXT',
      'role TEXT',
      'status TEXT',
      'site_id TEXT',
      'site_name TEXT',
      'password_hash TEXT',
      'temporary_password TEXT',
      'profile JSONB',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [],
    relationships: [
      'Referenced by auth_tokens.user_id',
      'Referenced by app_logs.user_id'
    ]
  },
  {
    name: 'auth_tokens',
    purpose: 'Session token store for authenticated user access.',
    primaryKey: 'token',
    columns: [
      'token TEXT PK',
      'user_id TEXT FK',
      'created_at TIMESTAMPTZ',
      'expires_at TIMESTAMPTZ'
    ],
    foreignKeys: ['user_id -> users.id ON DELETE CASCADE'],
    relationships: ['Many auth tokens can belong to one user']
  },
  {
    name: 'entity_records',
    purpose: 'Hybrid JSONB entity store for flexible business modules such as Inventory, Production, FoodWaste, Site, Recipe, and MaterialRequest.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'entity_name TEXT',
      'data JSONB',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [],
    relationships: [
      'Acts as the main backing store for operational entities defined in server/entities.js',
      'Indexed by entity_name and selected JSONB paths for Inventory and InventoryLot'
    ]
  },
  {
    name: 'app_logs',
    purpose: 'Application activity and page visit log.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'user_id TEXT FK',
      'user_email TEXT',
      'page_name TEXT',
      'payload JSONB',
      'visited_at TIMESTAMPTZ'
    ],
    foreignKeys: ['user_id -> users.id ON DELETE SET NULL'],
    relationships: ['Many log rows can belong to one user']
  },
  {
    name: 'email_logs',
    purpose: 'Outbound email dispatch tracking.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'recipient TEXT',
      'subject TEXT',
      'payload JSONB',
      'status TEXT',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: [],
    relationships: []
  },
  {
    name: 'pos_sources',
    purpose: 'POS provider configuration including API credentials, sync frequency, and default project/site context.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'name TEXT',
      'source_type TEXT',
      'api_url TEXT',
      'api_key TEXT',
      'api_secret TEXT',
      'sync_frequency TEXT',
      'is_active BOOLEAN',
      'default_site_id TEXT',
      'default_site_name TEXT',
      'settings JSONB',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [],
    relationships: [
      'Parent of pos_sales_orders',
      'Parent of pos_recipe_mapping',
      'Parent of pos_sync_logs'
    ]
  },
  {
    name: 'pos_sales_orders',
    purpose: 'Imported POS order headers.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'source_id TEXT FK',
      'external_order_id TEXT',
      'order_number TEXT',
      'site_id TEXT',
      'site_name TEXT',
      'location_name TEXT',
      'business_date DATE',
      'sold_at TIMESTAMPTZ',
      'currency TEXT',
      'total_amount NUMERIC(14,2)',
      'sync_method TEXT',
      'inventory_applied BOOLEAN',
      'raw_payload JSONB',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: ['source_id -> pos_sources.id ON DELETE SET NULL'],
    relationships: [
      'Parent of pos_sales_items',
      'Unique external order key on (source_id, external_order_id)'
    ]
  },
  {
    name: 'pos_sales_items',
    purpose: 'Imported POS order line items that can map to FoodPro recipes for deduction and variance analysis.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'order_id TEXT FK',
      'external_item_id TEXT',
      'pos_item_code TEXT',
      'pos_item_name TEXT',
      'recipe_id TEXT',
      'recipe_name TEXT',
      'quantity NUMERIC(14,3)',
      'unit_price NUMERIC(14,2)',
      'total_price NUMERIC(14,2)',
      'site_id TEXT',
      'site_name TEXT',
      'deduction_status TEXT',
      'raw_payload JSONB',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: ['order_id -> pos_sales_orders.id ON DELETE CASCADE'],
    relationships: ['Many sales items belong to one POS sales order']
  },
  {
    name: 'pos_recipe_mapping',
    purpose: 'Mapping between POS menu items and FoodPro recipes.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'source_id TEXT FK',
      'pos_item_code TEXT',
      'pos_item_name TEXT',
      'recipe_id TEXT',
      'recipe_name TEXT',
      'servings_per_sale NUMERIC(14,3)',
      'site_scope TEXT',
      'site_id TEXT',
      'auto_deduct BOOLEAN',
      'notes TEXT',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: ['source_id -> pos_sources.id ON DELETE CASCADE'],
    relationships: ['Lookup table used during POS import and inventory deduction']
  },
  {
    name: 'pos_sync_logs',
    purpose: 'Execution log for POS syncs and uploads.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'source_id TEXT FK',
      'sync_type TEXT',
      'status TEXT',
      'started_at TIMESTAMPTZ',
      'finished_at TIMESTAMPTZ',
      'records_received INTEGER',
      'records_imported INTEGER',
      'records_skipped INTEGER',
      'message TEXT',
      'request_payload JSONB',
      'response_payload JSONB',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: ['source_id -> pos_sources.id ON DELETE SET NULL'],
    relationships: ['Many sync logs can belong to one POS source']
  },
  {
    name: 'suppliers',
    purpose: 'Supplier master used in procurement and invoice tracking.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'name TEXT',
      'contact_person TEXT',
      'email TEXT',
      'phone TEXT',
      'address TEXT',
      'city TEXT',
      'country TEXT',
      'payment_terms TEXT',
      'lead_time_days INTEGER',
      'status TEXT',
      'rating NUMERIC(6,2)',
      'categories JSONB',
      'notes TEXT',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [],
    relationships: [
      'Parent of purchase_orders',
      'Parent of goods_receipts',
      'Parent of supplier_invoices',
      'Parent of supplier_price_history'
    ]
  },
  {
    name: 'purchase_requests',
    purpose: 'Procurement request header from manual requests or low-stock automation.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'request_number TEXT UNIQUE',
      'site_id TEXT',
      'site_name TEXT',
      'request_date DATE',
      'needed_by DATE',
      'requested_by TEXT',
      'requested_by_name TEXT',
      'priority TEXT',
      'status TEXT',
      'approval_role TEXT',
      'approved_by TEXT',
      'approved_by_name TEXT',
      'approved_at TIMESTAMPTZ',
      'auto_generated BOOLEAN',
      'source_type TEXT',
      'notes TEXT',
      'total_estimated_cost NUMERIC(14,2)',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [],
    relationships: [
      'Parent of purchase_request_items',
      'Can be referenced by purchase_orders'
    ]
  },
  {
    name: 'purchase_request_items',
    purpose: 'Line items for purchase requests.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'request_id TEXT FK',
      'ingredient_id TEXT',
      'ingredient_name TEXT',
      'description TEXT',
      'requested_quantity NUMERIC(14,3)',
      'approved_quantity NUMERIC(14,3)',
      'ordered_quantity NUMERIC(14,3)',
      'unit TEXT',
      'estimated_unit_price NUMERIC(14,2)',
      'line_total NUMERIC(14,2)',
      'status TEXT',
      'preferred_supplier_id TEXT',
      'preferred_supplier_name TEXT',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: ['request_id -> purchase_requests.id ON DELETE CASCADE'],
    relationships: [
      'Many request items belong to one purchase request',
      'Can be referenced by purchase_order_items'
    ]
  },
  {
    name: 'purchase_orders',
    purpose: 'Purchase order header issued against a request and supplier.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'po_number TEXT UNIQUE',
      'request_id TEXT FK',
      'supplier_id TEXT FK',
      'supplier_name TEXT',
      'site_id TEXT',
      'site_name TEXT',
      'order_date DATE',
      'expected_delivery_date DATE',
      'currency TEXT',
      'subtotal NUMERIC(14,2)',
      'tax_amount NUMERIC(14,2)',
      'total_amount NUMERIC(14,2)',
      'status TEXT',
      'approved_by TEXT',
      'approved_by_name TEXT',
      'approved_at TIMESTAMPTZ',
      'created_by TEXT',
      'created_by_name TEXT',
      'received_percentage NUMERIC(8,2)',
      'notes TEXT',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [
      'request_id -> purchase_requests.id ON DELETE SET NULL',
      'supplier_id -> suppliers.id ON DELETE SET NULL'
    ],
    relationships: [
      'Parent of purchase_order_items',
      'Parent of goods_receipts',
      'Referenced by supplier_invoices'
    ]
  },
  {
    name: 'purchase_order_items',
    purpose: 'Line items on purchase orders.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'order_id TEXT FK',
      'request_item_id TEXT FK',
      'ingredient_id TEXT',
      'ingredient_name TEXT',
      'ordered_quantity NUMERIC(14,3)',
      'received_quantity NUMERIC(14,3)',
      'unit TEXT',
      'unit_price NUMERIC(14,2)',
      'line_total NUMERIC(14,2)',
      'status TEXT',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: [
      'order_id -> purchase_orders.id ON DELETE CASCADE',
      'request_item_id -> purchase_request_items.id ON DELETE SET NULL'
    ],
    relationships: [
      'Many items belong to one purchase order',
      'Can be referenced by goods_receipt_items',
      'Can be referenced by supplier_price_history'
    ]
  },
  {
    name: 'goods_receipts',
    purpose: 'Goods receipt note header for received purchase orders.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'grn_number TEXT UNIQUE',
      'purchase_order_id TEXT FK',
      'supplier_id TEXT FK',
      'supplier_name TEXT',
      'site_id TEXT',
      'site_name TEXT',
      'receipt_date DATE',
      'received_by TEXT',
      'received_by_name TEXT',
      'status TEXT',
      'notes TEXT',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: [
      'purchase_order_id -> purchase_orders.id ON DELETE CASCADE',
      'supplier_id -> suppliers.id ON DELETE SET NULL'
    ],
    relationships: [
      'Parent of goods_receipt_items',
      'Can be referenced by supplier_invoices'
    ]
  },
  {
    name: 'goods_receipt_items',
    purpose: 'Receipt lines with accepted/rejected quantities, batch numbers, and expiry dates.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'receipt_id TEXT FK',
      'order_item_id TEXT FK',
      'ingredient_id TEXT',
      'ingredient_name TEXT',
      'received_quantity NUMERIC(14,3)',
      'accepted_quantity NUMERIC(14,3)',
      'rejected_quantity NUMERIC(14,3)',
      'unit TEXT',
      'batch_number TEXT',
      'expiry_date DATE',
      'status TEXT',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: [
      'receipt_id -> goods_receipts.id ON DELETE CASCADE',
      'order_item_id -> purchase_order_items.id ON DELETE SET NULL'
    ],
    relationships: [
      'Many receipt items belong to one goods receipt',
      'Used to populate InventoryLot and InventoryTransaction in app logic'
    ]
  },
  {
    name: 'supplier_invoices',
    purpose: 'Supplier invoice header tied to procurement activity.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'invoice_number TEXT UNIQUE',
      'supplier_id TEXT FK',
      'supplier_name TEXT',
      'purchase_order_id TEXT FK',
      'goods_receipt_id TEXT FK',
      'invoice_date DATE',
      'due_date DATE',
      'subtotal NUMERIC(14,2)',
      'tax_amount NUMERIC(14,2)',
      'total_amount NUMERIC(14,2)',
      'status TEXT',
      'entered_by TEXT',
      'entered_by_name TEXT',
      'notes TEXT',
      'created_at TIMESTAMPTZ',
      'updated_at TIMESTAMPTZ'
    ],
    foreignKeys: [
      'supplier_id -> suppliers.id ON DELETE SET NULL',
      'purchase_order_id -> purchase_orders.id ON DELETE SET NULL',
      'goods_receipt_id -> goods_receipts.id ON DELETE SET NULL'
    ],
    relationships: ['Many invoices can be associated with procurement flows']
  },
  {
    name: 'supplier_price_history',
    purpose: 'Historical ingredient price by supplier and purchase order line.',
    primaryKey: 'id',
    columns: [
      'id TEXT PK',
      'supplier_id TEXT FK',
      'supplier_name TEXT',
      'ingredient_id TEXT',
      'ingredient_name TEXT',
      'purchase_order_item_id TEXT FK',
      'unit_price NUMERIC(14,2)',
      'currency TEXT',
      'effective_date DATE',
      'lead_time_days INTEGER',
      'site_id TEXT',
      'site_name TEXT',
      'created_at TIMESTAMPTZ'
    ],
    foreignKeys: [
      'supplier_id -> suppliers.id ON DELETE CASCADE',
      'purchase_order_item_id -> purchase_order_items.id ON DELETE SET NULL'
    ],
    relationships: ['Used by supplier variance and procurement comparison reports']
  }
];

const entityBackedModels = [
  ['Site', 'Project hierarchy master. Unique by name and project_code. Drives Company -> Region -> Location -> Kitchen -> Store/Warehouse.'],
  ['User', 'Operational user profile. Unique by email. Stores role, site_id, allowed_site_ids, visibility_scope, and role_permissions.'],
  ['RoleProfile', 'Custom role definition. Unique by role_key and name. Stores access_level and permissions.'],
  ['Ingredient', 'Ingredient master. Unique by name, ingredient_code, and sku.'],
  ['Recipe', 'Recipe master. Unique by name and recipe_code.'],
  ['Inventory', 'Current stock by site and ingredient. Unique by site_id + ingredient_id.'],
  ['InventoryLot', 'Batch/lot balance by ingredient, site, batch_number, expiry_date.'],
  ['InventoryTransaction', 'Movement ledger for receipt, issue, production, transfer, and adjustment.'],
  ['MenuPlan', 'Planned recipe/meal schedule by project/site/date.'],
  ['Production', 'Production request / batch planning and execution record.'],
  ['MaterialRequest', 'Project/site material request linked to approved production and procurement flow.'],
  ['FoodWaste', 'Waste posting with ingredient/recipe/batch linkage, cost, and approval status.'],
  ['WasteTarget', 'Waste reduction targets by project/site and month.'],
  ['ProductionTransfer', 'Inter-location finished goods movement.'],
  ['AdvancedReportSchedule', 'Saved report schedule definitions.'],
  ['ERPIntegrationConfig', 'ERP provider connection and field mapping settings.'],
  ['ERPIntegrationLog', 'ERP export history and retry tracking.'],
  ['ForecastScenario', 'Demand forecasting scenario definition.'],
  ['ForecastSnapshot', 'Calculated forecast output snapshot.'],
  ['AttendanceSession / AttendanceRecord / StaffShift', 'Labor scheduling and attendance entities.'],
  ['CustomerMealPlan / BranchOrder / QualityControl / QRCode / QRDelivery / RFQ', 'Supporting operational modules built on the hybrid entity model.']
];

const keyIndexes = [
  'idx_entity_records_entity_name on entity_records(entity_name)',
  'idx_entity_records_entity_updated_at on entity_records(entity_name, updated_at DESC)',
  'idx_pos_sales_orders_source_external UNIQUE on pos_sales_orders(source_id, external_order_id) when external_order_id is not null',
  'idx_pos_recipe_mapping_lookup on pos_recipe_mapping(source_id, pos_item_code, pos_item_name)',
  'idx_purchase_requests_status on purchase_requests(status, request_date DESC)',
  'idx_purchase_orders_status on purchase_orders(status, order_date DESC)',
  'idx_goods_receipts_order on goods_receipts(purchase_order_id, receipt_date DESC)',
  'idx_supplier_invoices_supplier on supplier_invoices(supplier_id, invoice_date DESC)',
  'idx_supplier_price_history_lookup on supplier_price_history(ingredient_id, supplier_id, effective_date DESC)',
  "idx_entity_records_inventory_lookup on entity_records((data->>'site_id'), (data->>'ingredient_id')) for Inventory",
  "idx_entity_records_inventory_lot_lookup on entity_records((data->>'site_id'), (data->>'ingredient_id'), (data->>'batch_number')) for InventoryLot"
];

const relationshipMap = [
  'users (1) -> auth_tokens (many) by auth_tokens.user_id',
  'users (1) -> app_logs (many) by app_logs.user_id',
  'pos_sources (1) -> pos_sales_orders (many) by pos_sales_orders.source_id',
  'pos_sales_orders (1) -> pos_sales_items (many) by pos_sales_items.order_id',
  'pos_sources (1) -> pos_recipe_mapping (many) by pos_recipe_mapping.source_id',
  'pos_sources (1) -> pos_sync_logs (many) by pos_sync_logs.source_id',
  'purchase_requests (1) -> purchase_request_items (many) by purchase_request_items.request_id',
  'purchase_requests (1) -> purchase_orders (many/optional) by purchase_orders.request_id',
  'suppliers (1) -> purchase_orders (many) by purchase_orders.supplier_id',
  'purchase_orders (1) -> purchase_order_items (many) by purchase_order_items.order_id',
  'purchase_orders (1) -> goods_receipts (many) by goods_receipts.purchase_order_id',
  'goods_receipts (1) -> goods_receipt_items (many) by goods_receipt_items.receipt_id',
  'purchase_order_items (1) -> goods_receipt_items (many/optional) by goods_receipt_items.order_item_id',
  'suppliers (1) -> supplier_invoices (many) by supplier_invoices.supplier_id',
  'purchase_orders (1) -> supplier_invoices (many/optional) by supplier_invoices.purchase_order_id',
  'goods_receipts (1) -> supplier_invoices (many/optional) by supplier_invoices.goods_receipt_id',
  'suppliers (1) -> supplier_price_history (many) by supplier_price_history.supplier_id',
  'purchase_order_items (1) -> supplier_price_history (many/optional) by supplier_price_history.purchase_order_item_id',
  'entity_records is the parent store for JSONB-backed business entities such as Site, User, Ingredient, Recipe, Inventory, Production, MaterialRequest, and FoodWaste'
];

const locationScopingNotes = [
  'Server-side scoping is applied for Site, User, Inventory, InventoryLot, InventoryTransaction, Production, ProductionBatch, ProductionTransfer, MenuPlan, FoodWaste, MaterialRequest, Recipe, Attendance, Forecast, ERP logs, WasteTarget, and related operational entities.',
  'User assignment uses site_id, allowed_site_ids, and visibility_scope.',
  'For non-admin users, only assigned projects/locations or their permitted subtree are visible.',
  'This means data relationships exist globally in the database, but access to rows is filtered by project/site scope in application logic.'
];

function ensurePage(doc, y, needed = 18) {
  if (y > 274 - needed) {
    doc.addPage();
    return 18;
  }
  return y;
}

function addWrappedText(doc, text, x, y, width, lineHeight = 5) {
  const lines = doc.splitTextToSize(text, width);
  doc.text(lines, x, y);
  return y + (lines.length * lineHeight);
}

function addSectionTitle(doc, y, title) {
  y = ensurePage(doc, y, 14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(title, 14, y);
  return y + 8;
}

function addBulletList(doc, y, items, formatter) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  items.forEach((item, index) => {
    y = ensurePage(doc, y, 12);
    const line = formatter ? formatter(item, index) : String(item);
    doc.text('-', 16, y);
    y = addWrappedText(doc, line, 21, y, 168);
    y += 1.5;
  });
  return y;
}

function addTableDetail(doc, y, table) {
  y = ensurePage(doc, y, 32);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(table.name, 14, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addWrappedText(doc, `Purpose: ${table.purpose}`, 16, y, 176);
  y += 1.5;
  y = addWrappedText(doc, `Primary key: ${table.primaryKey}`, 16, y, 176);
  y += 3;

  doc.setFont('helvetica', 'bold');
  doc.text('Important columns', 16, y);
  y += 5;
  y = addBulletList(doc, y, table.columns);

  if (table.foreignKeys.length > 0) {
    doc.setFont('helvetica', 'bold');
    y = ensurePage(doc, y, 12);
    doc.text('Foreign keys', 16, y);
    y += 5;
    y = addBulletList(doc, y, table.foreignKeys);
  }

  if (table.relationships.length > 0) {
    doc.setFont('helvetica', 'bold');
    y = ensurePage(doc, y, 12);
    doc.text('Relationships', 16, y);
    y += 5;
    y = addBulletList(doc, y, table.relationships);
  }

  return y + 4;
}

function buildPdf() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const doc = new jsPDF('p', 'mm', 'a4');
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('FoodPro Detailed Database Structure', 14, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addWrappedText(
    doc,
    'This document summarizes the current FoodPro database design, including relational tables from server/sql/init.sql and the JSONB-backed operational schema from server/entities.js. It highlights primary keys, important foreign keys, entity uniqueness rules, and project/location scoping behavior.',
    14,
    y,
    182
  );
  y += 8;

  y = addSectionTitle(doc, y, '1. Hybrid Database Architecture');
  y = addBulletList(doc, y, [
    'FoodPro uses a hybrid PostgreSQL model.',
    'Relational tables store authentication, POS integration, procurement, goods receipt, and invoice flows.',
    'entity_records stores many operational modules as JSONB documents with server-side validation, uniqueness rules, and permission enforcement.',
    'The primary relational tables are ideal for multi-table transactional workflows, while entity_records provides flexibility for fast-changing business modules.'
  ]);

  y += 3;
  y = addSectionTitle(doc, y, '2. Relational Table Structure');
  relationalTables.forEach((table) => {
    y = addTableDetail(doc, y, table);
  });

  y = addSectionTitle(doc, y, '3. Relationship Summary');
  y = addBulletList(doc, y, relationshipMap);

  y += 2;
  y = addSectionTitle(doc, y, '4. entity_records Schema Layer');
  y = addBulletList(doc, y, entityBackedModels, ([name, desc]) => `${name}: ${desc}`);

  y += 2;
  y = addSectionTitle(doc, y, '5. Key Uniqueness and Integrity Rules');
  y = addBulletList(doc, y, [
    'Ingredient: unique by name; ingredient_code and sku are also unique when provided.',
    'Recipe: unique by name; recipe_code is unique when provided.',
    'Site: unique by project name; project_code is unique when provided.',
    'User: unique by email.',
    'RoleProfile: unique by role_key and role name.',
    'UserGroup: unique by group name.',
    'Inventory: unique by site_id + ingredient_id, which allows only one current stock record per item per location.'
  ]);

  y += 2;
  y = addSectionTitle(doc, y, '6. Indexes and Performance Notes');
  y = addBulletList(doc, y, keyIndexes);

  y += 2;
  y = addSectionTitle(doc, y, '7. Project / Location Scoping');
  y = addBulletList(doc, y, locationScopingNotes);

  y += 2;
  y = addSectionTitle(doc, y, '8. Practical Reading Guide');
  y = addBulletList(doc, y, [
    'If you need raw auth/session structure, start with users and auth_tokens.',
    'If you need procurement chain tracing, follow purchase_requests -> purchase_request_items -> purchase_orders -> purchase_order_items -> goods_receipts -> goods_receipt_items -> supplier_invoices.',
    'If you need POS chain tracing, follow pos_sources -> pos_sales_orders -> pos_sales_items, with pos_recipe_mapping used during recipe linkage.',
    'If you need operational module data such as Production, MaterialRequest, FoodWaste, Inventory, or Site, read entity_records together with entityRegistry in server/entities.js.',
    'If you need to understand why a user sees or does not see project data, inspect locationScope.js and the fields site_id, allowed_site_ids, and visibility_scope on the User entity.'
  ]);

  doc.save(outputPath);
}

buildPdf();
console.log(outputPath);
