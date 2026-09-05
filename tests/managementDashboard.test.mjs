import assert from 'node:assert/strict';
import {
  buildManagementDashboardSnapshot,
  computeAttendanceStats,
  computeQualityScore,
  computeSupplierStats,
  dailyBudgetAmount,
  deriveInventoryStatus,
  producedServings,
  productionCost
} from '../shared/managementDashboard.js';

const sites = [
  { id: 'company', name: 'FoodPro', type: 'company' },
  { id: 'west', name: 'Western Region', type: 'region', parent_site_id: 'company' },
  { id: 'project-a', name: 'Jeddah Project', type: 'location', parent_site_id: 'west', manager_name: 'Jeddah PM' },
  { id: 'kitchen-a', name: 'Jeddah Kitchen', type: 'kitchen', parent_site_id: 'project-a' },
  { id: 'project-b', name: 'Makkah Site', type: 'camp', parent_site_id: 'west' }
];

const input = {
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  production: [
    {
      id: 'prod-a-breakfast', site_id: 'kitchen-a', production_date: '2026-08-19',
      meal_type: 'breakfast', status: 'completed', target_servings: 100,
      actual_servings: 95, production_cost_total: 950
    },
    {
      id: 'prod-a-lunch', site_id: 'kitchen-a', production_date: '2026-08-19',
      meal_type: 'lunch', status: 'pending_approval', target_servings: 50,
      estimated_batch_cost: 500
    },
    {
      id: 'prod-b', site_id: 'project-b', production_date: '2026-08-19',
      meal_type: 'dinner', status: 'completed', target_servings: 200,
      actual_servings: 200, production_cost_total: 2400
    },
    {
      id: 'prod-a-old', site_id: 'kitchen-a', production_date: '2026-08-18',
      meal_type: 'breakfast', status: 'completed', target_servings: 80,
      actual_servings: 80, production_cost_total: 720
    }
  ],
  foodWaste: [
    {
      id: 'waste-a', site_id: 'kitchen-a', waste_date: '2026-08-19', meal_type: 'breakfast',
      estimated_cost: 50, approval_status: 'pending'
    },
    { id: 'waste-b', site_id: 'project-b', waste_date: '2026-08-19', estimated_cost: 700, approval_status: 'pending' }
  ],
  inventory: [
    { id: 'cheese', site_id: 'kitchen-a', quantity: 16, min_stock_level: 10, status: 'low_stock' },
    { id: 'rice', site_id: 'kitchen-a', quantity: 5, min_stock_level: 10, status: 'in_stock' },
    { id: 'oil-b', site_id: 'project-b', quantity: 0, min_stock_level: 10 }
  ],
  budgets: [
    {
      id: 'budget-a', site_id: 'project-a', budget_date: '2026-08-19',
      budget_amount: 1000, scope_type: 'daily', status: 'active'
    },
    {
      id: 'budget-b', site_id: 'project-b', budget_date: '2026-08-19',
      budget_amount: 2000, scope_type: 'daily', status: 'active'
    }
  ],
  menuPlans: [
    {
      id: 'menu-a', site_id: 'project-a', plan_date: '2026-08-19',
      meals: [
        { meal_type: 'breakfast', recipe_id: 'r1', expected_servings: 100 },
        { meal_type: 'lunch', recipe_id: 'r2', expected_servings: 50 },
        { meal_type: 'dinner', recipe_id: 'r3', expected_servings: 75 }
      ]
    }
  ],
  materialRequests: [],
  purchaseRequests: [
    { id: 'pr-a', site_id: 'project-a', status: 'pending' },
    { id: 'pr-b', site_id: 'project-b', status: 'pending' }
  ],
  purchaseOrders: [
    {
      id: 'po-a-delivered', site_id: 'project-a', status: 'received',
      expected_delivery_date: '2026-08-18'
    },
    {
      id: 'po-a-late', site_id: 'project-a', status: 'approved',
      expected_delivery_date: '2026-08-18'
    },
    {
      id: 'po-b', site_id: 'project-b', status: 'approved',
      expected_delivery_date: '2026-08-18'
    }
  ],
  goodsReceipts: [
    { id: 'grn-a', site_id: 'project-a', purchase_order_id: 'po-a-delivered', receipt_date: '2026-08-18' }
  ],
  staffShifts: [
    { id: 'shift-a-1', site_id: 'project-a', shift_date: '2026-08-19', status: 'scheduled' },
    { id: 'shift-a-2', site_id: 'project-a', shift_date: '2026-08-19', status: 'scheduled' },
    { id: 'shift-b', site_id: 'project-b', shift_date: '2026-08-19', status: 'scheduled' }
  ],
  attendanceRecords: [
    { id: 'attendance-a', shift_id: 'shift-a-1', site_id: 'project-a', shift_date: '2026-08-19', attendance_status: 'present', check_in_at: '2026-08-19T05:00:00+03:00' },
    { id: 'attendance-b', shift_id: 'shift-b', site_id: 'project-b', shift_date: '2026-08-19', attendance_status: 'present' }
  ],
  qualityControls: [
    { id: 'qc-a-pass', site_id: 'project-a', inspection_date: '2026-08-19', overall_status: 'approved' },
    { id: 'qc-a-fail', site_id: 'project-a', inspection_date: '2026-08-19', overall_status: 'rejected' },
    { id: 'qc-b-pass', site_id: 'project-b', inspection_date: '2026-08-19', overall_status: 'approved' }
  ]
};

