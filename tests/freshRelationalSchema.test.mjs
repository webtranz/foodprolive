import assert from 'node:assert/strict';
import fs from 'node:fs';

const initSql = fs.readFileSync(new URL('../server/sql/init.sql', import.meta.url), 'utf8');

assert.doesNotMatch(
  initSql,
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+entity_records/i,
  'fresh schema must not create a persistent entity_records JSON table'
);
assert.match(
  initSql,
  /DROP\s+TABLE\s+IF\s+EXISTS\s+public\.entity_records\s+CASCADE/i,
  'fresh schema should remove any old persistent entity_records table before startup'
);
assert.doesNotMatch(
  initSql,
  /CREATE\s+TEMP\s+TABLE\s+IF\s+NOT\s+EXISTS\s+entity_records/i,
  'fresh schema should not create a temporary entity_records compatibility table'
);
assert.doesNotMatch(
  initSql,
  /\b(payload|data)\s+JSONB\b/i,
  'persistent normalized tables should not define payload/data JSONB storage columns'
);

for (const tableName of [
  'ingredient_details',
  'ingredient_nutrition_profiles',
  'ingredient_allergen_tags',
  'ingredient_aliases',
  'ingredient_stock_summaries'
]) {
  assert.match(
    initSql,
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\b`, 'i'),
    `${tableName} should be part of the normalized ingredient schema`
  );
}

console.log('Fresh relational schema tests passed.');
