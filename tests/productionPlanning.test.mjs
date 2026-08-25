import assert from 'node:assert/strict';
import {
  buildProductionPlanExportRows,
  buildProductionPlanningDashboard,
  normalizeProductionMealType
} from '../src/lib/productionPlanning.js';

const ingredients = [
  {
    id: 'rice',
    name: 'Basmati Rice',
    unit: 'kg',
    conversion_unit: 'g',
    conversion_factor: 1000,
    cooking_yield_percent: 200,
    cost_per_unit: 10
  },
  {
    id: 'chicken',
    name: 'Chicken',
    unit: 'kg',
    cooking_yield_percent: 80,
    cost_per_unit: 20
  }
];

const recipes = [
  {
    id: 'rice-recipe',
    name: 'Steamed Rice',
    servings: 10,
    prep_time_minutes: 10,
    cook_time_minutes: 20,
    ingredients: [
      { ingredient_id: 'rice', ingredient_name: 'Basmati Rice', quantity: 5, unit: 'kg' }
    ]
  },
  {
    id: 'chicken-recipe',
    name: 'Chicken Rice',
    servings: 25,
    prep_time_minutes: 15,
    cook_time_minutes: 45,
    ingredients: [
      { ingredient_id: 'chicken', ingredient_name: 'Chicken', quantity: 10, unit: 'kg' }
    ]
  },
  {
    id: 'dessert-recipe',
    name: 'Dinner Dessert',
    servings: 20,
    prep_time_minutes: 20,
    cook_time_minutes: 40,
    portion_size: '1 slice',
    ingredients: []
  }
];

const productions = [
  {
    id: 'breakfast-1',
    site_id: 'site-a',
    site_name: 'Main Kitchen',
    production_date: '2026-08-16',
    recipe_id: 'rice-recipe',
    recipe_name: 'Steamed Rice',
    meal_type: 'Breakfast',
    target_servings: 60,
    kitchen_station: 'Hot Line',
    status: 'approved',
    notes: 'Hold ten portions for late service.',
    ingredients_used: [
      {
        ingredient_id: 'rice',
        ingredient_name: 'Basmati Rice',
        net_quantity: 5,
        planned_quantity: 6,
        actual_quantity: 0,
        yield_percent: 83.33,
        unit: 'kg'
      }
    ]
  },
  {
    id: 'lunch-1',
    site_id: 'site-a',
    site_name: 'Main Kitchen',
    production_date: '2026-08-16',
    recipe_id: 'chicken-recipe',
    recipe_name: 'Chicken Rice',
    meal_type: 'lunch',
    target_servings: 50,
    assigned_station: 'Grill',
    status: 'in_progress',
    ingredients_used: [
      { ingredient_id: 'rice', ingredient_name: 'Basmati Rice', planned_quantity: 5, unit: 'kg' }
    ]
  },
  {
    id: 'dinner-1',
    site_id: 'site-a',
    site_name: 'Main Kitchen',
    production_date: '2026-08-16',
    recipe_id: 'dessert-recipe',
    recipe_name: 'Dinner Dessert',
    meal_type: 'dinner',
    target_servings: 20,
    kitchen_station: 'Pastry',
    status: 'completed',
    production_cost_total: 42,
    ingredients_used: [
      { ingredient_id: 'rice', ingredient_name: 'Basmati Rice', actual_quantity: 100, unit: 'kg' }
    ]
  },
  {
    id: 'cancelled-1',
    site_id: 'site-a',
    recipe_id: 'rice-recipe',
    recipe_name: 'Cancelled Rice',
    meal_type: 'snack',
    target_servings: 0,
    status: 'cancelled',
    ingredients_used: []
  }
];

const dashboard = buildProductionPlanningDashboard({
  productions,
  recipes,
  ingredients,
  inventory: [
    {
      id: 'stock-rice',
      site_id: 'site-a',
      site_name: 'Main Kitchen',
      ingredient_id: 'rice',
      ingredient_name: 'Basmati Rice',
      quantity: 8,
      unit: 'kg'
    }
  ]
});

assert.equal(normalizeProductionMealType('BREAKFAST'), 'breakfast');
assert.equal(normalizeProductionMealType('snack'), 'other');

