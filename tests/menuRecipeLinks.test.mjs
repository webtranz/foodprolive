import assert from 'node:assert/strict';
import { resolveMenuRecipeLinks } from '../shared/menuRecipeLinks.js';
import { buildDailyMenuState, summarizeMenuCalendarDay } from '../src/lib/menuPlanning.js';
import { buildMenuPlanIssueItems } from '../src/lib/productionIssue.js';

const sites = [
  { id: 'project' },
  { id: 'store-a', parent_site_id: 'project' },
  { id: 'store-b', parent_site_id: 'project' }
];
const recipe = {
  id: 'current-id', recipe_code: 'RCP-011-BOILEDEGGS-KBR384 V3',
  name: 'Boiled Eggs KBR-384 ONEGO', cuisine_type: 'general',
  site_scope: 'specific', site_ids: ['store-a'], servings: 100
};
const plan = {
  id: 'menu', site_id: 'store-a', cuisine_type: 'general',
  meals: [{ meal_type: 'breakfast', recipe_id: '', recipe_code: recipe.recipe_code, expected_servings: 1 }]
};
const linked = resolveMenuRecipeLinks(plan, [recipe], sites);
assert.equal(linked.meals[0].recipe_id, 'current-id');
assert.equal(linked.meals[0].expected_servings, 1);
assert.equal(plan.meals[0].recipe_id, '', 'read resolution must not mutate saved data');
assert.equal(buildDailyMenuState(linked).breakfast[0].recipe_id, 'current-id');
assert.equal(summarizeMenuCalendarDay({ plan: linked }).complete_items, 1);
assert.equal(buildMenuPlanIssueItems(linked, { recipes: [recipe] }).length, 1);
const stale = { ...plan, meals: [{ ...plan.meals[0], recipe_id: 'deleted-id' }] };
assert.equal(resolveMenuRecipeLinks(stale, [recipe], sites).meals[0].recipe_id, recipe.id);
const missing = resolveMenuRecipeLinks(plan, [], sites);
assert.equal(missing.meals[0].recipe_link_status, 'missing');
assert.equal(resolveMenuRecipeLinks(missing, [recipe], sites).meals[0].recipe_link_status, 'linked', 'uploading recipes later must restore links');
assert.equal(resolveMenuRecipeLinks(plan, [{ ...recipe, site_ids: ['store-b'] }], sites).meals[0].recipe_link_status, 'missing');
assert.equal(resolveMenuRecipeLinks(plan, [{ ...recipe, site_ids: ['project'] }], sites).meals[0].recipe_link_status, 'linked');
assert.equal(resolveMenuRecipeLinks({ ...plan, cuisine_type: 'philippines' }, [recipe], sites).meals[0].recipe_link_status, 'linked', 'Filipino menus may explicitly reference shared general recipes');
const ambiguous = resolveMenuRecipeLinks(plan, [recipe, { ...recipe, id: 'duplicate-id' }], sites);
assert.equal(ambiguous.meals[0].recipe_link_status, 'ambiguous');
assert.equal(buildMenuPlanIssueItems(ambiguous, { recipes: [recipe] }).length, 0);
assert.equal(summarizeMenuCalendarDay({ plan: ambiguous }).incomplete_items, 1);
const legacy = { ...recipe, recipe_code: 'RCP-011-BOILEDEGGS-KBR384 ONEGO V3' };
assert.equal(resolveMenuRecipeLinks(plan, [legacy], sites).meals[0].recipe_link_status, 'linked');
console.log('Menu recipe linkage regression tests passed.');
