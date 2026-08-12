import assert from 'node:assert/strict';
import {
  createTemplateCsv,
  listUtilityModules,
  mapCsvRow,
  parseCsvLine,
  validateCsvHeaders
} from '../server/utilities.js';

assert.deepEqual(parseCsvLine('"Shrimp, frozen",43,"dairy|seafood"'), ['Shrimp, frozen', '43', 'dairy|seafood']);
assert.match(createTemplateCsv('recipes'), /^name,/);
assert.equal(listUtilityModules().some((module) => module.key === 'recipes'), true);
assert.deepEqual(validateCsvHeaders('recipes', ['recipe_code']), ['Missing required column: name']);

const recipe = mapCsvRow(
  'recipes',
  ['name', 'servings', 'image_url', 'allergens'],
  ['Secure Recipe', '4', 'https://cdn.example.com/recipes/secure.jpg', '["dairy"]']
);
assert.equal(recipe.name, 'Secure Recipe');
assert.equal(recipe.servings, 4);
assert.equal(recipe.image_url, 'https://cdn.example.com/recipes/secure.jpg');
assert.deepEqual(recipe.allergens, ['dairy']);
assert.throws(
  () => mapCsvRow('recipes', ['name', 'image_url'], ['Unsafe Recipe', 'http://example.com/image.jpg']),
  /HTTPS/
);

console.log('Utilities template and CSV validation tests passed.');
