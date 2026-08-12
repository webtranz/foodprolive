import assert from 'node:assert/strict';
import {
  MAX_RECIPE_IMAGE_BYTES,
  validateRecipeImageFile
} from '../shared/recipeImage.js';

assert.equal(validateRecipeImageFile({ type: 'image/jpeg', size: MAX_RECIPE_IMAGE_BYTES }), '');
assert.match(
  validateRecipeImageFile({ type: 'image/png', size: MAX_RECIPE_IMAGE_BYTES + 1 }),
  /1 MB/
);
assert.match(validateRecipeImageFile({ type: 'image/svg+xml', size: 100 }), /JPG/);
assert.match(validateRecipeImageFile(null), /Select/);

console.log('Recipe image validation tests passed.');
