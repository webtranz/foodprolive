import assert from 'node:assert/strict';

import { managementDashboardInternals } from '../server/managementDashboard.js';
import { buildManagementDashboardSnapshot, shiftDate } from '../shared/managementDashboard.js';

const { normalizeOpenStatus, resolveDateSelection, snapshotCacheKey } = managementDashboardInternals;

assert.equal(normalizeOpenStatus(' Pending-Approval '), 'pending_approval');
assert.equal(normalizeOpenStatus('AWAITING APPROVAL'), 'awaiting_approval');

assert.deepEqual(resolveDateSelection({
  start_date: '2026-08-18',
  end_date: '2026-08-19'
}), {
  date: '2026-08-19',
  rangeStart: '2026-08-18',
  rangeEnd: '2026-08-19',
  aggregateRange: true
});
assert.deepEqual(resolveDateSelection({ date: '2026-08-19' }), {
  date: '2026-08-19',
  rangeStart: '2026-08-13',
  rangeEnd: '2026-08-19',
  aggregateRange: false
});
assert.throws(
  () => resolveDateSelection({ start_date: '2026-08-18' }),
  (error) => error.status === 400 && /provided together/i.test(error.message)
);
assert.throws(
  () => resolveDateSelection({ start_date: '2026-08-20', end_date: '2026-08-19' }),
  (error) => error.status === 400 && /on or before/i.test(error.message)
);
assert.throws(
  () => resolveDateSelection({ start_date: '2026-02-30', end_date: '2026-03-01' }),
  (error) => error.status === 400 && /valid calendar date/i.test(error.message)
);
assert.throws(
  () => resolveDateSelection({ start_date: '2025-01-01', end_date: '2026-01-02' }),
  (error) => error.status === 400 && /cannot exceed 366 days/i.test(error.message)
);
assert.equal(shiftDate('0001-01-01', 1), '0001-01-02');

const cacheScope = {
  view: 'gm',
  date: '2026-08-19',
  aggregateRange: true,
  selectedSiteId: null,
  accessibleSiteIds: new Set(['project-a'])
};
assert.notEqual(
  snapshotCacheKey({ ...cacheScope, rangeStart: '2026-08-18', rangeEnd: '2026-08-19' }),
  snapshotCacheKey({ ...cacheScope, rangeStart: '2026-08-17', rangeEnd: '2026-08-19' })
);

const sites = [
  { id: 'area', name: 'Western Area', type: 'area' },
  { id: 'project-a', name: 'Jeddah Project', type: 'location', parent_site_id: 'area' },
  { id: 'kitchen-a', name: 'Main Kitchen', type: 'kitchen', parent_site_id: 'project-a' }
];

const rangeInput = {
  startDate: '2026-08-18',
  endDate: '2026-08-19',
  selectedSiteId: 'project-a',
  sites,
  production: [
    {
      id: 'start-production', site_id: 'kitchen-a', planned_date: '2026-08-18',
      meal_type: 'breakfast', status: 'completed', target_servings: 80,
      actual_servings: 80, production_cost_total: 720
    },
    {
      id: 'end-production', site_id: 'kitchen-a', production_date: '2026-08-19',
      meal_type: 'lunch', status: 'completed', target_servings: 100,
      actual_servings: 95, production_cost_total: 950
    },
    {
      id: 'outside-production', site_id: 'kitchen-a', production_date: '2026-08-17',
      meal_type: 'dinner', status: 'completed', target_servings: 1000,
      actual_servings: 1000, production_cost_total: 1000
    },
    {
      id: 'open-production', site_id: 'kitchen-a', production_date: '2026-07-01',
      meal_type: 'dinner', status: 'Pending Approval', target_servings: 500
    }
  ],
  foodWaste: [
    { id: 'start-waste', site_id: 'kitchen-a', served_at: '2026-08-18T12:00:00Z', estimated_cost: 30, approval_status: 'approved' },
    { id: 'end-waste', site_id: 'kitchen-a', created_date: '2026-08-19', estimated_cost: 50, approval_status: 'approved' },
    { id: 'open-waste', site_id: 'kitchen-a', waste_date: '2026-07-01', estimated_cost: 900, approval_status: 'pending' }
  ],
  inventory: [
    { id: 'current-shortage', site_id: 'kitchen-a', quantity: 5, min_stock_level: 10 }
  ],
  budgets: [
    { id: 'start-budget', site_id: 'project-a', budget_date: '2026-08-18', budget_amount: 100, scope_type: 'daily' },
    { id: 'end-budget', site_id: 'project-a', budget_date: '2026-08-19', budget_amount: 200, scope_type: 'daily' }
  ],
  menuPlans: [
    {
      id: 'start-menu', site_id: 'project-a', plan_date: '2026-08-18',
      meals: [
        { meal_type: 'breakfast', recipe_id: 'r1', expected_servings: 80 },
        { meal_type: 'lunch', recipe_id: 'r2', expected_servings: 80 },
        { meal_type: 'dinner', recipe_id: 'r3', expected_servings: 80 }
      ]
    },
    {
      id: 'end-menu', site_id: 'project-a', plan_date: '2026-08-19',
      meals: [{ meal_type: 'lunch', recipe_id: 'r4', expected_servings: 100 }]
    }
  ],
  staffShifts: [
    { id: 'start-shift', site_id: 'project-a', created_date: '2026-08-18', status: 'scheduled' },
    { id: 'end-shift', site_id: 'project-a', created_date: '2026-08-19', status: 'scheduled' }
  ],
  attendanceRecords: [
    { id: 'start-attendance', shift_id: 'start-shift', site_id: 'project-a', marked_at: '2026-08-18T05:00:00Z', attendance_status: 'present' }
  ],
  qualityControls: [
    { id: 'start-quality', site_id: 'project-a', created_date: '2026-08-18', overall_status: 'approved' },
    { id: 'end-quality', site_id: 'project-a', created_date: '2026-08-19', overall_status: 'rejected' }
  ],
  purchaseRequests: [
    { id: 'open-pr', site_id: 'project-a', request_date: '2026-07-01', status: 'Awaiting-Approval' }
  ]
};

