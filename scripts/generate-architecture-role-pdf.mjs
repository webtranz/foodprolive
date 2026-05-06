import fs from 'fs';
import path from 'path';
import { jsPDF } from 'jspdf';

const outputDir = path.resolve('artifacts');
const outputPath = path.join(outputDir, 'FoodPro_Architecture_Workflow_Roles.pdf');

const relationshipBlocks = [
  {
    title: 'Core Master Data',
    lines: [
      'Site (Project) -> User, Inventory, Production, MaterialRequest, FoodWaste, PurchaseRequest, PurchaseOrder',
      'Ingredient -> Recipe.ingredients, Inventory, InventoryLot, InventoryTransaction, PurchaseRequestItem, PurchaseOrderItem, GoodsReceiptItem, SupplierPriceHistory, FoodWaste',
      'Recipe -> Production, MenuPlan, POS Recipe Mapping, FoodWaste'
    ]
  },
  {
    title: 'Production and Material Flow',
    lines: [
      'Production -> MaterialRequest via source_production_id',
      'Production -> InventoryTransaction on start/complete consumption posting',
      'Production -> FoodWaste via production_id and recipe_id',
      'MaterialRequest -> Procurement acknowledgement -> unlocks production start'
    ]
  },
  {
    title: 'Procurement Flow',
    lines: [
      'PurchaseRequest -> PurchaseRequestItems',
      'PurchaseRequest -> PurchaseOrder -> PurchaseOrderItems',
      'PurchaseOrder -> GoodsReceipt -> GoodsReceiptItems',
      'PurchaseOrder / GoodsReceipt -> SupplierInvoice',
      'PurchaseOrderItem -> SupplierPriceHistory'
    ]
  },
  {
    title: 'POS and Forecasting',
    lines: [
      'POS Source -> POS Sales Orders -> POS Sales Items',
      'POS Recipe Mapping links POS items to FoodPro Recipe',
      'POS sales + Production + MenuPlan + Waste -> ForecastScenario / ForecastSnapshot analytics'
    ]
  }
];

const workflows = [
  {
    title: 'End-to-End Production Workflow',
    steps: [
      'Chef creates production request.',
      'System snapshots required ingredients and creates linked draft material request.',
      'Chef submits production request for approval.',
      'Project Manager / Operations Manager reviews, approves, rejects, or requests changes.',
      'If approved, material request status changes to pending procurement acknowledgement.',
      'Procurement Officer acknowledges the material request.',
      'Chef starts production after procurement acknowledgement.',
      'Chef completes production and inventory/cost posting is performed.'
    ]
  },
  {
    title: 'Food Waste and Cost Intelligence Workflow',
    steps: [
      'Waste is posted by ingredient, recipe, batch, or location.',
      'Estimated waste cost is calculated from ingredient or production costing.',
      'High-value waste requires approval.',
      'Historical waste is used to drive recipe-level reduction guidance in production planning.',
      'Food cost reporting aggregates production cost by date, location, meal type, and recipe.'
    ]
  },
  {
    title: 'Location and Visibility Workflow',
    steps: [
      'Company -> Region -> Location -> Kitchen -> Store/Warehouse hierarchy is maintained in Site.',
      'Users are assigned by site_id and allowed_site_ids.',
      'visibility_scope controls whether a user sees assigned locations only or subtree scope.',
      'Server-side locationScope filtering prevents access to non-assigned project data.'
    ]
  }
];

const roleMatrix = [
  ['Permission / Action', 'Chef', 'Project Manager', 'Storekeeper', 'Procurement Officer', 'Admin'],
  ['Create Production Request', 'Yes', 'Optional', 'No', 'No', 'Yes'],
  ['Edit Draft Production Request', 'Yes', 'No', 'No', 'No', 'Yes'],
  ['Submit Production Request', 'Yes', 'No', 'No', 'No', 'Yes'],
  ['Review Production Request', 'No', 'Yes', 'No', 'No', 'Yes'],
  ['Approve / Reject / Request Changes', 'No', 'Yes', 'No', 'No', 'Yes'],
  ['Create Material Request', 'Yes', 'No', 'No', 'No', 'Yes'],
  ['Acknowledge Material Request', 'No', 'No', 'No', 'Yes', 'Yes'],
  ['Start Production', 'Yes, after MR ack', 'Optional', 'No', 'No', 'Yes'],
  ['Complete Production', 'Yes', 'Optional', 'No', 'No', 'Yes'],
  ['Post Food Waste', 'Yes', 'Yes', 'Optional', 'No', 'Yes'],
  ['Approve High-Value Waste', 'Role-configurable', 'Yes', 'No', 'No', 'Yes'],
  ['Manage Inventory / Transfer', 'Optional', 'Yes', 'Yes', 'No', 'Yes'],
  ['Manage Procurement / Suppliers', 'No', 'Optional', 'No', 'Yes', 'Yes'],
  ['Manage Users / Roles', 'No', 'No', 'No', 'No', 'Yes']
];

