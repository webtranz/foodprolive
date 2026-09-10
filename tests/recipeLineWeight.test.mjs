import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { prepareRecipeLineWeights, bindProductionRecipeLineWeights } from '../server/recipeLineWeights.js';
import { prepareEntityPayload } from '../server/entityPreparation.js';
import { buildAutomaticProductionCompletionPlan } from '../server/inventory.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { calculateRecipeIngredientLineCost } from '../shared/recipeCosting.js';
import { expandRecipeIngredients } from '../shared/recipeComposition.js';
import { calculateFrozenProductionLineWeight } from '../shared/productionReconciliation.js';
import { getRecipeLineWeight } from '../shared/recipeLineWeight.js';
import { buildProductionIngredientSnapshot, buildProductionIngredientsForSubmit, recalculateProductionIngredientSnapshot, aggregateProductionIngredientLines } from '../src/lib/productionIssue.js';

const admin = { id: 'admin-1', role: 'admin' };
const manager = { id: 'pm-1', role: 'manager' };
const eggs = { id: 'eggs', name: 'Eggs 12/30 CT', unit: 'PAK', package_base_quantity: 30, package_base_unit: 'pieces', raw_weight_per_unit: 1, cooked_weight_per_unit: 1, cost_per_unit: 15 };
const original = { ingredient_id: eggs.id, ingredient_name: eggs.name, quantity: 0.2, unit: 'pieces' };
// Illustrative test weights only; no inventory or recipe data is populated.
const line = prepareRecipeLineWeights(admin, [{ ...original, weight_per_unit_grams: 50 }])[0];
const recipe = { id: 'dish', name: 'Egg dish', servings: 1, ingredients: [line] };
const weight = (item, catalog = [eggs]) => calculateRecipeServingWeight(item, [recipe], catalog);

test('admin defines a recipe-specific weight and the ingredient master remains unchanged', () => {
  assert.equal(line.weight_per_unit_grams, 50);
  assert.equal(line.weight_unit, 'pieces');
  assert.equal(line.weight_ingredient_id, eggs.id);
  assert.equal(line.weight_defined_by, admin.id);
  assert.ok(line.weight_defined_at);
  assert.equal(eggs.raw_weight_per_unit, 1);
  assert.equal(weight(recipe).raw_total_grams, 10);
  assert.equal(weight(recipe).is_complete, true);
  assert.equal(weight({ ...recipe, ingredients: [{ ...line, quantity: 20 }] }).raw_total_grams, 1000);
  assert.equal(weight({ ...recipe, ingredients: [original] }).is_complete, false);
});

test('non-admins may retain definitions but cannot create, change, clear or move them to another ingredient or unit', () => {
  assert.deepEqual(prepareRecipeLineWeights(manager, [{ ...line, quantity: 2, weight_defined_by: 'forged' }], [line])[0], { ...line, quantity: 2 });
  for (const attempted of [
    line,
    { ...line, weight_per_unit_grams: 55 },
    { ...line, weight_per_unit_grams: null },
    { ...line, weight_per_unit_grams: undefined },
    { ...line, ingredient_id: 'other' },
    { ...line, unit: 'EA' }
  ]) {
    const existing = attempted === line ? [] : [line];
    assert.throws(() => prepareRecipeLineWeights(manager, [attempted], existing), (error) => error.status === 403);
  }
  assert.equal(prepareRecipeLineWeights(manager, [original])[0].weight_per_unit_grams, undefined);
  assert.deepEqual(prepareRecipeLineWeights(manager, [], [line]), []);
  assert.equal(prepareRecipeLineWeights({ role: 'custom', role_access_level: 'admin' }, [{ ...original, weight_per_unit_grams: 51 }])[0].weight_per_unit_grams, 51);
  assert.throws(() => prepareRecipeLineWeights({ role: 'admin', role_access_level: 'manager' }, [line]), /Only administrators/);
});

