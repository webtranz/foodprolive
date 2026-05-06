import fs from 'fs';
import path from 'path';
import { jsPDF } from 'jspdf';

const outputDir = path.resolve('artifacts');
const outputPath = path.join(outputDir, 'FoodPro_Database_Workflow_Schema.pdf');

const sqlTables = [
  ['users', 'Application users, roles, site assignment, password hash, profile metadata'],
  ['auth_tokens', 'Login session tokens'],
  ['entity_records', 'Hybrid JSONB-backed business entities'],
  ['app_logs', 'Application activity log'],
  ['email_logs', 'Email dispatch log'],
  ['pos_sources', 'POS providers and sync settings'],
  ['pos_sales_orders', 'Imported POS order headers'],
  ['pos_sales_items', 'Imported POS order lines'],
  ['pos_recipe_mapping', 'POS item to recipe mapping'],
  ['pos_sync_logs', 'POS sync execution log'],
  ['suppliers', 'Supplier master'],
  ['purchase_requests', 'Procurement request header'],
  ['purchase_request_items', 'Procurement request lines'],
  ['purchase_orders', 'Purchase order header'],
  ['purchase_order_items', 'Purchase order lines'],
  ['goods_receipts', 'GRN header'],
  ['goods_receipt_items', 'GRN lines with batch and expiry'],
  ['supplier_invoices', 'Supplier invoice header'],
  ['supplier_price_history', 'Historic supplier ingredient prices']
];

const entityModels = [
  ['Site', 'Project and hierarchy master with project_code, parent, company/region/location/kitchen/store structure'],
  ['User', 'Operational user profile, allowed projects, visibility scope, role permissions'],
  ['RoleProfile', 'Custom role and permission profile'],
  ['Ingredient', 'Ingredient master, category, cost, nutrition, allergens, shrinkage'],
  ['Recipe', 'Recipe master, servings, ingredients, nutrition, site scope'],
  ['Inventory', 'Current stock by site and ingredient'],
  ['InventoryLot', 'Batch/lot stock with expiry'],
  ['InventoryTransaction', 'Ledger movement for receipts, issues, adjustments, transfers, production'],
  ['MenuPlan', 'Planned menu by site/date/meal type'],
  ['Production', 'Production request/batch execution record'],
  ['MaterialRequest', 'Linked material request for shortages / procurement handoff'],
  ['FoodWaste', 'Waste posting by ingredient/recipe/batch/location with approval and cost'],
  ['WasteTarget', 'Waste reduction targets by site and month'],
  ['ProductionTransfer', 'Finished goods transfer between locations'],
  ['Supplier', 'Entity-backed supplier records used in some modules'],
  ['PurchaseOrder', 'Entity-backed PO records used by app workflows'],
  ['QualityControl', 'Quality checks and compliance records'],
  ['AttendanceSession', 'Attendance / QR operational session'],
  ['AttendanceRecord', 'Staff attendance detail'],
  ['StaffShift', 'Scheduling and shift plan'],
  ['ForecastScenario', 'Demand forecast scenario definition'],
  ['ForecastSnapshot', 'Generated forecast result snapshot'],
  ['AdvancedReportSchedule', 'Scheduled report email definition'],
  ['ERPIntegrationConfig', 'ERP provider endpoint and mapping settings'],
  ['ERPIntegrationLog', 'ERP export log and retry tracking'],
  ['CustomerMealPlan', 'Nutrition and meal planning records'],
  ['BranchOrder', 'Branch demand/order capture'],
  ['QRCode', 'QR definition records'],
  ['QRDelivery', 'QR delivery records'],
  ['RFQ', 'Request for quotation record']
];

const relationshipNotes = [
  'The platform uses a hybrid schema: PostgreSQL relational tables for auth, POS, and procurement; JSONB entity_records for flexible business modules.',
  'Inventory uniqueness is enforced at business level by site_id + ingredient_id. Inventory lots extend stock with batch_number and expiry_date.',
  'Production links to recipe, site, meal_type, target_servings, ingredients_used, costing, and linked material request lifecycle.',
  'FoodWaste can link to ingredient, recipe, production batch, or location-level waste and stores estimated_cost, approval_status, avoidable_type, and batch_reference.',
  'User visibility is location-scoped using allowed_site_ids and visibility_scope; server-side filtering is applied through locationScope.js.',
  'RoleProfile and system role definitions combine for effective permissions such as create_production_request, approve_waste, acknowledge_material_request, manage_procurement, and manage_erp.'
];

