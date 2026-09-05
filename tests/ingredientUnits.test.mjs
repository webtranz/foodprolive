import assert from 'node:assert/strict';
import {
  calculateIngredientCost,
  calculateProductionIngredientCost,
  convertIngredientQuantity,
  isIngredientUnitCompatible
} from '../shared/ingredientUnits.js';
import { inferPackageFields, normalizeInventoryUnitLabel, parsePackageDescriptor } from '../shared/packageUnits.js';
import { calculateRecipeIngredientLineCost } from '../shared/recipeCosting.js';

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
assert.equal(convertIngredientQuantity(0.3, 'l', 'ml'), 300);
assert.equal(convertIngredientQuantity(300, 'ml', 'l'), 0.3);
assert.equal(convertIngredientQuantity(2.5, 'kg', 'g'), 2500);
assert.equal(convertIngredientQuantity(12, 'pieces', 'pieces'), 12);
assert.equal(convertIngredientQuantity(12, 'ct', 'pieces'), 12);

const custom = { unit: 'box', conversion_unit: 'pieces', conversion_factor: 24 };
assert.equal(convertIngredientQuantity(48, 'pieces', 'box', custom), 2);
assert.equal(convertIngredientQuantity(2, 'box', 'pieces', custom), 48);
assert.equal(normalizeInventoryUnitLabel('BDL'), 'Bundle');
assert.equal(normalizeInventoryUnitLabel('EA'), 'Each');
assert.equal(normalizeInventoryUnitLabel('PAK'), 'Packet');
assert.equal(normalizeInventoryUnitLabel('CS'), 'Case');

assert.deepEqual(inferPackageFields({
  name: 'CORIANDER LEAVES (BDL)',
  unit: 'BDL'
}), {
  package_base_quantity: 0.08,
  package_base_unit: 'kg',
  package_parse_source: 'default_bundle_weight'
});

const corianderBundle = {
  name: 'CORIANDER LEAVES (BDL)',
  unit: 'BDL',
  cost_per_unit: 1.5
};
assert.equal(convertIngredientQuantity(80, 'g', 'BDL', corianderBundle), 1);
assert.equal(convertIngredientQuantity(1, 'BDL', 'g', corianderBundle), 80);
assert.ok(Math.abs(calculateIngredientCost(40, 'g', corianderBundle) - 0.75) < 1e-9);

assert.deepEqual(parsePackageDescriptor('SHAN RED CHILLI POWDER 10/1KG'), {
  count_levels: [10],
  pack_count: 10,
  inner_count: 1,
  unit_size_quantity: 1,
  unit_size_unit: 'kg',
  level_count: 1
});
assert.deepEqual(inferPackageFields({
  name: 'TAFGA REHAN SALT IODIZED 24/700G',
  unit: 'EA'
}), {
  package_pack_count: 24,
  package_inner_count: 1,
  package_size_quantity: 700,
  package_size_unit: 'g',
  package_base_quantity: 0.7,
  package_base_unit: 'kg',
  package_parse_source: 'item_name_package'
});
assert.deepEqual(inferPackageFields({
  name: 'TAFGA MAGGI CUBES CHICKEN 24/24/20G',
  unit: 'CS'
}), {
  package_pack_count: 24,
  package_inner_count: 24,
  package_size_quantity: 20,
  package_size_unit: 'g',
  package_base_quantity: 11.52,
  package_base_unit: 'kg',
  package_parse_source: 'item_name_package'
});
assert.deepEqual(inferPackageFields({
  name: 'SAEDCO FRESH EGGS MEDIUM 12/30 CT',
  unit: 'PAK'
}), {
  package_pack_count: 12,
  package_inner_count: 1,
  package_size_quantity: 30,
  package_size_unit: 'pieces',
  package_base_quantity: 30,
  package_base_unit: 'pieces',
  package_parse_source: 'item_name_package'
});
assert.deepEqual(parsePackageDescriptor('GOODY PASTA #20 SPAGHETTI 24/450'), {
  count_levels: [24],
  pack_count: 24,
  inner_count: 1,
  unit_size_quantity: 450,
  unit_size_unit: 'g',
  level_count: 1
});
assert.deepEqual(inferPackageFields({
  name: 'GOODY PASTA #20 SPAGHETTI 24/450',
  unit: 'EA'
}), {
  package_pack_count: 24,
  package_inner_count: 1,
  package_size_quantity: 450,
  package_size_unit: 'g',
  package_base_quantity: 0.45,
  package_base_unit: 'kg',
  package_parse_source: 'item_name_package'
});
assert.deepEqual(inferPackageFields({
  name: '(TAFGA) NOVA WATER 24/0.55-0.6LTR',
  unit: 'EA'
}), {
  package_pack_count: 24,
  package_inner_count: 1,
  package_size_quantity: 0.55,
  package_size_unit: 'l',
  package_base_quantity: 0.55,
  package_base_unit: 'l',
  package_parse_source: 'item_name_package'
});
assert.deepEqual(inferPackageFields({
  name: 'BOTTLED JUICE 12/600 ML',
  unit: 'EA'
}), {
  package_pack_count: 12,
  package_inner_count: 1,
  package_size_quantity: 600,
  package_size_unit: 'ml',
  package_base_quantity: 0.6,
  package_base_unit: 'l',
  package_parse_source: 'item_name_package'
});

