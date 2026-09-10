import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecipeNutrition } from '../shared/recipeNutrition.js';

const nutrients = ['calories', 'protein', 'carbs', 'fat', 'sodium', 'sugar'];
const ingredient = (overrides = {}) => ({
  id: 'food', name: 'Food', unit: 'g', calories_per_100g: 100,
  protein_per_100g: 10, carbs_per_100g: 20, fat_per_100g: 5,
  sodium_per_100g: 50, sugar_per_100g: 0, allergens: [], ...overrides
});
const line = (overrides = {}) => ({ ingredient_id: 'food', quantity: 100, unit: 'g', ...overrides });
const recipe = (overrides = {}) => ({ id: 'dish', servings: 1, ingredients: [line()], ...overrides });
const calculate = (item = recipe(), catalog = [ingredient()], recipes = []) =>
  calculateRecipeNutrition(item, recipes, catalog);
const assertUnknownNutrition = (result) => {
  for (const nutrient of nutrients) {
    assert.equal(result[`total_${nutrient}`], null);
    assert.equal(result[`${nutrient}_per_serving`], null);
  }
  assert.equal(result.nutrition_complete, false);
};

test('physical units use raw mass and preserve valid zero nutrition', () => {
  const result = calculate(recipe({
    servings: 5,
    ingredients: [line({ quantity: 1, unit: 'KG' }), line({ quantity: 250, unit: 'g' })]
  }), [ingredient({ cooking_yield_percent: 260 })]);
  assert.equal(result.total_calories, 1250);
  assert.equal(result.calories_per_serving, 250);
  assert.equal(result.protein_per_serving, 25);
  assert.equal(result.sugar_per_serving, 0);
  assert.equal(result.nutrition_complete, true);
  assert.equal(result.allergens_complete, true);
  assert.deepEqual(result.nutrition_warnings, []);
  assert.equal(result.nutrition_calculation_version, 1);
});

test('mass packages and real piece weights have established gram conversions', () => {
  const cases = [
    { quantity: 1, unit: 'PAK', master: { unit: 'PAK', name: 'Tea 12/50/1.3G', raw_weight_per_unit: 1 }, calories: 65 },
    { quantity: 2, unit: 'pak', master: { unit: 'PAK', package_base_quantity: 0.25, package_base_unit: 'kg' }, calories: 500 },
    { quantity: 2, unit: 'pieces', master: { unit: 'pieces', raw_weight_per_unit: 50 }, calories: 100 },
    { quantity: 12, unit: 'pieces', master: { unit: 'PAK', package_base_quantity: 30, package_base_unit: 'pieces', raw_weight_per_unit: 1500 }, calories: 600 },
    { quantity: 2, unit: 'PAK', master: { unit: 'PAK', raw_weight_per_unit: 80 }, calories: 160 },
    { quantity: 1, unit: 'BDL', master: { unit: 'BDL', raw_weight_per_unit: 75 }, calories: 75 }
  ];
  for (const item of cases) {
    const result = calculate(recipe({ ingredients: [line(item)] }), [ingredient(item.master)]);
    assert.equal(result.total_calories, item.calories, JSON.stringify(item));
    assert.equal(result.nutrition_complete, true);
  }
});

test('unknown pieces, normalized packs, bundles and unitless descriptors do not invent mass', () => {
  const cases = [
    { unit: 'pieces' },
    { unit: 'pieces', raw_weight_per_unit: 1 },
    { unit: 'PAK', raw_weight_per_unit: 1 },
    { unit: 'PAK', package_base_quantity: 30, package_base_unit: 'pieces', raw_weight_per_unit: 1 },
    { unit: 'BDL', name: 'Mint', raw_weight_per_unit: 1 },
    { unit: 'PAK', name: 'Tea 12/500' },
    { unit: 'BDL', package_base_quantity: 0.08, package_base_unit: 'kg', package_parse_source: 'default_bundle_weight' }
  ];
  for (const master of cases) {
    const result = calculate(recipe({ ingredients: [line({ unit: master.unit, quantity: 1 })] }),
      [ingredient({ ...master, allergens: ['milk'] })]);
    assertUnknownNutrition(result);
    assert.deepEqual(result.allergens, ['milk']);
    assert.equal(result.allergens_complete, true);
    assert.ok(result.nutrition_warnings.some((warning) => /Weight unavailable/.test(warning)));
  }
});

