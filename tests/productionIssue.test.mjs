import assert from 'node:assert/strict';

import {
  aggregateProductionIngredientLines,
  buildInventoryReplacementSuggestions,
  buildMenuIssueMealGroups,
  buildMenuPlanIssueItems,
  buildProductionIngredientLine,
  buildProductionIngredientSnapshot,
  buildProductionIngredientsForSubmit,
  buildProductionOverrideAudit,
  recalculateProductionIngredientSnapshot
} from '../src/lib/productionIssue.js';

const ingredients = [
  {
    id: 'chickpeas',
    name: 'Chickpeas',
    category: 'legume',
    unit: 'kg',
    cost_per_unit: 8
  },
  {
    id: 'yellow-peas',
    name: 'Yellow Peas',
    category: 'legume',
    unit: 'kg',
    cost_per_unit: 6
  },
  {
    id: 'coriander',
    name: 'Fresh Coriander',
    category: 'herb',
    unit: 'kg',
    cost_per_unit: 12
  }
];

const recipes = [
  {
    id: 'chana',
    name: 'Chana Masala',
    servings: 10,
    kitchen_station: 'Hot Kitchen',
    ingredients: [
      { ingredient_id: 'chickpeas', ingredient_name: 'Chickpeas', quantity: 5, unit: 'kg' }
    ]
  },
  {
    id: 'rice',
    name: 'Mandi Rice',
    servings: 20,
    ingredients: []
  }
];

const inventory = [
  {
    site_id: 'store-1',
    ingredient_id: 'chickpeas',
    ingredient_name: 'Chickpeas',
    quantity: 6,
    unit: 'kg'
  },
  {
    site_id: 'store-1',
    ingredient_id: 'yellow-peas',
    ingredient_name: 'Yellow Peas',
    quantity: 20,
    unit: 'kg'
  },
  {
    site_id: 'store-1',
    ingredient_id: 'coriander',
    ingredient_name: 'Fresh Coriander',
    quantity: 2,
    unit: 'kg'
  }
];

const menuPlan = {
  id: 'plan-1',
  site_id: 'project-1',
  site_name: 'Project 1',
  plan_date: '2026-09-05',
  cuisine_type: 'general',
  menu_category: 'senior',
  meals: [
    { meal_type: 'breakfast', recipe_id: 'chana', recipe_name: 'Chana Masala', expected_servings: 30 },
    { meal_type: 'lunch', recipe_id: 'rice', recipe_name: 'Mandi Rice', expected_servings: 40 },
    { meal_type: 'dinner', recipe_id: '', expected_servings: 50 },
    { meal_type: 'snack', recipe_id: 'chana', expected_servings: 5 }
  ]
};

const breakfastItems = buildMenuPlanIssueItems(menuPlan, { mealView: 'breakfast', recipes });
assert.equal(breakfastItems.length, 1);
assert.equal(breakfastItems[0].meal_type, 'breakfast');
assert.equal(breakfastItems[0].production_covers, 30);

const allItems = buildMenuPlanIssueItems(menuPlan, { mealView: 'all', recipes });
assert.deepEqual(allItems.map((item) => item.meal_type), ['breakfast', 'lunch']);