assert.deepEqual(
  dashboard.sections.slice(0, 3).map((section) => section.key),
  ['breakfast', 'lunch', 'dinner']
);
assert.equal(dashboard.sections.find((section) => section.key === 'breakfast').total_portions, 60);
assert.equal(dashboard.sections.find((section) => section.key === 'lunch').total_portions, 50);
assert.equal(dashboard.sections.find((section) => section.key === 'dinner').total_portions, 20);
assert.equal(dashboard.summary.total_portions, 130);
assert.equal(dashboard.summary.total_recipes, 3);
assert.equal(dashboard.summary.total_batch_cost, 152);

const breakfast = dashboard.items.find((item) => item.id === 'breakfast-1');
assert.equal(breakfast.portion_size.is_complete, true);
assert.equal(breakfast.portion_size.grams, 1000);
assert.equal(breakfast.portion_size.label, '1,000 g');
assert.equal(breakfast.batch_yield, 10);
assert.equal(breakfast.batches_required, 6);
assert.equal(breakfast.estimated_batch_cost, 60);
assert.equal(breakfast.station, 'Hot Line');
assert.equal(breakfast.prep_status.key, 'pending');

const lunch = dashboard.items.find((item) => item.id === 'lunch-1');
assert.equal(lunch.batches_required, 2);
assert.equal(lunch.station, 'Grill');
assert.equal(lunch.prep_status.key, 'in_progress');

const dinner = dashboard.items.find((item) => item.id === 'dinner-1');
assert.equal(dinner.portion_size.label, '1 slice');
assert.equal(dinner.estimated_batch_cost, 42);
assert.equal(dinner.prep_status.key, 'complete');

const cancelled = dashboard.all_items.find((item) => item.id === 'cancelled-1');
assert.equal(cancelled.batches_required, 0);
assert.equal(cancelled.counts_toward_plan, false);
assert.equal(dashboard.items.some((item) => item.id === 'cancelled-1'), false);

assert.equal(dashboard.shortages.length, 0, 'stock already consumed by an in-progress production is not counted as future demand');

assert.equal(dashboard.labor_loads.breakfast.minutes, 180);
assert.equal(dashboard.labor_loads.lunch.minutes, 120);
assert.equal(dashboard.labor_loads.dinner.minutes, 60);
assert.equal(dashboard.labor_loads.breakfast.share_percent, 50);
assert.equal(dashboard.summary.plan_notes[0].recipe_name, 'Steamed Rice');

const exportRows = buildProductionPlanExportRows(dashboard);
assert.equal(exportRows.length, 3);
assert.equal(exportRows[0].production_date, '2026-08-16');
assert.equal(exportRows[0].site, 'Main Kitchen');
assert.equal(exportRows[0].portion_size, '1,000 g');
assert.equal(exportRows[0].kitchen_station, 'Hot Line');
assert.equal(exportRows[0].prep_status, 'Pending');
assert.equal(exportRows[0].shortages, '');
assert.equal(exportRows[0].net_recipe_quantities, 'Basmati Rice: 5 kg');
assert.equal(exportRows[0].ingredient_quantities, 'Basmati Rice: 6 kg');
assert.equal(exportRows[0].yield_details, 'Basmati Rice: 83.33%');

const statusDashboard = buildProductionPlanningDashboard({
  productions: [
    { id: 'complete', site_id: 'site-a', meal_type: 'breakfast', target_servings: 1, status: 'completed' },
    { id: 'progress', site_id: 'site-a', meal_type: 'lunch', target_servings: 1, status: 'in_progress' },
    { id: 'pending', site_id: 'site-a', meal_type: 'dinner', target_servings: 1, status: 'planned' },
    {
      id: 'risk',
      site_id: 'site-a',
      meal_type: 'dinner',
      target_servings: 1,
      status: 'approved',
      ingredients_used: [{ ingredient_id: 'rice', planned_quantity: 1, unit: 'kg' }]
    }
  ],
  ingredients,
  inventory: []
});
assert.equal(statusDashboard.items.find((item) => item.id === 'complete').prep_status.key, 'complete');
assert.equal(statusDashboard.items.find((item) => item.id === 'progress').prep_status.key, 'in_progress');
assert.equal(statusDashboard.items.find((item) => item.id === 'pending').prep_status.key, 'pending');
assert.equal(statusDashboard.items.find((item) => item.id === 'risk').prep_status.key, 'at_risk');

