export const GRANULAR_PAGE_ACCESS_PERMISSION = 'granular_page_access';

export const ROLE_PERMISSION_SECTIONS = [
  {
    key: 'overview',
    title: 'Overview & Projects',
    description: 'Landing dashboards, project hierarchy, and location administration.',
    subsections: [
      { page: 'Dashboard', key: 'access_dashboard', label: 'Dashboard', description: 'Operational overview and headline metrics.' },
      { page: 'Sites', key: 'access_sites', label: 'Projects & Sites', description: 'Companies, projects, kitchens, stores, and location hierarchy.' }
    ],
    capabilities: [
      { key: 'view_dashboard', label: 'View dashboard data' },
      { key: 'manage_projects', label: 'Manage projects and locations' }
    ]
  },
  {
    key: 'food-menu',
    title: 'Food, Recipes & Menu Planning',
    description: 'Master food data, costing, recipes, menus, events, and automated planning.',
    subsections: [
      { page: 'Ingredients', key: 'access_ingredients', label: 'Ingredients', description: 'Ingredient master data and nutritional values.' },
      { page: 'FoodCategories', key: 'access_food_categories', label: 'Food Categories', description: 'Food category master data and access rules.' },
      { page: 'Recipes', key: 'access_recipes', label: 'Recipes', description: 'Recipe composition, preparation, and costing.' },
      { page: 'NutritionAllergen', key: 'access_nutrition_allergen', label: 'Nutrition & Allergens', description: 'Nutrition facts and allergen visibility.' },
      { page: 'AIRecipes', key: 'access_ai_recipes', label: 'AI Recipe Generator', description: 'AI-assisted recipe creation.' },
      { page: 'FoodCost', key: 'access_food_cost', label: 'Food Cost', description: 'Menu and ingredient cost analysis.' },
      { page: 'Menu', key: 'access_menu', label: 'Menu', description: 'Published and working menu views.' },
      { page: 'MenuPlanning', key: 'access_menu_planning', label: 'Menu Planning', description: 'Schedule meals and generate purchase demand.' },
      { page: 'EventPlanning', key: 'access_event_planning', label: 'Event Planning', description: 'Special-event menus, budgets, reviews, and approvals.' },
      { page: 'MenuBuilder', key: 'access_menu_builder', label: 'Menu Builder', description: 'Compose menus from recipes and meal periods.' },
      { page: 'AutoSchedule', key: 'access_auto_schedule', label: 'Auto Schedule', description: 'Automated menu scheduling.' }
    ],
    capabilities: [
      { key: 'view_ingredients', label: 'View ingredient master data' },
      { key: 'manage_ingredients', label: 'Manage ingredients' },
      { key: 'manage_food_categories', label: 'Manage food categories' },
      { key: 'view_recipes', label: 'View recipes' },
      { key: 'manage_recipes', label: 'Manage recipes' },
      { key: 'manage_menu_planning', label: 'Manage menus and menu planning' },
      { key: 'generate_menu_plan_pr', label: 'Generate purchase requests from menu plans' },
      { key: 'create_special_event', label: 'Create special-event requests' },
      { key: 'edit_special_event', label: 'Edit special-event requests' },
      { key: 'submit_special_event', label: 'Submit special-event requests' },
      { key: 'review_special_event', label: 'Review special-event requests' },
      { key: 'approve_special_event', label: 'Approve special-event requests' },
      { key: 'reject_special_event', label: 'Reject special-event requests' }
    ]
  },
  {
    key: 'operations',
    title: 'Production & Inventory Operations',
    description: 'Production lifecycle, stock control, material requests, batches, and transfers.',
    subsections: [
      { page: 'Production', key: 'access_production', label: 'Production', description: 'Production requests, plans, approvals, and execution.' },
      { page: 'Inventory', key: 'access_inventory', label: 'Inventory', description: 'Stock balances, lots, movements, and adjustments.' },
      { page: 'MaterialRequests', key: 'access_material_requests', label: 'Material Requests', description: 'Requests linking production demand to procurement.' },
      { page: 'YieldCost', key: 'access_yield_cost', label: 'Yield & Cost', description: 'Production yield and cost reporting.' },
      { page: 'BatchTracking', key: 'access_batch_tracking', label: 'Batch Tracking', description: 'Production batch traceability.' },
      { page: 'BranchOrders', key: 'access_branch_orders', label: 'Branch Orders', description: 'Branch demand and order fulfillment.' },
      { page: 'ProductionTransfer', key: 'access_production_transfer', label: 'Production Transfer', description: 'Production and inventory transfers between locations.' }
    ],
    capabilities: [
      { key: 'view_inventory', label: 'View inventory' },
      { key: 'manage_inventory', label: 'Manage inventory' },
      { key: 'transfer_inventory', label: 'Transfer inventory' },
      { key: 'manage_production', label: 'Manage production plans' },
      { key: 'create_production_request', label: 'Create production requests' },
      { key: 'edit_production_request', label: 'Edit production requests' },
      { key: 'submit_production_request', label: 'Submit production requests' },
      { key: 'review_production_request', label: 'Review production requests' },
      { key: 'approve_production_request', label: 'Approve production requests' },
      { key: 'reject_production_request', label: 'Reject production requests' },
      { key: 'request_changes_production', label: 'Request production changes' },
      { key: 'approve_production', label: 'Approve production plans' },
      { key: 'request_changes_area_production', label: 'Area review: request production changes' },
      { key: 'reject_area_production', label: 'Area review: reject production' },
      { key: 'adjust_approved_production', label: 'Adjust approved production quantity' },
      { key: 'cancel_production', label: 'Cancel production and return inventory' },
      { key: 'start_production', label: 'Start production' },
      { key: 'complete_production', label: 'Complete production' },
      { key: 'create_material_request', label: 'Create material requests' },
      { key: 'view_material_request', label: 'View material requests' },
      { key: 'acknowledge_material_request', label: 'Acknowledge material requests' }
    ]
  },
  {
    key: 'supply-chain',
    title: 'Supply Chain & Integrations',
    description: 'Procurement, suppliers, forecasting, POS, and ERP connectivity.',
    subsections: [
      { page: 'ProcurementPlanning', key: 'access_procurement_planning', label: 'Procurement Planning', description: 'Demand planning and procurement recommendations.' },
      { page: 'ProcurementModule', key: 'access_procurement', label: 'Procurement', description: 'Requests, purchase orders, receipts, and invoices.' },
      { page: 'SupplierPortal', key: 'access_supplier_portal', label: 'Supplier Portal', description: 'Supplier records and performance.' },
      { page: 'POSIntegration', key: 'access_pos', label: 'POS Integration', description: 'POS sources, mappings, imports, and variance.' },
      { page: 'D365Integration', key: 'access_d365', label: 'D365 / ERP Integration', description: 'Accounting and ERP export configuration.' },
      { page: 'Forecasting', key: 'access_forecasting', label: 'Forecasting', description: 'Demand forecasts and planning scenarios.' }
    ],
    capabilities: [
      { key: 'manage_procurement', label: 'Manage procurement' },
      { key: 'approve_procurement', label: 'Approve procurement' },
      { key: 'manage_suppliers', label: 'Manage suppliers' },
      { key: 'manage_pos', label: 'Manage POS integration' },
      { key: 'manage_erp', label: 'Manage ERP integration' },
      { key: 'manage_forecasting', label: 'Manage forecasting' }
    ]
  },
  {
    key: 'people-access',
    title: 'People, Attendance & Access',
    description: 'Attendance, dining scans, QR operations, users, roles, and record administration.',
    subsections: [
      { page: 'Attendance', key: 'access_attendance', label: 'Attendance', description: 'Attendance sessions, schedules, and approvals.' },
      { page: 'DailyMealCheckin', key: 'access_daily_meal_checkin', label: 'Daily Meal Check-in', description: 'Daily diner and meal check-in.' },
      { page: 'DiningScanner', key: 'access_dining_scanner', label: 'Dining Scanner', description: 'Scan diner QR codes.' },
      { page: 'EventDiningCheckin', key: 'access_event_dining_checkin', label: 'Event Dining Check-in', description: 'Event-specific diner admission.' },
      { page: 'EventInquiry', key: 'access_event_inquiry', label: 'Event Inquiry', description: 'Search and review dining events.' },
      { page: 'QRManagement', key: 'access_qr_management', label: 'QR Management', description: 'Create, distribute, and administer QR codes.' },
      { page: 'UserRoleManagement', key: 'access_user_roles', label: 'Users & Roles', description: 'User accounts, roles, and granular permissions.' }
    ],
    capabilities: [
      { key: 'scan_qr', label: 'Scan QR codes' },
      { key: 'create_session', label: 'Create attendance sessions' },
      { key: 'manage_sessions', label: 'Manage attendance sessions' },
      { key: 'manage_groups', label: 'Manage user groups' },
      { key: 'manage_attendance', label: 'Manage attendance and scheduling' },
      { key: 'approve_attendance', label: 'Approve attendance' },
      { key: 'manage_users', label: 'Manage users' },
      { key: 'manage_roles', label: 'Manage roles and permissions' },
      { key: 'delete_records', label: 'Delete protected records' }
    ]
  },
  {
    key: 'quality-waste',
    title: 'Quality & Food Waste',
    description: 'Food-waste recording, QR capture, AI detection, and quality controls.',
    subsections: [
      { page: 'FoodWaste', key: 'access_food_waste', label: 'Food Waste', description: 'Waste entries, targets, reporting, and approval.' },
      { page: 'FoodWasteQR', key: 'access_food_waste_qr', label: 'Food Waste QR', description: 'QR-based food-waste recording.' },
      { page: 'QualityControl', key: 'access_quality_control', label: 'Quality Control', description: 'Quality inspections and compliance.' }
    ],
    capabilities: [
      { key: 'view_ai_waste', label: 'View AI waste detection' },
      { key: 'camera_detection', label: 'Use camera waste detection' },
      { key: 'manage_waste', label: 'Manage food waste' },
      { key: 'approve_waste', label: 'Approve high-value waste' },
      { key: 'manage_quality', label: 'Manage quality control' }
    ]
  },
  {
    key: 'analytics',
    title: 'Reports, Analytics & Calculators',
    description: 'Standard and advanced reports, cost controls, productivity, and calculators.',
    subsections: [
      { page: 'Reports', key: 'access_reports', label: 'Reports', description: 'Operational reports and dashboards.' },
      { page: 'AdvancedReports', key: 'access_advanced_reports', label: 'Advanced Reports', description: 'Scheduled and configurable reports.' },
      { page: 'CostControl', key: 'access_cost_control', label: 'Cost Control', description: 'Cost performance and variance analysis.' },
      { page: 'ProductivityTracking', key: 'access_productivity_tracking', label: 'Productivity Tracking', description: 'Labor and operational productivity.' },
      { page: 'ProductionCalculator', key: 'access_production_calculator', label: 'Production Calculator', description: 'Production quantity calculations.' },
      { page: 'CaloriesCalculator', key: 'access_calories_calculator', label: 'Calories Calculator', description: 'Calorie and nutrition calculations.' }
    ],
    capabilities: [
      { key: 'view_reports', label: 'View reports' },
      { key: 'export_data', label: 'Export report data' }
    ]
  },
  {
    key: 'utilities',
    title: 'Utilities',
    description: 'Background data imports, reusable templates, and portable report exports.',
    subsections: [
      { page: 'BulkUploadCenter', key: 'access_bulk_upload_center', label: 'Bulk Upload Center', description: 'Administrator-only large CSV uploads through responsive background batches.' },
      { page: 'BulkUploadTemplates', key: 'access_bulk_upload_templates', label: 'Bulk Upload Templates', description: 'Download supported CSV templates for each application module.' },
      { page: 'DataExports', key: 'access_data_exports', label: 'CSV / Excel / PDF Reports', description: 'Preview and export authorized operational data.' }
    ],
    capabilities: [
      { key: 'manage_bulk_uploads', label: 'Manage background bulk uploads (Administrator only)' },
      { key: 'export_data', label: 'Export authorized data' }
    ]
  },
  {
    key: 'activity-logs',
    title: 'Activity Logs',
    description: 'Trace user actions, monitor upload jobs, and inspect report data.',
    subsections: [
      { page: 'AuditLogs', key: 'access_audit_logs', label: 'Audit Logs', description: 'Search security-safe user and data activity records.' },
      { page: 'BulkUploadProgress', key: 'access_bulk_upload_progress', label: 'Bulk Upload Progress', description: 'Monitor queued, processing, completed, and failed upload jobs.' },
      { page: 'ReportsPreview', key: 'access_reports_preview', label: 'Reports Preview', description: 'Inspect authorized report rows before exporting.' }
    ],
    capabilities: [
      { key: 'view_audit_logs', label: 'View audit logs' },
      { key: 'view_bulk_upload_progress', label: 'View bulk upload progress' },
      { key: 'view_reports', label: 'Preview reports' }
    ]
  }
];

export const PAGE_ACCESS_PERMISSION_MAP = Object.fromEntries(
  ROLE_PERMISSION_SECTIONS.flatMap((section) => (
    section.subsections.map((subsection) => [subsection.page, subsection.key])
  ))
);

export const PAGE_ACCESS_PERMISSION_KEYS = Object.values(PAGE_ACCESS_PERMISSION_MAP);

export const ALL_GRANULAR_ROLE_PERMISSION_KEYS = Array.from(new Set([
  GRANULAR_PAGE_ACCESS_PERMISSION,
  ...ROLE_PERMISSION_SECTIONS.flatMap((section) => [
    ...section.subsections.map((subsection) => subsection.key),
    ...section.capabilities.map((capability) => capability.key)
  ])
]));

export function normalizeGranularPermissions(permissions = []) {
  const normalized = Array.from(new Set((permissions || []).filter(Boolean)));
  const withoutMode = normalized.filter((permission) => permission !== GRANULAR_PAGE_ACCESS_PERMISSION);

  return [GRANULAR_PAGE_ACCESS_PERMISSION, ...withoutMode];
}