test('invalid definitions are rejected and admins can clear a definition', () => {
  for (const value of [0, -1, 'abc', Infinity, NaN, 1e10]) {
    assert.throws(() => prepareRecipeLineWeights(admin, [{ ...original, weight_per_unit_grams: value }]), (error) => error.status === 400);
  }
  assert.equal(prepareRecipeLineWeights(admin, [{ ...line, weight_per_unit_grams: null }], [line])[0].weight_per_unit_grams, undefined);
  assert.throws(() => prepareRecipeLineWeights(admin, [{ ...line, unit: 'g' }]), /exact weight/);
  assert.equal(getRecipeLineWeight({ ...line, ingredient_id: 'different' }), null);
  assert.equal(getRecipeLineWeight({ ...line, unit: 'PAK' }), null);
});

test('partial prep exemption is validated and saved independently of admin line weights', () => {
  const partial = prepareRecipeLineWeights(manager, [{ ...original, prep_exempt_percent: 70.123 }])[0];
  assert.equal(partial.prep_exempt_percent, 70.12);
  const full = prepareRecipeLineWeights(manager, [{ ...original, exempt_processing_aid: true, prep_exempt_percent: 70 }])[0];
  assert.equal(full.exempt_processing_aid, true);
  assert.equal(full.prep_exempt_percent, undefined);
  for (const value of [-1, 0.5, 100, 'abc']) {
    assert.throws(() => prepareRecipeLineWeights(manager, [{ ...original, prep_exempt_percent: value }]), (error) => error.status === 400);
  }
});

test('client-supplied frozen totals cannot override a recipe definition', () => {
  const forged = { ...line, raw_weight_grams: 999, yielded_weight_grams: 999 };
  assert.equal(weight({ ...recipe, ingredients: [forged] }).raw_total_grams, 10);
  assert.equal(expandRecipeIngredients({ ...recipe, ingredients: [forged] }, [], [eggs]).ingredients[0].weight_per_unit_grams, 1500);
});

test('recipe-specific piece weight bridges kg stock for costing without changing inventory units', () => {
  const kilogramEggs = { ...eggs, unit: 'kg', cost_per_unit: 10 };
  const result = calculateRecipeIngredientLineCost(line, kilogramEggs);
  assert.equal(result.incompatible_unit, undefined);
  assert.ok(Math.abs(result.normalized_quantity - 0.01) < 1e-10);
  assert.ok(Math.abs(result.line_cost - 0.1) < 1e-10);
  const packed = calculateRecipeIngredientLineCost(line, eggs);
  assert.ok(Math.abs(packed.normalized_quantity - 0.2 / 30) < 1e-10);
  assert.equal(packed.line_cost, 0.1);
  assert.equal(calculateRecipeIngredientLineCost(original, kilogramEggs).incompatible_unit, true);
});

test('sub-recipes and aggregate production carry defined weights across scaling', () => {
  const parent = { servings: 2, sub_recipes: [{ recipe_id: recipe.id, quantity: 10, unit: 'servings' }] };
  assert.equal(weight(parent).raw_total_grams, 100);
  const expanded = expandRecipeIngredients(recipe, [], [eggs], { multiplier: 150 });
  assert.equal(expanded.ingredients[0].quantity, 1);
  assert.equal(expanded.ingredients[0].weight_per_unit_grams, 1500);
  assert.equal(expanded.ingredients[0].weight_unit, 'PAK');
  const snapshot = buildProductionIngredientSnapshot({ recipe, ingredients: [eggs], targetServings: 150 });
  const submitted = buildProductionIngredientsForSubmit(snapshot.lines);
  assert.equal(submitted[0].weight_per_unit_grams, 1500);
  assert.equal(calculateFrozenProductionLineWeight(submitted[0], eggs).raw_weight_grams, 1500);
  const zeroed = recalculateProductionIngredientSnapshot(snapshot.lines.map((item) => ({ ...item, raw_quantity: 0 })), { ingredients: [eggs] });
  assert.equal(calculateFrozenProductionLineWeight(zeroed.lines[0], eggs).raw_weight_grams, 0);
  const replacement = recalculateProductionIngredientSnapshot(snapshot.lines.map((item) => ({ ...item, ingredient_id: 'replacement' })), { ingredients: [{ ...eggs, id: 'replacement' }] });
  assert.equal(getRecipeLineWeight(replacement.lines[0]), null);
});

