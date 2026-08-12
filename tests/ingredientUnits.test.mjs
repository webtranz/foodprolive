import assert from 'node:assert/strict';
import {
  calculateIngredientCost,
  calculateProductionIngredientCost,
  convertIngredientQuantity
} from '../shared/ingredientUnits.js';

const shrimp = {
  unit: 'kg',
  conversion_unit: 'g',
  conversion_factor: 1000,
  cost_per_unit: 43
};

assert.equal(convertIngredientQuantity(21150, 'g', 'kg', shrimp), 21.15);
assert.ok(Math.abs(calculateIngredientCost(21150, 'g', shrimp) - 909.45) < 1e-9);
assert.ok(Math.abs(calculateProductionIngredientCost({ planned_quantity: 21150, unit: 'g' }, shrimp) - 909.45) < 1e-9);

assert.equal(convertIngredientQuantity(1000, 'ml', 'l'), 1);
assert.equal(convertIngredientQuantity(2.5, 'kg', 'g'), 2500);
assert.equal(convertIngredientQuantity(12, 'pieces', 'pieces'), 12);

const custom = { unit: 'box', conversion_unit: 'pieces', conversion_factor: 24 };
assert.equal(convertIngredientQuantity(48, 'pieces', 'box', custom), 2);
assert.equal(convertIngredientQuantity(2, 'box', 'pieces', custom), 48);

const screenshotBatch = [
  [21150, 'g', 'kg', 43],
  [7500, 'g', 'kg', 2.25],
  [4000, 'g', 'kg', 4.5],
  [500, 'g', 'kg', 12],
  [1000, 'g', 'kg', 9.5],
  [500, 'g', 'kg', 9],
  [500, 'g', 'kg', 11],
  [1000, 'ml', 'l', 12],
  [500, 'g', 'kg', 9.5],
  [100, 'g', 'kg', 11],
  [100, 'g', 'kg', 1.8],
  [3000, 'g', 'kg', 2.25]
];
const screenshotBatchCost = screenshotBatch.reduce(
  (sum, [quantity, unit, baseUnit, cost]) => sum + calculateIngredientCost(
    quantity,
    unit,
    { unit: baseUnit, cost_per_unit: cost }
  ),
  0
);
assert.ok(Math.abs(screenshotBatchCost - 994.605) < 1e-9);
assert.ok(Math.abs((screenshotBatchCost / 100) - 9.94605) < 1e-9);

console.log('Ingredient unit conversion tests passed.');