for (const view of ['gm', 'agm', 'area_manager', 'project_manager']) {
  const snapshot = buildManagementDashboardSnapshot({ ...rangeInput, view });
  assert.equal(snapshot.date, '2026-08-19');
  assert.equal(snapshot.range_start, '2026-08-18');
  assert.equal(snapshot.range_end, '2026-08-19');
  assert.deepEqual(snapshot.trends.map((row) => row.date), ['2026-08-18', '2026-08-19']);
}

const rangeSnapshot = buildManagementDashboardSnapshot({ ...rangeInput, view: 'project_manager' });
assert.equal(rangeSnapshot.metrics.total_meals, 175);
assert.equal(rangeSnapshot.metrics.daily_spent, 1670);
assert.equal(rangeSnapshot.metrics.cost_per_meal, 9.54);
assert.equal(rangeSnapshot.metrics.daily_budget, 300);
assert.equal(rangeSnapshot.metrics.food_wastage_cost, 80);
assert.equal(rangeSnapshot.metrics.waste_percent, 4.8);
assert.equal(rangeSnapshot.metrics.stock_risk, 1);
assert.equal(rangeSnapshot.metrics.menu_plan_completion, 66.7);
assert.equal(rangeSnapshot.metrics.attendance, 50);
assert.equal(rangeSnapshot.metrics.attendance_gaps, 1);
assert.equal(rangeSnapshot.metrics.quality_score, 50);
assert.deepEqual(rangeSnapshot.metrics.approvals, {
  production: 1,
  waste: 1,
  attendance: 0,
  events: 0,
  procurement: 1,
  total: 3
});
assert.equal(rangeSnapshot.locations[0].meals, 175);
assert.equal(rangeSnapshot.meals.find((meal) => meal.meal_type === 'breakfast').produced, 80);
assert.equal(rangeSnapshot.meals.find((meal) => meal.meal_type === 'lunch').produced, 95);
assert.equal(rangeSnapshot.actions.find((action) => action.key === 'inventory').count, 1);
assert.equal(rangeSnapshot.actions.find((action) => action.key === 'production').count, 1);
assert.equal(rangeSnapshot.actions.find((action) => action.key === 'waste').count, 1);

const legacySnapshot = buildManagementDashboardSnapshot({
  ...rangeInput,
  startDate: undefined,
  endDate: undefined,
  date: '2026-08-19',
  view: 'project_manager'
});
assert.equal(legacySnapshot.metrics.total_meals, 95);
assert.equal(legacySnapshot.metrics.daily_spent, 950);
assert.equal(legacySnapshot.range_start, '2026-08-13');
assert.equal(legacySnapshot.range_end, '2026-08-19');
assert.equal(legacySnapshot.trends.length, 7);

const rankedSites = Array.from({ length: 7 }, (_, index) => ({
  id: `rank-project-${index + 1}`,
  name: `Ranked Project ${index + 1}`,
  type: 'location'
}));
const rankingSnapshot = buildManagementDashboardSnapshot({
  view: 'gm',
  startDate: '2026-08-19',
  endDate: '2026-08-19',
  sites: rankedSites,
  production: [
    ...rankedSites.slice(0, 6).map((site, index) => ({
      id: `in-range-${site.id}`,
      site_id: site.id,
      production_date: '2026-08-19',
      status: 'completed',
      actual_servings: index + 1
    })),
    {
      id: 'large-open-backlog',
      site_id: rankedSites[6].id,
      production_date: '2026-07-01',
      status: 'pending_approval',
      actual_servings: 100000
    }
  ]
});
assert.equal(rankingSnapshot.location_series.length, 6);
assert.equal(rankingSnapshot.location_series.some((series) => series.id === rankedSites[6].id), false);
assert.equal(rankingSnapshot.metrics.approvals.production, 1);