const redChilli = {
  name: 'SHAN RED CHILLI POWDER 10/1KG',
  unit: 'EA',
  cost_per_unit: 19.002124
};
assert.equal(convertIngredientQuantity(200, 'g', 'EA', redChilli), 0.2);
assert.ok(Math.abs(calculateIngredientCost(200, 'g', redChilli) - 3.8004248) < 1e-9);
assert.ok(Math.abs(calculateRecipeIngredientLineCost(
  { quantity: 200, unit: 'g' },
  redChilli
).line_cost - 3.8004248) < 1e-9);

const salt = {
  name: 'TAFGA REHAN SALT IODIZED 24/700G',
  unit: 'EA',
  cost_per_unit: 0.79
};
assert.ok(Math.abs(convertIngredientQuantity(350, 'g', 'EA', salt) - 0.5) < 1e-9);
assert.ok(Math.abs(calculateIngredientCost(350, 'g', salt) - 0.395) < 1e-9);

const chilliCase = {
  name: 'SHAN RED CHILLI POWDER 10/1KG',
  unit: 'CS',
  cost_per_unit: 190.02124
};
assert.equal(convertIngredientQuantity(2, 'kg', 'CS', chilliCase), 0.2);
assert.ok(Math.abs(calculateIngredientCost(2, 'kg', chilliCase) - 38.004248) < 1e-9);
assert.equal(isIngredientUnitCompatible('g', 'EA', redChilli), true);

const eggs = {
  name: 'SAEDCO FRESH EGGS MEDIUM 12/30 CT',
  unit: 'PAK',
  cost_per_unit: 24
};
assert.equal(convertIngredientQuantity(12, 'ct', 'PAK', eggs), 0.4);
assert.equal(convertIngredientQuantity(15, 'pieces', 'PAK', eggs), 0.5);
assert.ok(Math.abs(calculateIngredientCost(15, 'pieces', eggs) - 12) < 1e-9);

const juiceBottle = {
  name: 'BOTTLED JUICE 12/600 ML',
  unit: 'EA',
  cost_per_unit: 3
};
assert.equal(convertIngredientQuantity(300, 'ml', 'EA', juiceBottle), 0.5);
assert.equal(convertIngredientQuantity(0.3, 'l', 'EA', juiceBottle), 0.5);
assert.equal(convertIngredientQuantity(1, 'EA', 'ml', juiceBottle), 600);
assert.ok(Math.abs(calculateIngredientCost(300, 'ml', juiceBottle) - 1.5) < 1e-9);
assert.equal(isIngredientUnitCompatible('ml', 'EA', juiceBottle), true);
assert.equal(isIngredientUnitCompatible('l', 'EA', juiceBottle), true);
assert.equal(isIngredientUnitCompatible('g', 'EA', juiceBottle), false);

const oysterSauce = {
  name: 'A-(TAFGA) AFFCO OYSTER SAUCE 12/600ML',
  unit: 'EA',
  cost_per_unit: 10.92
};
assert.ok(Math.abs(convertIngredientQuantity(0.02, 'l', 'EA', oysterSauce) - (0.02 / 0.6)) < 1e-9);
assert.ok(Math.abs(calculateIngredientCost(20, 'ml', oysterSauce) - 0.364) < 1e-9);
assert.equal(isIngredientUnitCompatible('g', 'EA', oysterSauce), false);
assert.equal(calculateRecipeIngredientLineCost(
  { quantity: 20, unit: 'g' },
  oysterSauce
).incompatible_unit, true);

const goodyPasta = {
  name: 'GOODY PASTA #20 SPAGHETTI 24/450',
  unit: 'EA',
  cost_per_unit: 4.31
};
assert.ok(Math.abs(convertIngredientQuantity(60, 'g', 'EA', goodyPasta) - (60 / 450)) < 1e-9);
assert.ok(Math.abs(calculateIngredientCost(60, 'g', goodyPasta) - 0.5746666667) < 1e-9);

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