test('mixed dish definitions are aggregated by raw weight instead of reusing the first dish weight', () => {
  const another = prepareRecipeLineWeights(admin, [{ ...original, quantity: 30, weight_per_unit_grams: 60 }])[0];
  const first = { ...line, quantity: 30 };
  const expanded = expandRecipeIngredients({ ingredients: [first, another] }, [], [eggs]);
  assert.equal(expanded.ingredients[0].quantity, 2);
  assert.equal(expanded.ingredients[0].weight_per_unit_grams, 1650);
  const grouped = aggregateProductionIngredientLines([first, another].map((item) => ({ ...item, raw_quantity: item.quantity })), { ingredients: [eggs] });
  assert.equal(grouped[0].weight_per_unit_grams, 1650);
});

test('production uses authoritative recipe weights, ignoring forged client definitions and frozen totals', () => {
  const submitted = { ...line, raw_quantity: 2, weight_per_unit_grams: 999, raw_weight_grams: 99999, yielded_weight_grams: 99999 };
  const result = bindProductionRecipeLineWeights({ ingredients_used: [submitted] }, recipe, [recipe], [eggs]);
  assert.equal(result.ingredients_used[0].weight_per_unit_grams, 50);
  assert.equal(calculateFrozenProductionLineWeight(result.ingredients_used[0], eggs).raw_weight_grams, 100);
  const added = bindProductionRecipeLineWeights({ ingredients_used: [{ ...submitted, ingredient_id: 'new' }] }, recipe, [recipe], [eggs]);
  assert.equal(getRecipeLineWeight(added.ingredients_used[0]), null);
});

test('meal production preserves each dish definition and existing production keeps its frozen conversion', () => {
  const second = { ...recipe, id: 'second-dish', ingredients: prepareRecipeLineWeights(admin, [{ ...original, weight_per_unit_grams: 60 }]) };
  const postedLine = { ingredient_id: eggs.id, unit: 'PAK', raw_quantity: 1, weight_per_unit_grams: 999 };
  const production = {
    menu_issue_items: [
      { key: 'first', recipe_id: recipe.id, ingredients_used: [postedLine] },
      { key: 'second', recipe_id: second.id, ingredients_used: [postedLine] }
    ],
    ingredients_used: [{ ...postedLine, raw_quantity: 2 }]
  };
  const bound = bindProductionRecipeLineWeights(production, recipe, [recipe, second], [eggs]);
  assert.equal(bound.menu_issue_items[0].ingredients_used[0].weight_per_unit_grams, 1500);
  assert.ok(Math.abs(bound.menu_issue_items[1].ingredients_used[0].weight_per_unit_grams - 1800) < 1e-8);
  assert.equal(bound.ingredients_used[0].weight_per_unit_grams, 1650);
  assert.equal(calculateFrozenProductionLineWeight(bound.ingredients_used[0], eggs).raw_weight_grams, 3300);
  const editedRecipe = { ...recipe, ingredients: prepareRecipeLineWeights(admin, [{ ...original, weight_per_unit_grams: 70 }]) };
  const rebound = bindProductionRecipeLineWeights(production, editedRecipe, [editedRecipe, second], [eggs], bound);
  assert.equal(rebound.menu_issue_items[0].ingredients_used[0].weight_per_unit_grams, 1500);
  assert.equal(rebound.ingredients_used[0].weight_per_unit_grams, 1650);
});

