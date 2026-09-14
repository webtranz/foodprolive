import assert from 'node:assert/strict';
import {
  buildConfirmedFoodCostRows,
  buildPendingProductionRows,
  groupFoodCostRows
} from '../shared/foodCostReport.js';

const productions = [
  {
    id: 'prod-served',
    status: 'completed',
    production_date: '2026-09-01',
    site_id: 'store-384',
    site_name: 'STORE 384',
    meal_type: 'dinner',
    menu_type: 'general',
    menu_category: 'labor',
    recipe_id: 'recipe-labor',
    recipe_name: 'Dinner Menu Labor / General (8 Items)',
    production_cost_total: 200,
    actual_finished_weight_grams: 10000,
    produced_servings: 100
  },
  {
    id: 'prod-pending',
    status: 'completed',
    production_date: '2026-09-01',
    site_id: 'store-384',
    site_name: 'STORE 384',
    meal_type: 'breakfast',
    menu_type: 'general',
    menu_category: 'senior',
    recipe_id: 'recipe-senior',
    recipe_name: 'Breakfast Menu Senior / General (7 Items)',
    production_cost_total: 900,
    actual_finished_weight_grams: 50000,
    produced_servings: 250
  }
];

const producedItemBatches = [
  {
    id: 'batch-served',
    production_id: 'prod-served',
    produced_weight_grams: 10000
  },
  {
    id: 'batch-pending',
    production_id: 'prod-pending',
    produced_weight_grams: 50000
  }
];

const consumptions = [
  {
    id: 'consumption-served',
    service_date: '2026-09-01',
    site_id: 'store-384',
    site_name: 'STORE 384',
    meal_type: 'dinner',
    menu_type: 'general',
    menu_category: 'labor',
    recipe_id: 'recipe-labor',
    recipe_name: 'Dinner Menu Labor / General (8 Items)',
    covers: 40,
    portion_size_grams: 100,
    consumed_servings: 40,
    consumed_weight_grams: 4000,
    movement_type: 'consumption',
    allocations: [
      {
        produced_item_batch_id: 'batch-served',
        production_id: 'prod-served',
        weight_grams: 4000
      }
    ]
  },
  {
    id: 'plate-waste-adjustment',
    service_date: '2026-09-01',
    site_id: 'store-384',
    site_name: 'STORE 384',
    meal_type: 'dinner',
    menu_type: 'general',
    menu_category: 'labor',
    recipe_id: 'recipe-labor',
    recipe_name: 'Dinner Menu Labor / General (8 Items)',
    covers: 0,
    portion_size_grams: 100,
    consumed_servings: -5,
    consumed_weight_grams: -500,
    total_cost: -10,
    movement_type: 'plate_waste_adjustment',
    allocations: [
      {
        source_consumption_id: 'consumption-served',
        weight_grams: -500,
        estimated_cost: -10
      }
    ]
  }
];

const confirmedRows = buildConfirmedFoodCostRows({
  consumptions,
  productions,
  producedItemBatches
});

assert.equal(confirmedRows.length, 2);
assert.equal(confirmedRows[0].servings, 40);
assert.equal(confirmedRows[0].total_cost, 80);
assert.equal(confirmedRows[0].cost_per_serving, 2);
assert.equal(confirmedRows[1].servings, 0);
assert.equal(confirmedRows[1].total_cost, -10);

const groupedRows = groupFoodCostRows(confirmedRows, 'meal_type');
assert.equal(groupedRows.length, 1);
assert.equal(groupedRows[0].total_servings, 40);
assert.equal(groupedRows[0].total_cost, 70);
assert.equal(groupedRows[0].cost_per_serving, 1.75);

const pendingRows = buildPendingProductionRows({
  consumptions,
  productions,
  producedItemBatches
});

assert.equal(pendingRows.length, 1);
assert.equal(pendingRows[0].production, 'Breakfast Menu Senior / General (7 Items)');
assert.equal(pendingRows[0].production_cost, 900);

console.log('foodCostReport tests passed');