const groupedBreakfastPlan = {
  ...menuPlan,
  id: 'grouped-plan',
  meals: [
    { meal_type: 'breakfast', recipe_id: 'chana', recipe_name: 'Chana Masala', expected_servings: 20 },
    { meal_type: 'breakfast', recipe_id: 'chana', recipe_name: 'Chana Masala Repeat', expected_servings: 20 },
    { meal_type: 'lunch', recipe_id: 'rice', recipe_name: 'Mandi Rice', expected_servings: 10 }
  ]
};
const groupedInventory = [
  {
    site_id: 'store-2',
    ingredient_id: 'chickpeas',
    ingredient_name: 'Chickpeas',
    quantity: 18,
    unit: 'kg'
  }
];
const groupedBreakfastItems = buildMenuPlanIssueItems(groupedBreakfastPlan, { mealView: 'breakfast', recipes });
const groupedSnapshots = Object.fromEntries(groupedBreakfastItems.map((item) => [
  item.key,
  buildProductionIngredientSnapshot({
    recipe: recipes.find((recipe) => recipe.id === item.recipe_id),
    recipes,
    ingredients,
    inventory: groupedInventory,
    siteId: 'store-2',
    targetServings: item.production_covers
  }).lines
]));
assert.equal(groupedSnapshots[groupedBreakfastItems[0].key][0].sufficient, true);
assert.equal(groupedSnapshots[groupedBreakfastItems[1].key][0].sufficient, true);
const groupedLines = aggregateProductionIngredientLines(
  Object.values(groupedSnapshots).flat(),
  { ingredients, inventory: groupedInventory, siteId: 'store-2' }
);
assert.equal(groupedLines[0].raw_quantity, 20);
assert.equal(groupedLines[0].shortage, 2);
const mealGroups = buildMenuIssueMealGroups(groupedBreakfastItems, {
  snapshotsByItemKey: groupedSnapshots,
  ingredients,
  inventory: groupedInventory,
  siteId: 'store-2'
});
assert.equal(mealGroups.length, 1);
assert.equal(mealGroups[0].meal_type, 'breakfast');
assert.equal(mealGroups[0].items.length, 2);
assert.equal(mealGroups[0].production_covers, 40);
assert.equal(mealGroups[0].shortageCount, 1);
const groupedDailyLines = aggregateProductionIngredientLines(mealGroups.flatMap((group) => group.snapshot_lines), {
  ingredients,
  inventory: groupedInventory,
  siteId: 'store-2'
});
assert.deepEqual(
  groupedDailyLines[0].source_menu_plan_item_keys.sort(),
  groupedBreakfastItems.map((item) => item.key).sort()
);

const snapshot = buildProductionIngredientSnapshot({
  recipe: recipes[0],
  recipes,
  ingredients,
  inventory,
  siteId: 'store-1',
  targetServings: 30
});
assert.equal(snapshot.lines.length, 1);
assert.equal(snapshot.lines[0].raw_quantity, 15);
assert.equal(snapshot.lines[0].shortage, 9);
assert.equal(snapshot.lines[0].sufficient, false);
assert.equal(snapshot.estimatedBatchCost, 120);

const replacementSuggestions = buildInventoryReplacementSuggestions({
  line: snapshot.lines[0],
  ingredients,
  inventory,
  siteId: 'store-1'
});
assert.equal(replacementSuggestions[0].ingredient_id, 'yellow-peas');

const replacedLine = {
  ...snapshot.lines[0],
  ingredient_id: 'yellow-peas',
  ingredient_name: 'Yellow Peas',
  unit: 'kg',
  inventory_unit: 'kg',
  production_override_source: 'ai_suggestion',
  production_override_reason: 'Closest available legume.'
};
const recalculated = recalculateProductionIngredientSnapshot([replacedLine], {
  ingredients,
  inventory,
  siteId: 'store-1'
});
assert.equal(recalculated.lines[0].production_override_action, 'replaced');
assert.equal(recalculated.lines[0].original_ingredient_id, 'chickpeas');
assert.equal(recalculated.lines[0].ingredient_id, 'yellow-peas');
assert.equal(recalculated.lines[0].sufficient, true);

const addedLine = buildProductionIngredientLine({
  sourceLine: {
    ingredient_id: 'coriander',
    ingredient_name: 'Fresh Coriander',
    raw_quantity: 1,
    unit: 'kg',
    production_override_action: 'added',
    production_override_source: 'chef'
  },
  ingredient: ingredients[2],
  inventory,
  siteId: 'store-1'
});
const overrideAudit = buildProductionOverrideAudit([...recalculated.lines, addedLine], {
  recordedAt: '2026-09-05T10:00:00.000Z'
});
assert.deepEqual(overrideAudit.map((entry) => entry.action), ['replaced', 'added']);
assert.equal(overrideAudit[0].original_ingredient_name, 'Chickpeas');
assert.equal(overrideAudit[1].original_ingredient_name, null);

const submitLines = buildProductionIngredientsForSubmit([...recalculated.lines, addedLine]);
assert.equal(submitLines[0].quantity_basis, 'production_snapshot_override_v1');
assert.equal(submitLines[0].production_override_action, 'replaced');
assert.equal(submitLines[0].original_ingredient_id, 'chickpeas');
assert.equal(submitLines[1].production_override_action, 'added');

assert.equal(recipes[0].ingredients[0].ingredient_id, 'chickpeas', 'master recipe was not mutated');