const project = buildManagementDashboardSnapshot(input);

assert.equal(project.scope.selected_site_id, 'project-a');
assert.equal(project.scope.selected_site_name, 'Jeddah Project');
assert.equal(project.metrics.total_meals, 95);
assert.equal(project.metrics.daily_spent, 950);
assert.equal(project.metrics.cost_per_meal, 10);
assert.equal(project.metrics.daily_budget, 1000);
assert.equal(project.metrics.food_wastage_cost, 50);
assert.equal(project.metrics.waste_percent, 5.3);
assert.equal(project.metrics.stock_risk, 1);
assert.equal(project.metrics.menu_plan_completion, 100);
assert.equal(project.metrics.supplier_sla, 100);
assert.equal(project.metrics.supplier_exceptions, 1);
assert.equal(project.metrics.attendance, 50);
assert.equal(project.metrics.attendance_gaps, 1);
assert.equal(project.metrics.quality_score, 50);
assert.equal(project.metrics.approvals.procurement, 1);
assert.equal(project.metrics.approvals.production, 1);
assert.equal(project.metrics.approvals.waste, 1);
assert.equal(project.metrics.pending_approvals, 3);

assert.deepEqual(project.locations.map((row) => row.id), ['project-a']);
assert.equal(project.locations[0].name, 'Jeddah Project');
assert.equal(project.locations[0].meals, 95);
assert.equal(project.meals.find((row) => row.meal_type === 'breakfast').planned, 100);
assert.equal(project.meals.find((row) => row.meal_type === 'breakfast').produced, 95);
assert.equal(project.meals.find((row) => row.meal_type === 'lunch').planned, 50);
assert.equal(project.meals.find((row) => row.meal_type === 'lunch').produced, 0);
assert.equal(project.actions.length, 4);
assert.equal(project.actions.find((action) => action.key === 'inventory').count, 1);
assert.equal(project.trends.length, 7);
assert.equal(project.trends.at(-1).date, '2026-08-19');
assert.equal(project.trends.at(-1).produced, 95);
assert.equal(project.trends.at(-2).produced, 80);
assert.equal(project.data_quality.length, 0);

const allLocations = buildManagementDashboardSnapshot({
  ...input,
  view: 'gm',
  selectedSiteId: null
});
assert.equal(allLocations.metrics.total_meals, 295);
assert.equal(allLocations.metrics.daily_budget, 3000);
assert.equal(allLocations.metrics.stock_risk, 2);
assert.equal(allLocations.locations.length, 2);
assert.equal(allLocations.actions.find((action) => action.key === 'procurement').count, 2);