test('full production preparation and completion retain the approved recipe-line weight', async () => {
  const site = { id: 'test-project', name: 'Test project', type: 'project' };
  const context = { scope: { unrestricted: true, accessibleSiteIds: new Set([site.id]), accessibleTreeIds: new Set([site.id]), sites: [site], graph: { byId: new Map([[site.id, site]]) } }, recipeCatalog: [recipe], ingredientCatalog: [eggs] };
  const snapshot = buildProductionIngredientSnapshot({ recipe, ingredients: [eggs], targetServings: 150 });
  const payload = { site_id: site.id, recipe_id: recipe.id, target_servings: 150, production_date: '2026-09-06', status: 'planned', menu_type: 'general', menu_category: 'senior' };
  for (const locked of [false, true]) {
    const saved = await prepareEntityPayload(manager, 'Production', {
      ...payload,
      ...(locked ? { recipe_snapshot_locked: true, recipe_snapshot_mode: 'production_only_override', ingredients_used: buildProductionIngredientsForSubmit(snapshot.lines) } : {})
    }, null, context);
    assert.equal(saved.recipe_raw_weight_grams, 1500);
    assert.equal(saved.expected_finished_weight_grams, 1500);
    assert.equal(saved.ingredients_used[0].weight_per_unit_grams, 1500);
    const completion = buildAutomaticProductionCompletionPlan({ production: saved, recipe, recipeCatalog: [recipe], ingredientCatalog: [eggs] });
    assert.equal(completion.ingredients_used[0].raw_weight_grams, 1500);
  }
});

test('all listed ambiguous food types support admin-defined weights without changing quantity or unit', () => {
  for (const [id, unit, grams] of [['bread', 'PAK', 400], ['bun', 'pieces', 60], ['tea', 'PAK', 200], ['tomato', 'EA', 2500], ['cheese', 'pieces', 20], ['chicken', 'pieces', 900]]) {
    const ingredient = { id, name: id, unit, raw_weight_per_unit: 1, cooked_weight_per_unit: 0.8 };
    const defined = prepareRecipeLineWeights(admin, [{ ingredient_id: id, unit, quantity: 2, weight_per_unit_grams: grams }])[0];
    const measured = weight({ servings: 1, ingredients: [defined] }, [ingredient]);
    assert.equal(measured.raw_total_grams, 2 * grams);
    assert.equal(measured.cooked_total_grams, 2 * grams * 0.8);
    assert.equal(defined.quantity, 2);
    assert.equal(defined.unit, unit);
  }
});

test('normal recipe API saves persist definitions and reject non-admin changes', async () => {
  const context = { scope: { unrestricted: true, sites: [] }, recipeCatalog: [], ingredientCatalog: [eggs], ingredientCostSnapshots: {} };
  const saved = await prepareEntityPayload(admin, 'Recipe', { ...recipe, site_scope: 'global' }, null, context);
  assert.equal(saved.total_raw_recipe_weight_grams, 10);
  await assert.rejects(() => prepareEntityPayload(manager, 'Recipe', { ingredients: [{ ...line, weight_per_unit_grams: 80 }] }, saved, context), (error) => error.status === 403);
  const retained = await prepareEntityPayload(manager, 'Recipe', { name: 'Renamed' }, saved, context);
  assert.equal(retained.ingredients[0].weight_per_unit_grams, 50);
});

test('UI exposes an accessible weight field and grey read-only controls for non-admins', () => {
  const form = readFileSync(new URL('../src/components/recipes/RecipeForm.jsx', import.meta.url), 'utf8');
  assert.match(form, /Weight per unit \(g\)/);
  assert.match(form, /disabled=\{!canEditLineWeights/);
  assert.match(form, /disabled:bg-slate-200/);
  assert.match(form, /if \(!canEditLineWeights\) return/);
  assert.match(form, /Exempt Processing Aid\./);
  assert.match(form, /% exempt during prep/);
  assert.match(form, /prep_exempt_percent/);
  assert.match(form, /max=\{99\.99\}/);
  assert.match(form, /exempt_processing_aid/);
  assert.match(form, /overflow-auto/);
});