test('liquids require established density, raw mass metadata or a bound line weight', () => {
  for (const master of [
    { unit: 'ml' },
    { unit: 'l', raw_weight_per_unit: 1, cooked_weight_per_unit: 1 },
    { unit: 'l', density_g_per_ml: 0 },
    { unit: 'l', density_g_per_ml: -1 },
    { unit: 'EA', name: 'Oil 12/600ML', raw_weight_per_unit: 1 }
  ]) {
    assertUnknownNutrition(calculate(recipe({ ingredients: [line({ unit: master.unit, quantity: 1 })] }),
      [ingredient(master)]));
  }
  assert.equal(calculate(recipe({ ingredients: [line({ unit: 'l', quantity: 1 })] }),
    [ingredient({ unit: 'l', density_g_per_ml: 0.92 })]).total_calories, 920);
  assert.equal(calculate(recipe({ ingredients: [line({ unit: 'ml', quantity: 500 })] }),
    [ingredient({ unit: 'l', raw_weight_per_unit: 1200 })]).total_calories, 600);
  assert.equal(calculate(recipe({ ingredients: [line({ unit: 'EA', quantity: 1 })] }),
    [ingredient({ unit: 'EA', name: 'Oil 12/600ML', density_g_per_ml: 0.9 })]).total_calories, 540);
});

test('bound administrator weights are honored without trusting frozen client totals', () => {
  const weightedLine = line({
    unit: 'scoop', quantity: 2, weight_unit: 'scoop',
    weight_ingredient_id: 'food', weight_per_unit_grams: 25,
    weight_defined_by: 'admin', weight_defined_at: '2026-09-07',
    raw_weight_grams: 99999, yielded_weight_grams: 99999, yield_multiplier: 99
  });
  assert.equal(calculate(recipe({ ingredients: [weightedLine] })).total_calories, 50);
  assertUnknownNutrition(calculate(recipe({ ingredients: [{ ...weightedLine, weight_ingredient_id: 'other' }] })));
  assertUnknownNutrition(calculate(recipe({ ingredients: [{ ...weightedLine, weight_unit: 'pieces' }] })));
  assert.equal(calculate(recipe({ ingredients: [line({ raw_weight_grams: 99999, yielded_weight_grams: 99999 })] })).total_calories, 100);
});

test('exempt processing aids are excluded from nutrition weight while their allergens remain visible', () => {
  const result = calculate(recipe({
    ingredients: [
      line({ quantity: 100, unit: 'g' }),
      line({ ingredient_id: 'water', quantity: 0.4, unit: 'l', exempt_processing_aid: true })
    ]
  }), [
    ingredient({ allergens: ['egg'] }),
    ingredient({
      id: 'water',
      name: 'Water',
      unit: 'l',
      density_g_per_ml: 1,
      calories_per_100g: 500,
      protein_per_100g: 50,
      carbs_per_100g: 50,
      fat_per_100g: 50,
      sodium_per_100g: 50,
      sugar_per_100g: 50,
      allergens: ['sulphites']
    })
  ]);
  assert.equal(result.total_calories, 100);
  assert.equal(result.total_protein, 10);
  assert.equal(result.nutrition_complete, true);
  assert.deepEqual(result.allergens, ['egg', 'sulphites']);
});

test('partial prep exemption applies only retained weight to nutrition totals', () => {
  const result = calculate(recipe({
    ingredients: [
      line({ ingredient_id: 'water', quantity: 1, unit: 'l', prep_exempt_percent: 70 })
    ]
  }), [
    ingredient({
      id: 'water',
      name: 'Water',
      unit: 'l',
      density_g_per_ml: 1,
      calories_per_100g: 100,
      protein_per_100g: 10,
      carbs_per_100g: 10,
      fat_per_100g: 10,
      sodium_per_100g: 10,
      sugar_per_100g: 10,
      allergens: []
    })
  ]);
  assert.equal(result.total_calories, 300);
  assert.equal(result.total_protein, 30);
  assert.equal(result.nutrition_complete, true);
});