assert.equal(deriveInventoryStatus({ quantity: 16, min_stock_level: 10, status: 'low_stock' }), 'in_stock');
assert.equal(deriveInventoryStatus({ quantity: 10, min_stock_level: 10 }), 'low_stock');
assert.equal(deriveInventoryStatus({ quantity: 0, min_stock_level: 0 }), 'out_of_stock');
assert.equal(producedServings({ status: 'completed', actual_servings: null, target_servings: 12 }), 12);
assert.equal(
  producedServings({ status: 'completed', produced_servings: 9.5, actual_servings: 12, target_servings: 12 }),
  9.5,
  'yield-derived finished servings take precedence over legacy or planned serving counts'
);
assert.equal(productionCost({
  production_cost_total: null,
  ingredients_used: [{ planned_quantity: 4, unit_cost: 2.5 }]
}), 10);

assert.equal(dailyBudgetAmount({ budget_amount: 3100, start_date: '2026-08-01', end_date: '2026-08-31' }, '2026-08-19'), 100);
assert.deepEqual(computeAttendanceStats([], []), { attendance: null, attendance_gaps: 0 });

const approvalQueue = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  production: [
    { id: 'production-open-old', site_id: 'project-a', production_date: '2026-08-10', status: 'pending_approval' },
    { id: 'production-draft', site_id: 'project-a', production_date: '2026-08-19', status: 'draft' }
  ],
  foodWaste: [
    { id: 'waste-open-old', site_id: 'project-a', waste_date: '2026-08-10', approval_status: 'under_review' },
    { id: 'waste-draft', site_id: 'project-a', waste_date: '2026-08-19', approval_status: 'draft', estimated_cost: 1000 }
  ],
  attendanceRecords: [
    { id: 'attendance-open-old', site_id: 'project-a', shift_date: '2026-08-10', approval_status: 'pending' },
    { id: 'attendance-draft', site_id: 'project-a', shift_date: '2026-08-19', approval_status: 'draft' }
  ],
  menuPlans: [
    { id: 'event-open-old', site_id: 'project-a', event_date: '2026-08-10', event_name: 'Old event', status: 'submitted' },
    { id: 'event-draft', site_id: 'project-a', event_date: '2026-08-19', event_name: 'Draft event', status: 'draft' }
  ],
  purchaseRequests: [
    { id: 'pr-open-old', site_id: 'project-a', request_date: '2026-08-10', status: 'awaiting_approval' },
    { id: 'pr-draft', site_id: 'project-a', request_date: '2026-08-19', status: 'draft' }
  ]
});

assert.deepEqual(approvalQueue.metrics.approvals, {
  production: 1,
  waste: 1,
  attendance: 1,
  events: 1,
  procurement: 1,
  total: 5
});
assert.equal(approvalQueue.metrics.pending_approvals, 5);
assert.equal(approvalQueue.actions.find((action) => action.key === 'production').count, 1);
assert.equal(approvalQueue.actions.find((action) => action.key === 'waste').count, 1);
assert.equal(approvalQueue.actions.find((action) => action.key === 'procurement').count, 1);

const manualMealBudget = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  menuPlans: [{
    id: 'manual-menu',
    site_id: 'project-a',
    plan_date: '2026-08-19',
    budget_source: 'manual',
    budget_amount: 1200,
    meal_budget_limits: { breakfast: 300, lunch: 450 },
    meals: []
  }, {
    id: 'manual-menu',
    site_id: 'project-a',
    plan_date: '2026-08-19',
    budget_source: 'manual',
    budget_amount: 1200,
    meal_budget_limits: { breakfast: 300, lunch: 450 },
    meals: []
  }]
});
assert.equal(manualMealBudget.metrics.daily_budget, 1200);
assert.deepEqual(
  manualMealBudget.meals.map((meal) => [meal.meal_type, meal.budget]),
  [['breakfast', 300], ['lunch', 450], ['dinner', 450]]
);
assert.equal(manualMealBudget.meals.reduce((sum, meal) => sum + meal.budget, 0), manualMealBudget.metrics.daily_budget);

