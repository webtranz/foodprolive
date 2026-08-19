import { pool } from './db.js';
import { getItemCodeFromRecords } from '../shared/itemCode.js';

function uniqueIngredientIds(items = []) {
  return [...new Set(
    items
      .map((item) => String(item?.ingredient_id || '').trim())
      .filter(Boolean)
  )];
}

export async function enrichIngredientItemCodes(items = [], executor = pool) {
  const sourceItems = Array.isArray(items) ? items : [];
  const ingredientIds = uniqueIngredientIds(sourceItems);
  if (!ingredientIds.length) {
    return sourceItems.map((item) => ({
      ...item,
      item_code: getItemCodeFromRecords([item], null)
    }));
  }

  const result = await executor.query(
    `SELECT id, data
     FROM entity_records
     WHERE entity_name = 'Ingredient'
       AND id = ANY($1::text[])`,
    [ingredientIds]
  );
  const ingredientsById = new Map(
    result.rows.map((row) => [String(row.id), row.data || {}])
  );

  return sourceItems.map((item) => ({
    ...item,
    item_code: getItemCodeFromRecords([
      ingredientsById.get(String(item?.ingredient_id || '')),
      item
    ], null)
  }));
}

export async function enrichRecordsWithIngredientItemCodes(records = [], executor = pool) {
  const sourceRecords = Array.isArray(records) ? records : [];
  const flatItems = sourceRecords.flatMap((record) => (
    Array.isArray(record?.items) ? record.items : []
  ));
  const enrichedItems = await enrichIngredientItemCodes(flatItems, executor);
  let itemOffset = 0;

  return sourceRecords.map((record) => {
    const itemCount = Array.isArray(record?.items) ? record.items.length : 0;
    const items = enrichedItems.slice(itemOffset, itemOffset + itemCount);
    itemOffset += itemCount;
    return { ...record, items };
  });
}