test('saved litre-to-gram conversion factors establish nutrition weight across metric units', () => {
  const master = ingredient({ unit: 'l', conversion_unit: 'g', conversion_factor: 920, raw_weight_per_unit: 1 });
  const before = structuredClone(master);
  const cases = [
    { quantity: 1, unit: 'l', calories: 920 },
    { quantity: 500, unit: 'ml', calories: 460 },
    { quantity: 460, unit: 'g', calories: 460 },
    { quantity: 0.46, unit: 'kg', calories: 460 }
  ];
  for (const item of cases) {
    const result = calculate(recipe({ ingredients: [line(item)] }), [master]);
    assert.equal(result.total_calories, item.calories);
    assert.equal(result.nutrition_complete, true);
  }
  const override = calculate(recipe({ ingredients: [line({
    unit: 'l', quantity: 1, weight_unit: 'l', weight_ingredient_id: 'food', weight_per_unit_grams: 850
  })] }), [master]);
  assert.equal(override.total_calories, 850, 'a bound recipe-specific conversion takes precedence');
  assert.deepEqual(master, before);
});

test('missing weight invalidates all totals while allergen collection continues', () => {
  const result = calculate(recipe({ ingredients: [
    line(), line({ ingredient_id: 'unknown-weight', unit: 'scoop', quantity: 1 })
  ] }), [ingredient({ allergens: ['gluten'] }), ingredient({ id: 'unknown-weight', unit: 'scoop', allergens: ['milk'] })]);
  assertUnknownNutrition(result);
  assert.deepEqual(result.allergens, ['gluten', 'milk']);
  assert.equal(result.allergens_complete, true);
});

test('missing nutrient values contribute zero without changing ingredient master data', () => {
  for (const missing of [null, undefined, '', ' ', '\t\n']) {
    const master = ingredient(Object.fromEntries(nutrients.map((key) => [`${key}_per_100g`, missing])));
    const before = structuredClone(master);
    const result = calculate(recipe({ servings: 2, ingredients: [line({ quantity: 250 })] }), [master]);
    for (const nutrient of nutrients) {
      assert.equal(result[`total_${nutrient}`], 0);
      assert.equal(result[`${nutrient}_per_serving`], 0);
    }
    assert.equal(result.nutrition_complete, true);
    assert.deepEqual(result.nutrition_warnings, []);
    assert.deepEqual(master, before);
  }
});

test('malformed nutrient values invalidate only the affected nutrient', () => {
  for (const invalid of [-1, Infinity, NaN, 'unknown', false, {}]) {
    const result = calculate(recipe(), [ingredient({ calories_per_100g: invalid })]);
    assert.equal(result.total_calories, null);
    assert.equal(result.calories_per_serving, null);
    assert.equal(result.total_protein, 10);
    assert.equal(result.total_sugar, 0);
    assert.equal(result.nutrition_complete, false);
    assert.equal(result.allergens_complete, true);
  }
  const result = calculate(recipe(), [ingredient(Object.fromEntries(nutrients.map((key) => [`${key}_per_100g`, 0])))]);
  assert.equal(result.nutrition_complete, true);
  for (const nutrient of nutrients) assert.equal(result[`${nutrient}_per_serving`], 0);
});

test('nested recipes combine known nutrients with zero contributions from missing values', () => {
  const child = recipe({ id: 'child', servings: 4, ingredients: [line({ ingredient_id: 'child-food', quantity: 400 })] });
  const masters = [
    ingredient({ sugar_per_100g: '' }),
    ingredient({ id: 'child-food', calories_per_100g: 50, protein_per_100g: undefined, sugar_per_100g: 5 })
  ];
  const before = structuredClone(masters);
  const result = calculate(recipe({
    servings: 2, sub_recipes: [{ recipe_id: 'child', quantity: 2, unit: 'servings' }]
  }), masters, [child]);
  assert.equal(result.total_calories, 200);
  assert.equal(result.total_protein, 10);
  assert.equal(result.protein_per_serving, 5);
  assert.equal(result.total_sugar, 10);
  assert.equal(result.sugar_per_serving, 5);
  assert.equal(result.nutrition_complete, true);
  assert.deepEqual(result.nutrition_warnings, []);
  assert.deepEqual(masters, before);
});