const invalidRecordDateSnapshot = buildManagementDashboardSnapshot({
  view: 'project_manager',
  startDate: '2026-02-28',
  endDate: '2026-03-01',
  selectedSiteId: 'project-a',
  sites,
  production: [{
    id: 'invalid-date-production',
    site_id: 'project-a',
    production_date: '2026-02-30',
    status: 'completed',
    actual_servings: 100,
    production_cost_total: 500
  }]
});
assert.equal(invalidRecordDateSnapshot.metrics.total_meals, 0);
assert.equal(invalidRecordDateSnapshot.metrics.daily_spent, 0);
assert.equal(invalidRecordDateSnapshot.trends.reduce((sum, row) => sum + row.produced, 0), 0);
assert.equal(invalidRecordDateSnapshot.meals.reduce((sum, row) => sum + row.produced, 0), 0);

const reconciledBudgetSnapshot = buildManagementDashboardSnapshot({
  view: 'project_manager',
  startDate: '2026-08-18',
  endDate: '2026-08-20',
  selectedSiteId: 'project-a',
  sites,
  budgets: [{
    id: 'three-day-budget',
    site_id: 'project-a',
    start_date: '2026-08-18',
    end_date: '2026-08-20',
    budget_amount: 100,
    scope_type: 'site_period',
    meal_type: 'all',
    status: 'active'
  }]
});
assert.equal(reconciledBudgetSnapshot.metrics.daily_budget, 100);
assert.equal(reconciledBudgetSnapshot.meals.reduce((sum, row) => sum + row.budget, 0), 100);
assert.equal(reconciledBudgetSnapshot.trends.reduce((sum, row) => sum + row.budget, 0), 100);

const earlyYearSnapshot = buildManagementDashboardSnapshot({
  view: 'gm',
  startDate: '0001-01-01',
  endDate: '0001-01-02',
  sites: []
});
assert.deepEqual(earlyYearSnapshot.trends.map((row) => row.date), ['0001-01-01', '0001-01-02']);

const performanceBudgets = Array.from({ length: 10_000 }, (_, index) => ({
  id: `performance-budget-${index}`,
  site_id: 'performance-project',
  start_date: '2024-01-01',
  end_date: '2024-12-31',
  budget_amount: 100,
  scope_type: 'site_period',
  meal_type: 'all',
  status: 'active'
}));
const performanceStart = performance.now();
const performanceSnapshot = buildManagementDashboardSnapshot({
  view: 'gm',
  startDate: '2024-01-01',
  endDate: '2024-12-31',
  selectedSiteId: 'performance-project',
  sites: [{ id: 'performance-project', name: 'Performance Project', type: 'location' }],
  budgets: performanceBudgets
});
const performanceElapsed = performance.now() - performanceStart;
assert.equal(performanceSnapshot.trends.length, 366);
assert.equal(performanceSnapshot.metrics.daily_budget, 1_000_000);
assert.ok(performanceElapsed < 2_500, `10,000-budget range snapshot took ${performanceElapsed.toFixed(0)} ms`);

const distributedSites = Array.from({ length: 600 }, (_, index) => ({
  id: `distributed-project-${index}`,
  name: `Distributed Project ${index}`,
  type: 'location'
}));
const distributedBudgets = Array.from({ length: 10_000 }, (_, index) => ({
  id: `distributed-budget-${index}`,
  site_id: distributedSites[index % distributedSites.length].id,
  start_date: '2024-01-01',
  end_date: '2024-12-31',
  budget_amount: 100,
  scope_type: 'site_period',
  meal_type: 'all',
  status: 'active'
}));
const distributedStart = performance.now();
const distributedSnapshot = buildManagementDashboardSnapshot({
  view: 'gm',
  startDate: '2024-01-01',
  endDate: '2024-12-31',
  sites: distributedSites,
  budgets: distributedBudgets
});
const distributedElapsed = performance.now() - distributedStart;
assert.equal(distributedSnapshot.locations.length, 600);
assert.equal(distributedSnapshot.metrics.daily_budget, 1_000_000);
assert.equal(
  distributedSnapshot.locations.reduce((sum, location) => sum + location.budget, 0),
  1_000_000
);
assert.ok(distributedElapsed < 2_500, `600-site range snapshot took ${distributedElapsed.toFixed(0)} ms`);

console.log('Management dashboard date-range tests passed.');
