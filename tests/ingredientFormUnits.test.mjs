import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeIngredientUnit } from '../shared/ingredientUnits.js';

const form = readFileSync(new URL('../src/components/ingredients/IngredientForm.jsx', import.meta.url), 'utf8');
const conversionField = form.slice(
  form.indexOf('<Label htmlFor="conversion_unit">'),
  form.indexOf('<Label htmlFor="conversion_factor">')
);

test('conversion unit uses the same unit options and dropdown as base unit', () => {
  assert.match(conversionField, /<Select\s/);
  assert.doesNotMatch(conversionField, /<Input\s/);
  assert.match(conversionField, /<SelectTrigger id="conversion_unit"/);
  assert.match(conversionField, /UNITS\.map\(unit =>/);
  assert.match(conversionField, /value=\{conversionUnit \|\| NO_CONVERSION_UNIT\}/);
});

test('existing standard aliases are normalized while custom units remain selectable', () => {
  for (const [saved, expected] of [['gram', 'g'], ['Grams', 'g'], ['liter', 'l'], ['pcs', 'pieces'], ['EA', 'ea'], ['PAK', 'pak'], ['Case', 'cs'], ['BDL', 'bdl']]) {
    assert.equal(normalizeIngredientUnit(saved), expected);
  }
  assert.match(form, /label: 'CT \(Count\)'/);
  assert.match(form, /label: 'EA \(Each\)'/);
  assert.match(form, /label: 'PAK \(Pack\)'/);
  assert.match(form, /label: 'CS \(Case\)'/);
  assert.match(form, /label: 'BDL'/);
  assert.match(form, /normalizeIngredientUnit\(formData\.conversion_unit\)/);
  assert.match(form, /UNITS\.some\(unit => unit\.value === formData\.conversion_unit\)/);
  assert.match(form, /UNITS\.some\(unit => unit\.value === normalizedConversionUnit\)/);
  assert.match(conversionField, /conversionUnit && !isStandardConversionUnit/);
  assert.match(conversionField, /<SelectItem value=\{conversionUnit\}>/);
  assert.match(form, /conversion_unit: conversionUnit,/);
});

test('optional conversion can be cleared without invalid empty Radix options', () => {
  assert.match(form, /const NO_CONVERSION_UNIT = '__no_conversion__';/);
  assert.match(conversionField, /<SelectItem value=\{NO_CONVERSION_UNIT\}>No conversion/);
  assert.doesNotMatch(conversionField, /<SelectItem value=['"]{2}/);
  assert.match(conversionField, /conversion_unit: value === NO_CONVERSION_UNIT \? '' : value/);
  assert.match(conversionField, /conversion_factor: value === NO_CONVERSION_UNIT \? '' : prev\.conversion_factor/);
});
