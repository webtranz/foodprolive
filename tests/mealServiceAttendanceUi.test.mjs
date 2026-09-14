import assert from 'node:assert/strict';
import {
  buildMealServiceConfirmationRequest,
  buildMealServicePortionRequest,
  formatMealWeight,
  getDinerScanHeadcount,
  normalizeMealServiceCovers,
  normalizeMealServicePortionSize,
  validateMealServiceCovers
} from '../src/lib/mealServiceAttendance.js';

const scope = {
  site_id: 'project-1',
  service_date: '2026-09-03',
  meal_type: 'lunch',
  menu_type: 'general',
  menu_category: 'senior'
};
const dishes = [
  {
    recipe_id: 'dish-1',
    recipe_name: 'Rice',
    available_covers: 20,
    service_portion_size_grams: 200,
    batches: [{ id: 'batch-1' }, { id: 'batch-2' }]
  },
  { recipe_id: 'dish-2', recipe_name: 'Chicken', available_covers: 12, service_portion_size_grams: 250 }
];

assert.equal(normalizeMealServiceCovers('0'), 0);
assert.equal(normalizeMealServiceCovers('12'), 12);
assert.equal(normalizeMealServiceCovers('2.5'), null);
assert.equal(normalizeMealServiceCovers('-1'), null);
assert.equal(normalizeMealServiceCovers(''), null);
assert.equal(normalizeMealServicePortionSize('250.50'), 250.5);
assert.equal(normalizeMealServicePortionSize('0'), null);
assert.equal(normalizeMealServicePortionSize('100001'), null);

assert.deepEqual(
  buildMealServiceConfirmationRequest(
    scope,
    dishes,
    { 'dish-1': '15', 'dish-2': '0' },
    'request-1',
    ' availability-snapshot-1 '
  ),
  {
    idempotency_key: 'request-1',
    availability_snapshot: 'availability-snapshot-1',
    ...scope,
    dishes: [
      { recipe_id: 'dish-1', covers: 15 },
      { recipe_id: 'dish-2', covers: 0 }
    ]
  }
);
assert.deepEqual(buildMealServicePortionRequest(scope, dishes[0], '225.5'), {
  ...scope,
  recipe_id: 'dish-1',
  produced_item_batch_ids: ['batch-1', 'batch-2'],
  service_portion_size_grams: 225.5
});

assert.equal(validateMealServiceCovers(dishes, { 'dish-1': 15, 'dish-2': 0 }).valid, true);
assert.match(validateMealServiceCovers([
  { recipe_id: 'dish-1', recipe_name: 'Rice', available_covers: null, service_portion_size_grams: null }
], { 'dish-1': 1 }).message, /administrator-saved service portion size/);
assert.match(validateMealServiceCovers([
  { recipe_id: 'dish-1', recipe_name: 'Rice', available_covers: null, service_portion_size_grams: 200 }
], { 'dish-1': 1 }).message, /does not have a valid available-cover balance/);
assert.match(validateMealServiceCovers(dishes, { 'dish-1': '', 'dish-2': 0 }).message, /whole-number cover count/);
assert.match(validateMealServiceCovers(dishes, { 'dish-1': 0, 'dish-2': 0 }).message, /at least one cover/);
assert.match(validateMealServiceCovers(dishes, { 'dish-1': 21, 'dish-2': 0 }).message, /only 20 covers available/);

assert.equal(formatMealWeight(250), '250 g');
assert.equal(formatMealWeight(1250), '1.25 kg');
assert.equal(formatMealWeight(12.5), '12.5 g');
assert.equal(getDinerScanHeadcount([
  { guest_token: 'legacy-one' },
  { guest_token: 'aggregate', attendee_count: 12 }
]), 13);

console.log('PASS production-only Meal Service frontend helpers');