const workflows = [
  {
    title: 'Production Approval + Material Request Workflow',
    steps: [
      'Chef creates production request with recipe, site/project, meal type, servings, and ingredient requirement snapshot.',
      'System generates a linked draft material request from production ingredients.',
      'Chef submits production request for approval.',
      'Project Manager / Operations Manager reviews the request and can approve, reject, or request changes.',
      'When approved, the linked material request is released to procurement with status pending_procurement_ack.',
      'Procurement Officer acknowledges the material request.',
      'After acknowledgement, chef can start production.',
      'On completion, inventory is consumed and production cost is posted.'
    ]
  },
  {
    title: 'Procurement Workflow',
    steps: [
      'Purchase Request is created manually or auto-generated from low stock.',
      'Purchase Request is reviewed and approved according to role permissions.',
      'Approved request is converted to Purchase Order.',
      'Goods Receipt Note is posted on receipt with accepted/rejected quantity, batch number, and expiry date.',
      'Inventory is updated from GRN into stock and inventory lots.',
      'Supplier Invoice is entered and matched to PO / GRN.',
      'Supplier price history is updated for future variance reporting.'
    ]
  },
  {
    title: 'Food Waste Workflow',
    steps: [
      'Waste is posted by ingredient, recipe, batch, or location.',
      'System calculates estimated waste cost from ingredient cost or recipe / batch cost logic.',
      'If waste value exceeds approval threshold, approval_status becomes pending.',
      'Authorized manager/quality approver can approve or reject high-value waste.',
      'Waste data feeds trends, reason analysis, avoidable vs unavoidable analysis, and waste reduction intelligence.',
      'Production planning can display historical waste intelligence by recipe and meal type.'
    ]
  },
  {
    title: 'Inventory Workflow',
    steps: [
      'Inventory enters from GRN/receipts, manual stock addition, or seeded stock.',
      'Lots carry batch_number, expiry_date, valuation, and remaining quantity.',
      'Stock moves through transfers, adjustments, issues, production consumption, and POS deductions.',
      'Reports include stock on hand, movement ledger, expiry, valuation, and velocity.'
    ]
  },
  {
    title: 'Location + Permission Workflow',
    steps: [
      'Hierarchy supports Company -> Region -> Location -> Kitchen -> Store/Warehouse.',
      'Users are assigned to one or more projects/locations through allowed_site_ids.',
      'Server filters records by accessible site scope for non-admin users.',
      'Roles can be system-defined or custom through RoleProfile with granular permissions.'
    ]
  }
];

function addWrappedText(doc, text, x, y, width, lineHeight = 6) {
  const lines = doc.splitTextToSize(text, width);
  doc.text(lines, x, y);
  return y + (lines.length * lineHeight);
}

function ensurePage(doc, y, needed = 18) {
  if (y > 270 - needed) {
    doc.addPage();
    return 18;
  }
  return y;
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
    y = ensurePage(doc, y, 14);
    const line = formatter ? formatter(item, index) : String(item);
    doc.text('-', 16, y);
    y = addWrappedText(doc, line, 21, y, 168);
    y += 2;
  });
  return y;
}

function buildPdf() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const doc = new jsPDF('p', 'mm', 'a4');
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('FoodPro Database Tables, Workflow, and Schema', 14, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addWrappedText(
    doc,
    'Source: generated from the current FoodPro implementation in server/sql/init.sql, server/entities.js, server/index.js, server/locationScope.js, and workflow screens in Production, Material Requests, and Procurement.',
    14,
    y,
    182
  );
  y += 8;

  y = addSectionTitle(doc, y, '1. SQL Tables');
  y = addBulletList(doc, y, sqlTables, ([name, desc]) => `${name}: ${desc}`);

  y += 4;
  y = addSectionTitle(doc, y, '2. Entity-Backed Schema Models');
  y = addBulletList(doc, y, entityModels, ([name, desc]) => `${name}: ${desc}`);

  y += 4;
  y = addSectionTitle(doc, y, '3. Architecture and Relationship Notes');
  y = addBulletList(doc, y, relationshipNotes);

  workflows.forEach((workflow, index) => {
    y += 4;
    y = addSectionTitle(doc, y, `${4 + index}. ${workflow.title}`);
    y = addBulletList(doc, y, workflow.steps, (step, stepIndex) => `${stepIndex + 1}. ${step}`);
  });

  y += 4;
  y = addSectionTitle(doc, y, 'Summary');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addWrappedText(
    doc,
    'FoodPro uses a hybrid database strategy to support rapid module growth while preserving strong workflow control. Auth, POS, and procurement use dedicated relational tables; the main operational modules use entity_records with server-side validation, uniqueness rules, permission enforcement, and location scoping.',
    14,
    y,
    182
  );

  doc.save(outputPath);
}

buildPdf();
console.log(outputPath);
