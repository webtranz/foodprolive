import assert from 'node:assert/strict';
import { normalizeAllergenTags } from '../shared/allergens.js';

assert.deepEqual(normalizeAllergenTags(['["fish"]', 'fish', ' gluten ']), ['fish', 'gluten']);
assert.deepEqual(normalizeAllergenTags('["milk","wheat"]'), ['milk', 'wheat']);
assert.deepEqual(normalizeAllergenTags('[\"milk\",\"wheat\"]'), ['milk', 'wheat']);
assert.deepEqual(normalizeAllergenTags('fish|gluten, wheat'), ['fish', 'gluten', 'wheat']);
assert.deepEqual(normalizeAllergenTags(['none', '', null, undefined]), []);

console.log('Allergen normalization tests passed.');