const samePlanIdAcrossSites = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites: [
    ...sites,
    { id: 'kitchen-a-2', name: 'Jeddah Prep Kitchen', type: 'kitchen', parent_site_id: 'project-a' }
  ],
  menuPlans: [
    { id: 'daily-plan', site_id: 'kitchen-a', plan_date: '2026-08-19', budget_source: 'manual', budget_amount: 100 },
    { id: 'daily-plan', site_id: 'kitchen-a-2', plan_date: '2026-08-19', budget_source: 'manual', budget_amount: 200 }
  ]
});
assert.equal(samePlanIdAcrossSites.metrics.daily_budget, 300);

const scopedMealBudget = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  budgets: [
    { id: 'breakfast-budget', site_id: 'project-a', budget_date: '2026-08-19', meal_type: 'breakfast', budget_amount: 500 },
    { id: 'lunch-budget', site_id: 'project-a', budget_date: '2026-08-19', meal_type: 'lunch', budget_amount: 700 },
    { id: 'all-meal-budget', site_id: 'project-a', budget_date: '2026-08-19', meal_type: 'all', budget_amount: 1800 }
  ]
});
assert.deepEqual(
  scopedMealBudget.meals.map((meal) => [meal.meal_type, meal.budget]),
  [['breakfast', 500], ['lunch', 700], ['dinner', 600]]
);
assert.equal(scopedMealBudget.metrics.daily_budget, 1800);

const allMealBudget = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  budgets: [
    { id: 'all-only', site_id: 'project-a', budget_date: '2026-08-19', meal_type: 'all', budget_amount: 900 }
  ]
});
assert.deepEqual(
  allMealBudget.meals.map((meal) => [meal.meal_type, meal.budget]),
  [['breakfast', 300], ['lunch', 300], ['dinner', 300]]
);

const areaPlanningBudgetRollup = buildManagementDashboardSnapshot({
  view: 'gm',
  date: '2026-08-19',
  selectedSiteId: 'west',
  sites,
  budgets: [
    {
      id: 'area-planning-budget',
      site_id: 'west',
      budget_date: '2026-08-19',
      source_module: 'budget_planning',
      budget_level: 'area',
      budget_amount: 3000,
      scope_type: 'area_daily_total',
      meal_type: 'all',
      status: 'active'
    },
    {
      id: 'project-a-planning-budget',
      site_id: 'project-a',
      budget_date: '2026-08-19',
      source_module: 'budget_planning',
      budget_level: 'project',
      budget_amount: 1000,
      scope_type: 'project_daily_total',
      meal_type: 'all',
      status: 'active'
    },
    {
      id: 'project-b-planning-budget',
      site_id: 'project-b',
      budget_date: '2026-08-19',
      source_module: 'budget_planning',
      budget_level: 'project',
      budget_amount: 2000,
      scope_type: 'project_daily_total',
      meal_type: 'all',
      status: 'active'
    }
  ]
});
assert.equal(
  areaPlanningBudgetRollup.metrics.daily_budget,
  3000,
  'area dashboard reporting uses the area planning budget without double-counting child project planning budgets'
);

const projectPlanningBudgetSnapshot = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  budgets: [
    {
      id: 'area-planning-budget',
      site_id: 'west',
      budget_date: '2026-08-19',
      source_module: 'budget_planning',
      budget_level: 'area',
      budget_amount: 3000,
      scope_type: 'area_daily_total',
      meal_type: 'all',
      status: 'active'
    },
    {
      id: 'project-a-planning-budget',
      site_id: 'project-a',
      budget_date: '2026-08-19',
      source_module: 'budget_planning',
      budget_level: 'project',
      budget_amount: 1000,
      scope_type: 'project_daily_total',
      meal_type: 'all',
      status: 'active'
    }
  ]
});
assert.equal(
  projectPlanningBudgetSnapshot.metrics.daily_budget,
  1000,
  'project dashboard reporting remains scoped to the selected project budget'
);