test('zero defaults for missing nutrients do not turn unknown weights into zero totals', () => {
  const master = ingredient({ unit: 'PAK', protein_per_100g: null, sugar_per_100g: '', allergens: ['milk'] });
  const result = calculate(recipe({ ingredients: [line({ unit: 'PAK', quantity: 1 })] }), [master]);
  assertUnknownNutrition(result);
  assert.ok(result.nutrition_warnings.some((warning) => /Weight unavailable/.test(warning)));
  assert.deepEqual(result.allergens, ['milk']);
  assert.equal(result.allergens_complete, true);
});

test('unknown weight with all missing nutrition contributes zero and does not block recipe nutrition', () => {
  const master = ingredient(Object.fromEntries([
    ['unit', 'l'],
    ['name', 'Chili sauce'],
    ['allergens', ['soy']],
    ...nutrients.map((key) => [`${key}_per_100g`, ''])
  ]));
  const result = calculate(recipe({ ingredients: [line({ unit: 'ml', quantity: 5 })] }), [master]);
  for (const nutrient of nutrients) {
    assert.equal(result[`total_${nutrient}`], 0);
    assert.equal(result[`${nutrient}_per_serving`], 0);
  }
  assert.equal(result.nutrition_complete, true);
  assert.deepEqual(result.nutrition_warnings, []);
  assert.deepEqual(result.allergens, ['soy']);
  assert.equal(result.allergens_complete, true);
});

test('missing records and id-less lines cannot silently produce partial totals or allergen certainty', () => {
  for (const unknown of [
    line({ ingredient_id: 'missing' }), { quantity: 1, unit: 'g' }, null,
    line({ quantity: undefined }), line({ quantity: -1 })
  ]) {
    const result = calculate(recipe({ ingredients: [line(), unknown] }), [ingredient({ allergens: ['milk'] })]);
    assertUnknownNutrition(result);
    assert.equal(result.allergens_complete, false);
    assert.deepEqual(result.allergens, ['milk']);
  }
  for (const child of [{ recipe_id: 'missing', quantity: 1 }, { quantity: 1 }, null]) {
    const result = calculate(recipe({ sub_recipes: [child] }));
    assertUnknownNutrition(result);
    assert.equal(result.allergens_complete, false);
  }
});

test('zero quantities exclude ingredients, missing references and child declarations', () => {
  const child = recipe({ id: 'child', allergens: ['soy'] });
  const result = calculate(recipe({
    ingredients: [line(), line({ quantity: 0, ingredient_id: 'missing' }), { quantity: 0 }],
    sub_recipes: [{ recipe_id: 'child', quantity: 0 }, { recipe_id: 'missing', quantity: 0 }]
  }), [ingredient({ allergens: ['milk'] })], [child]);
  assert.equal(result.total_calories, 100);
  assert.equal(result.nutrition_complete, true);
  assert.equal(result.allergens_complete, true);
  assert.deepEqual(result.allergens, ['milk']);
});

test('nested batches and servings scale without changing nutrient concentration', () => {
  const base = recipe({ id: 'base', servings: 4, allergens: ['soy'] });
  const middle = recipe({
    id: 'middle', servings: 2,
    sub_recipes: [{ recipe_id: 'base', quantity: 2, unit: 'servings' }]
  });
  const result = calculate(recipe({
    servings: 2, sub_recipes: [{ recipe_id: 'middle', quantity: 2, unit: 'batch' }]
  }), [ingredient({ allergens: ['milk'] })], [base, middle]);
  assert.equal(result.total_calories, 400);
  assert.equal(result.calories_per_serving, 200);
  assert.equal(result.nutrition_complete, true);
  assert.deepEqual(result.allergens, ['milk', 'soy']);
  assert.deepEqual(result.declared_allergens, []);
});

