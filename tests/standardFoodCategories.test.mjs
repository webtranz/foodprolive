import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const expected = [
  'Starter / Salad / Soup',
  'Main Course',
  'Vegetable',
  'Dessert',
  'Beverages',
  'Side Dish'
];

const files = [
  'src/pages/FoodCategories.jsx',
  'src/pages/Recipes.jsx',
  'src/pages/MenuBuilder.jsx',
  'src/components/recipes/RecipeForm.jsx',
  'src/components/ai/AIRecipeGenerator.jsx'
];

files.forEach((file) => {
  const source = read(file);
  expected.forEach((category) => {
    assert.match(source, new RegExp(category.replace(/\//g, '\\/')), `${file} includes ${category}`);
  });
});

const recipeForm = read('src/components/recipes/RecipeForm.jsx');
assert.doesNotMatch(recipeForm, /placeholder="e\.g\., lunch"/);
assert.match(recipeForm, /<Select value=\{formData\.category \|\| 'main_course'\}/);

console.log('PASS standard food categories are wired across recipe category surfaces');