const childSiteCompletion = buildManagementDashboardSnapshot({
  view: 'project_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites: [
    ...sites,
    { id: 'kitchen-a-2', name: 'Jeddah Prep Kitchen', type: 'kitchen', parent_site_id: 'project-a' }
  ],
  menuPlans: [
    {
      id: 'kitchen-menu-1', site_id: 'kitchen-a', plan_date: '2026-08-19',
      meals: [
        { meal_type: 'breakfast', recipe_id: 'r1', expected_servings: 20 },
        { meal_type: 'lunch', recipe_id: 'r2', expected_servings: 20 }
      ]
    },
    {
      id: 'kitchen-menu-2', site_id: 'kitchen-a-2', plan_date: '2026-08-19',
      meals: [
        { meal_type: 'breakfast', recipe_id: 'r3', expected_servings: 20 },
        { meal_type: 'lunch', recipe_id: 'r4', expected_servings: 20 }
      ]
    }
  ]
});
assert.equal(childSiteCompletion.metrics.menu_plan_completion, 66.7);

assert.equal(computeQualityScore([
  { overall_status: 'approved', quality_score: 92 },
  { overall_status: 'rejected', compliance_score: 88 },
  { overall_status: 'pending', quality_score: 100 }
]), 90);
assert.equal(computeQualityScore([
  { overall_status: 'approved' },
  { overall_status: 'rejected' }
]), 50);

assert.deepEqual(computeSupplierStats([
  { id: 'completed-late', status: 'received', expected_delivery_date: '2026-08-18' },
  { id: 'due-today', status: 'approved', expected_delivery_date: '2026-08-19' },
  { id: 'partial-overdue', status: 'partially_received', expected_delivery_date: '2026-08-18' }
], [
  { id: 'completed-partial', purchase_order_id: 'completed-late', receipt_date: '2026-08-17' },
  { id: 'completed-final', purchase_order_id: 'completed-late', receipt_date: '2026-08-19' },
  { id: 'partial-receipt', purchase_order_id: 'partial-overdue', receipt_date: '2026-08-17' }
], '2026-08-19'), {
  supplier_sla: 0,
  supplier_exceptions: 2
});
assert.deepEqual(computeSupplierStats([
  { id: 'only-due-today', status: 'approved', expected_delivery_date: '2026-08-19' }
], [], '2026-08-19'), {
  supplier_sla: null,
  supplier_exceptions: 0
});
assert.deepEqual(computeSupplierStats([
  { id: 'final-receipt-order', status: 'received', expected_delivery_date: '2026-08-18' }
], [
  { id: 'early-partial', purchase_order_id: 'final-receipt-order', receipt_date: '2026-08-17' },
  { id: 'late-final', purchase_order_id: 'final-receipt-order', receipt_date: '2026-08-19' }
], '2026-08-19'), {
  supplier_sla: 0,
  supplier_exceptions: 1
});

const thresholdWasteAction = buildManagementDashboardSnapshot({
  view: 'area_manager',
  date: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  foodWaste: [
    { id: 'pending-zero', site_id: 'project-a', waste_date: '2026-08-19', approval_status: 'pending', estimated_cost: 0 },
    { id: 'pending-small', site_id: 'project-a', waste_date: '2026-08-19', approval_status: 'pending', estimated_cost: 499.99 },
    { id: 'threshold-waste', site_id: 'project-a', waste_date: '2026-08-19', approval_status: 'approved', estimated_cost: 500 }
  ]
});
assert.equal(thresholdWasteAction.actions.find((action) => action.key === 'high_waste').count, 1);

console.log('Management dashboard analytics tests passed.');