test('nonaggregated sub-recipe lines keep different bound gram weights', () => {
  const weighted = (weight) => line({
    quantity: 1, unit: 'scoop', weight_unit: 'scoop', weight_ingredient_id: 'food',
    weight_per_unit_grams: weight
  });
  const child = recipe({ id: 'child', ingredients: [weighted(50)] });
  const result = calculate(recipe({
    ingredients: [weighted(20)], sub_recipes: [{ recipe_id: 'child', quantity: 2, unit: 'batch' }]
  }), [ingredient({ unit: 'scoop' })], [child]);
  assert.equal(result.total_calories, 120);
  assert.equal(result.nutrition_complete, true);
});

test('cycles and invalid child servings produce warnings and retain known tags', () => {
  const child = recipe({ id: 'child', allergens: ['soy'], sub_recipes: [{ recipe_id: 'dish', quantity: 1 }] });
  const result = calculate(recipe({ sub_recipes: [{ recipe_id: 'child', quantity: 1 }] }),
    [ingredient({ allergens: ['milk'] })], [child]);
  assertUnknownNutrition(result);
  assert.equal(result.allergens_complete, false);
  assert.ok(result.nutrition_warnings.some((warning) => /Circular/.test(warning)));
  assert.deepEqual(result.allergens, ['milk', 'soy']);
  assertUnknownNutrition(calculate(recipe({ sub_recipes: [{ recipe_id: 'child', quantity: 1, unit: 'servings' }] }),
    [ingredient()], [{ ...child, servings: 0, sub_recipes: [] }]));
});

test('allergen metadata absence is distinct from a reviewed empty tag array', () => {
  for (const value of [undefined, null, '', ['milk', null]]) {
    const result = calculate(recipe(), [ingredient({ allergens: value })]);
    assert.equal(result.nutrition_complete, true);
    assert.equal(result.allergens_complete, false);
    assert.ok(result.allergens_warnings.length > 0);
  }
  const reviewed = calculate();
  assert.equal(reviewed.allergens_complete, true);
  assert.deepEqual(reviewed.allergens, []);
  assert.deepEqual(reviewed.allergens_warnings, []);
});

test('explicit declarations survive while generated tags refresh from ingredients', () => {
  const explicit = recipe({ declared_allergens: ['soy'] });
  const initial = calculate(explicit, [ingredient({ allergens: ['milk'] })]);
  assert.deepEqual(initial.declared_allergens, ['soy']);
  assert.deepEqual(initial.allergens, ['milk', 'soy']);
  assert.deepEqual(initial.legacy_allergens, []);
  assert.equal(initial.allergens_complete, true);
  const refreshed = calculate({ ...explicit, ...initial }, [ingredient({ allergens: ['fish'] })]);
  assert.deepEqual(refreshed.allergens, ['fish', 'soy']);
  assert.deepEqual(refreshed.declared_allergens, ['soy']);
  const cleared = calculate({ ...explicit, ...initial, declared_allergens: [] }, [ingredient({ allergens: [] })]);
  assert.deepEqual(cleared.allergens, []);
});

test('legacy tags matching current ingredients are recalculated instead of becoming declarations', () => {
  const legacy = recipe({ allergens: ['milk'] });
  const first = calculate(legacy, [ingredient({ allergens: ['milk'] })]);
  assert.deepEqual(first.allergens, ['milk']);
  assert.deepEqual(first.declared_allergens, []);
  assert.deepEqual(first.legacy_allergens, []);
  assert.equal(first.allergens_complete, true);
  const refreshed = calculate({ ...legacy, ...first }, [ingredient({ allergens: ['fish'] })]);
  assert.deepEqual(refreshed.allergens, ['fish']);
  assert.deepEqual(refreshed.legacy_allergens, []);
  assert.equal(refreshed.allergens_complete, true);
});

