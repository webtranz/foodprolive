import assert from 'node:assert/strict';

import {
  MAX_RECIPE_IMAGE_BYTES,
  validateRecipeImageFile,
  validateRecipeImageReference,
  validateSecureImageUrl
} from '../shared/recipeImage.js';

assert.equal(validateRecipeImageFile({ type: 'image/jpeg', size: MAX_RECIPE_IMAGE_BYTES }), '');
assert.match(
  validateRecipeImageFile({ type: 'image/png', size: MAX_RECIPE_IMAGE_BYTES + 1 }),
  /1 MB/
);
assert.match(validateRecipeImageFile({ type: 'image/svg+xml', size: 100 }), /JPG/);
assert.match(validateRecipeImageFile(null), /Select/);
assert.equal(validateSecureImageUrl('https://cdn.example.com/recipes/image.webp'), '');
assert.equal(validateRecipeImageReference('/uploads/recipe-image.jpg'), '');
assert.equal(validateRecipeImageReference('/uploads/recipe-abc.png'), '');
assert.match(validateSecureImageUrl('http://cdn.example.com/image.jpg'), /HTTPS/);
assert.match(validateSecureImageUrl('https://user:secret@cdn.example.com/image.jpg'), /credentials/);
assert.match(validateSecureImageUrl('https://localhost/image.jpg'), /public/);
assert.match(validateSecureImageUrl('https://127.0.0.1/image.jpg'), /public/);
assert.match(validateSecureImageUrl('https://192.168.1.25/image.jpg'), /public/);
assert.match(validateSecureImageUrl('https://[fd00::1]/image.jpg'), /public/);

console.log('Recipe image validation tests passed.');