const storeRoutedDashboard = buildProductionPlanningDashboard({
  productions: [{
    id: 'store-routed',
    site_id: 'project-a',
    site_name: 'Project A',
    fulfillment_store_id: 'store-a',
    fulfillment_store_name: 'Project A Main Store',
    meal_type: 'lunch',
    target_servings: 10,
    status: 'pending_production',
    ingredients_used: [{
      ingredient_id: 'rice',
      ingredient_name: 'Basmati Rice',
      planned_quantity: 4,
      actual_quantity: 0,
      unit: 'kg'
    }]
  }],
  ingredients,
  inventory: [
    { site_id: 'project-a', ingredient_id: 'rice', quantity: 100, unit: 'kg' },
    { site_id: 'store-a', site_name: 'Project A Main Store', ingredient_id: 'rice', quantity: 1, unit: 'kg' }
  ]
});
assert.equal(storeRoutedDashboard.shortages.length, 1);
assert.equal(storeRoutedDashboard.shortages[0].site_id, 'store-a');
assert.equal(storeRoutedDashboard.shortages[0].site_name, 'Project A Main Store');
assert.equal(storeRoutedDashboard.shortages[0].available_quantity, 1);
assert.equal(storeRoutedDashboard.shortages[0].shortage_quantity, 3);

const reservationAwareDashboard = buildProductionPlanningDashboard({
  productions: [
    {
      id: 'fully-reserved',
      site_id: 'store-a',
      meal_type: 'breakfast',
      target_servings: 10,
      status: 'approved',
      inventory_commitment_status: 'reserved',
      inventory_committed_lines: [{ ingredient_id: 'rice', reserved_quantity: 4, unit: 'kg' }],
      ingredients_used: [{ ingredient_id: 'rice', ingredient_name: 'Basmati Rice', planned_quantity: 4, unit: 'kg' }]
    },
    {
      id: 'unreserved-demand',
      site_id: 'store-a',
      meal_type: 'lunch',
      target_servings: 10,
      status: 'pending_production',
      ingredients_used: [{ ingredient_id: 'rice', ingredient_name: 'Basmati Rice', planned_quantity: 3, unit: 'kg' }]
    }
  ],
  ingredients,
  inventory: [{
    site_id: 'store-a',
    ingredient_id: 'rice',
    on_hand_quantity: 6,
    reserved_quantity: 4,
    available_quantity: 2,
    quantity: 2,
    unit: 'kg'
  }]
});
assert.equal(reservationAwareDashboard.shortages.length, 1);
assert.equal(reservationAwareDashboard.shortages[0].required_quantity, 3);
assert.equal(reservationAwareDashboard.shortages[0].on_hand_quantity, 6);
assert.equal(reservationAwareDashboard.shortages[0].reserved_quantity, 4);
assert.equal(reservationAwareDashboard.shortages[0].available_quantity, 2);
assert.equal(reservationAwareDashboard.shortages[0].shortage_quantity, 1);
assert.deepEqual(reservationAwareDashboard.shortages[0].production_ids, ['unreserved-demand']);
assert.equal(reservationAwareDashboard.items.find((item) => item.id === 'fully-reserved').shortages.length, 0);

const legacySingleStoreDashboard = buildProductionPlanningDashboard({
  productions: [{
    id: 'legacy-single-store',
    site_id: 'project-a',
    site_name: 'Project A',
    meal_type: 'lunch',
    target_servings: 10,
    status: 'approved',
    ingredients_used: [{ ingredient_id: 'rice', ingredient_name: 'Basmati Rice', planned_quantity: 5, unit: 'kg' }]
  }],
  ingredients,
  sites: [
    { id: 'project-a', name: 'Project A', type: 'project', is_active: true },
    { id: 'store-a', name: 'Project A Main Store', type: 'store', parent_site_id: 'project-a', is_active: true }
  ],
  inventory: [{ site_id: 'store-a', ingredient_id: 'rice', quantity: 10, unit: 'kg' }]
});
assert.equal(legacySingleStoreDashboard.shortages.length, 0);

console.log('Production planning dashboard tests passed.');