test('unmatched legacy tags remain visible with an explicit review warning across saves', () => {
  const legacy = recipe({ allergens: ['soy'] });
  const first = calculate(legacy, [ingredient({ allergens: ['milk'] })]);
  assert.deepEqual(first.allergens, ['milk', 'soy']);
  assert.deepEqual(first.declared_allergens, []);
  assert.deepEqual(first.legacy_allergens, ['soy']);
  assert.equal(first.allergens_complete, false);
  assert.deepEqual(first.allergens_warnings, [
    'Previously saved allergen soy needs review; it is not present in current ingredient or declared allergen data.'
  ]);
  const refreshed = calculate({ ...legacy, ...first }, [ingredient({ allergens: ['fish'] })]);
  assert.deepEqual(refreshed.allergens, ['fish', 'soy']);
  assert.deepEqual(refreshed.legacy_allergens, ['soy']);
  assert.equal(refreshed.allergens_complete, false);
  const confirmed = calculate({ ...legacy, ...first, declared_allergens: ['soy'] }, [ingredient({ allergens: [] })]);
  assert.deepEqual(confirmed.allergens, ['soy']);
  assert.deepEqual(confirmed.legacy_allergens, []);
  assert.equal(confirmed.allergens_complete, true);
});

test('versioned records use legacy candidates instead of reviving generated tags', () => {
  const result = calculate(recipe({
    nutrition_calculation_version: 1, allergens: ['old-generated'], legacy_allergens: ['soy']
  }));
  assert.deepEqual(result.allergens, ['soy']);
  assert.deepEqual(result.legacy_allergens, ['soy']);
  assert.deepEqual(result.declared_allergens, []);
  assert.equal(result.allergens_complete, false);
});

test('nested declarations are not promoted into stale parent declarations', () => {
  const child = recipe({ id: 'child', declared_allergens: ['soy'] });
  const parent = recipe({ sub_recipes: [{ recipe_id: 'child', quantity: 1 }] });
  const first = calculate(parent, [ingredient()], [child]);
  assert.deepEqual(first.allergens, ['soy']);
  assert.deepEqual(first.declared_allergens, []);
  assert.deepEqual(first.legacy_allergens, []);
  const next = calculate({ ...parent, ...first }, [ingredient()],
    [{ ...child, nutrition_calculation_version: 1, declared_allergens: [], allergens: ['soy'] }]);
  assert.deepEqual(next.allergens, []);
});

test('nested legacy tags contribute warnings without becoming root legacy candidates', () => {
  const child = recipe({ id: 'child', allergens: ['soy'] });
  const parent = recipe({ sub_recipes: [{ recipe_id: 'child', quantity: 1 }] });
  const first = calculate(parent, [ingredient()], [child]);
  assert.deepEqual(first.allergens, ['soy']);
  assert.deepEqual(first.legacy_allergens, []);
  assert.deepEqual(first.declared_allergens, []);
  assert.equal(first.allergens_complete, false);
  assert.match(first.allergens_warnings[0], /Previously saved allergen soy needs review/);
  const removed = calculate({ ...parent, ...first, sub_recipes: [] }, [ingredient()], [child]);
  assert.deepEqual(removed.allergens, []);
  assert.equal(removed.allergens_complete, true);
});

test('empty recipes and invalid servings are explicitly incomplete', () => {
  assertUnknownNutrition(calculate(recipe({ ingredients: [] })));
  for (const servings of [0, -1, undefined, null, '']) {
    const result = calculate(recipe({ servings }));
    assert.equal(result.total_calories, 100);
    assert.equal(result.calories_per_serving, null);
    assert.equal(result.nutrition_complete, false);
  }
});

test('calculation does not mutate recipe lines, ingredient masters or site data', () => {
  const master = ingredient({ unit: 'l', raw_weight_per_unit: 1100, site_id: 'site-1' });
  const item = recipe({ ingredients: [line({ unit: 'l', quantity: 1 })], location_id: 'location-1' });
  const before = JSON.stringify({ master, item });
  calculate(item, [master], [item]);
  assert.equal(JSON.stringify({ master, item }), before);
});