const systemRoles = [
  ['Administrator', 'Full system access across all modules and locations'],
  ['Operations Manager', 'Cross-functional control of projects, inventory, production, procurement, waste, reports'],
  ['Project Manager', 'Project-level production review, approval, waste approval, material request visibility'],
  ['Chef', 'Production creation, recipe/menu control, material request creation, production start/complete, waste posting'],
  ['Storekeeper', 'Inventory and transfer operations'],
  ['Procurement Officer', 'Procurement execution, supplier handling, MR acknowledgement'],
  ['Production Supervisor', 'Production execution and control'],
  ['Quality Controller', 'Quality and waste compliance'],
  ['Finance Controller', 'ERP, exports, reporting, forecasting visibility'],
  ['Custom Role', 'RoleProfile-based permission set configured in User & Role Management']
];

function ensurePage(doc, y, needed = 16) {
  if (y > 275 - needed) {
    doc.addPage();
    return 18;
  }
  return y;
}

function addWrapped(doc, text, x, y, width, lineHeight = 5) {
  const lines = doc.splitTextToSize(text, width);
  doc.text(lines, x, y);
  return y + lines.length * lineHeight;
}

function addTitle(doc, y, text) {
  y = ensurePage(doc, y, 12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(text, 14, y);
  return y + 7;
}

function addBullets(doc, y, items) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  items.forEach((item) => {
    y = ensurePage(doc, y, 12);
    doc.text('-', 16, y);
    y = addWrapped(doc, item, 21, y, 168);
    y += 2;
  });
  return y;
}

function drawSimpleTable(doc, y, rows, colWidths) {
  const pageWidth = 190;
  const startX = 10;
  const rowHeight = 7;
  rows.forEach((row, rowIndex) => {
    y = ensurePage(doc, y, rowHeight + 6);
    let x = startX;
    row.forEach((cell, index) => {
      const width = colWidths[index];
      doc.rect(x, y - 5, width, rowHeight);
      doc.setFont('helvetica', rowIndex === 0 ? 'bold' : 'normal');
      doc.setFontSize(8);
      const text = doc.splitTextToSize(String(cell), width - 2).slice(0, 3);
      doc.text(text, x + 1, y - 1);
      x += width;
    });
    y += rowHeight;
  });
  return y + 3;
}

function buildPdf() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const doc = new jsPDF('p', 'mm', 'a4');
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('FoodPro Architecture, Workflow, and Roles', 14, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addWrapped(
    doc,
    'This reference summarizes the implemented architecture relationships, operational process flows, and built-in role/permission model used by the current FoodPro deployment.',
    14,
    y,
    182
  );
  y += 6;

  y = addTitle(doc, y, '1. ER-Style Relationship Overview');
  relationshipBlocks.forEach((block) => {
    y = ensurePage(doc, y, 14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(block.title, 16, y);
    y += 5;
    y = addBullets(doc, y, block.lines);
  });

  y += 2;
  y = addTitle(doc, y, '2. Module Workflow Overview');
  workflows.forEach((workflow) => {
    y = ensurePage(doc, y, 14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(workflow.title, 16, y);
    y += 5;
    y = addBullets(doc, y, workflow.steps.map((step, index) => `${index + 1}. ${step}`));
  });

  y += 2;
  y = addTitle(doc, y, '3. System Role Catalog');
  y = addBullets(doc, y, systemRoles.map(([name, desc]) => `${name}: ${desc}`));

  y += 2;
  y = addTitle(doc, y, '4. Role-Permission Matrix');
  y = drawSimpleTable(doc, y, roleMatrix, [48, 24, 34, 28, 32, 20]);

  y += 2;
  y = addTitle(doc, y, '5. Key Design Notes');
  y = addBullets(doc, y, [
    'Relational tables are used for auth, procurement, and POS integration; entity_records provides extensible JSON-backed models for many operational modules.',
    'Server-side location scoping protects project-level visibility and prevents users from seeing unassigned project names and data.',
    'Custom roles are supported through RoleProfile while still inheriting the core access_level model of admin / manager / user.',
    'Production and material request approval flow is enforced by permission checks and workflow status transitions in the backend.'
  ]);

  doc.save(outputPath);
}

buildPdf();
console.log(outputPath);
