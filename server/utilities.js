import { validateEntityPayload } from './entities.js';
import { normalizeRecipeImageReference, validateRecipeImageReference } from '../shared/recipeImage.js';
import { isIngredientUnitCompatible, normalizeIngredientUnit } from '../shared/ingredientUnits.js';
import { inferPackageFields } from '../shared/packageUnits.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../shared/siteHierarchy.js';
import { normalizeProductionMenuScope } from '../shared/menuCategories.js';
import { normalizeSourceName } from '../shared/sourceNames.js';
import { normalizeAllergenTags } from '../shared/allergens.js';

const commonSiteFields = ['site_id', 'site_name'];

export const utilityModules = Object.freeze({
  sites: {
    label: 'Areas, Projects & Stores',
    entity: 'Site',
    required: ['name'],
    headers: ['name', 'project_code', 'type', 'hierarchy_level', 'parent_site_id', 'parent_site_name', 'area_name', 'project_name', 'store_name', 'region_name', 'location_name', 'storage_name', 'address', 'city', 'country', 'capacity', 'contact_person', 'contact_phone', 'contact_email', 'is_active']
  },
  'food-categories': {
    label: 'Food Categories',
    entity: 'FoodCategory',
    required: ['name'],
    headers: ['name', 'code', 'description', 'color', 'status']
  },
  ingredients: {
    label: 'Ingredients',
    entity: 'Ingredient',
    required: ['name'],
    headers: ['item_code', 'name', 'source_name', 'ingredient_code', 'sku', 'alias', 'aliases', 'supplier_item_name', 'unit', 'conversion_unit', 'conversion_factor', 'category', 'cuisine_type', 'cost_per_unit', 'supplier', 'package_base_quantity', 'package_base_unit', 'calories_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g', 'sodium_per_100g', 'sugar_per_100g', 'cooking_yield_percent', 'shrinkage_percent', 'raw_weight_per_unit', 'cooked_weight_per_unit', 'allergens', 'is_active']
  },
  recipes: {
    label: 'Recipes',
    entity: 'Recipe',
    required: ['name'],
    headers: ['name', 'recipe_code', 'description', 'recipe_type', 'cuisine_type', 'category', 'servings', 'portion_size_grams', 'ingredients', 'sub_recipes', 'instructions', 'prep_time_minutes', 'cook_time_minutes', 'allergens', 'site_scope', 'site_ids', 'site_names', 'image_url', 'is_active']
  },
  inventory: {
    label: 'Inventory',
    entity: 'Inventory',
    required: ['quantity'],
    headers: [
      'item_code',
      'ingredient_name',
      ...commonSiteFields,
      'ingredient_id',
      'quantity',
      'unit',
      'unit_cost',
      'batch_number',
      'stock_date',
      'expiry_date',
      'reference_id',
      'notes',
      'min_stock_level',
      'max_stock_level',
      'valuation_method'
    ]
  },
  'menu-plans': {
    label: 'Menu Plans',
    entity: 'MenuPlan',
    required: ['plan_date'],
    headers: [...commonSiteFields, 'plan_date', 'cuisine_type', 'menu_category', 'status', 'event_name', 'event_date', 'expected_participants', 'budget_amount', 'meals', 'notes']
  },
  production: {
    label: 'Production',
    entity: 'Production',
    required: ['production_date', 'menu_type', 'menu_category'],
    headers: [...commonSiteFields, 'fulfillment_store_id', 'fulfillment_store_name', 'production_date', 'recipe_id', 'recipe_name', 'meal_type', 'menu_type', 'menu_category', 'target_servings', 'actual_servings', 'status', 'estimated_cost', 'actual_cost', 'ingredients_used', 'notes']
  },
  'material-requests': {
    label: 'Material Requests',
    entity: 'MaterialRequest',
    required: [],
    headers: [...commonSiteFields, 'request_number', 'production_id', 'production_name', 'request_date', 'required_date', 'status', 'items', 'notes']
  },
  suppliers: {
    label: 'Suppliers',
    entity: 'Supplier',
    required: ['name'],
    headers: ['name', 'supplier_code', 'contact_person', 'email', 'phone', 'address', 'city', 'country', 'status', 'categories', 'notes']
  },
  'food-waste': {
    label: 'Food Waste',
    entity: 'FoodWaste',
    required: ['waste_date'],
    headers: [...commonSiteFields, 'waste_date', 'meal_type', 'waste_category', 'reason_code', 'reason', 'avoidable_type', 'ingredient_id', 'ingredient_name', 'recipe_id', 'recipe_name', 'production_id', 'production_name', 'quantity', 'unit', 'estimated_cost', 'status', 'notes']
  },
  attendance: {
    label: 'Attendance Records',
    entity: 'AttendanceRecord',
    required: [],
    headers: [...commonSiteFields, 'employee_id', 'employee_name', 'attendance_date', 'check_in', 'check_out', 'attendance_status', 'approval_status', 'notes']
  },
  'quality-control': {
    label: 'Quality Control',
    entity: 'QualityControl',
    required: [],
    headers: [...commonSiteFields, 'inspection_date', 'production_id', 'batch_id', 'inspector_name', 'status', 'temperature', 'score', 'findings', 'corrective_action', 'notes']
  }
});

const JSON_FIELDS = new Set([
  'allergens', 'ingredients', 'sub_recipes', 'site_ids', 'site_names', 'meals',
  'ingredients_used', 'items', 'categories', 'approval_history'
]);
const BOOLEAN_FIELDS = new Set(['is_active', 'preventable', 'high_value']);
const NUMBER_FIELDS = new Set([
  'capacity', 'cost_per_unit', 'conversion_factor', 'package_base_quantity', 'package_pack_count',
  'package_inner_count', 'package_size_quantity', 'calories_per_100g', 'protein_per_100g',
  'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g', 'sodium_per_100g', 'sugar_per_100g',
  'cooking_yield_percent', 'shrinkage_percent', 'raw_weight_per_unit',
  'cooked_weight_per_unit', 'servings', 'portion_size_grams', 'prep_time_minutes', 'cook_time_minutes',
  'quantity', 'unit_cost', 'average_unit_cost', 'reorder_level',
  'min_stock_level', 'max_stock_level', 'expected_participants',
  'budget_amount', 'target_servings', 'actual_servings', 'estimated_cost',
  'actual_cost', 'score', 'temperature', 'source_amount', 'source_quantity'
]);

const HEADER_ALIASES = Object.freeze({
  recipes: {
    type: 'recipe_type',
    cuisine: 'cuisine_type'
  },
  ingredients: {
    ingredient_name: 'name',
    item_name: 'name',
    product_name: 'name',
    sku_code: 'sku',
    base_unit: 'unit',
    conversion_units_per_base_unit: 'conversion_factor',
    'aliases_/_alternative_names': 'aliases',
    item: 'item_code',
    item_duplicate: 'ingredient_code',
    item_group: 'category',
    unit_price: 'cost_per_unit',
    price: 'cost_per_unit',
    cal: 'calories_per_100g',
    'cal.': 'calories_per_100g',
    'cal/100g': 'calories_per_100g',
    calories: 'calories_per_100g',
    yield: 'cooking_yield_percent',
    'yield_%': 'cooking_yield_percent',
    protein: 'protein_per_100g',
    protien: 'protein_per_100g',
    car: 'carbs_per_100g',
    carb: 'carbs_per_100g',
    carbs: 'carbs_per_100g',
    fat: 'fat_per_100g',
    fiber: 'fiber_per_100g',
    sodium: 'sodium_per_100g',
    sugar: 'sugar_per_100g',
    quantity: 'quantity',
    qty: 'quantity',
    stock: 'quantity',
    stock_on_hand: 'quantity',
    on_hand: 'quantity',
    site_id: 'site_id',
    site_name: 'site_name',
    warehouse: 'site_name',
    store: 'site_name',
    location: 'site_name'
  },
  production: {
    cuisine_type: 'menu_type',
    menu_cuisine: 'menu_type',
    cuisine: 'menu_type'
  },
  inventory: {
    item: 'item_code',
    item_duplicate: 'source_item_duplicate',
    product_name: 'ingredient_name',
    qty: 'quantity',
    qty_duplicate: 'source_quantity',
    unit_price: 'unit_cost',
    price: 'unit_cost',
    amount: 'source_amount',
    warehouse: 'source_warehouse',
    site: 'source_site',
    item_group: 'source_item_group'
  }
});

export function getUtilityModule(moduleKey) {
  return utilityModules[moduleKey] || null;
}

export function listUtilityModules() {
  return Object.entries(utilityModules).map(([key, definition]) => ({
    key,
    label: definition.label,
    entity: definition.entity,
    required: definition.required,
    headers: definition.headers
  }));
}

export function createTemplateCsv(moduleKey) {
  const definition = getUtilityModule(moduleKey);
  if (!definition) return null;
  return `${definition.headers.join(',')}\n`;
}

export function resolveBulkUploadSourceName(job = {}, payload = {}) {
  const selectedSource = normalizeSourceName(job.source_name, '');
  const rowSource = normalizeSourceName(payload.source_name, '');
  return job.entity_name === 'Ingredient'
    ? rowSource || selectedSource
    : selectedSource || rowSource;
}

export function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

function normalizeHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseCell(field, value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return undefined;
  if (field === 'aliases') {
    if (/^[\[{]/.test(trimmed)) {
      let aliases;
      try {
        aliases = JSON.parse(trimmed);
      } catch {
        throw new Error('aliases must be a comma/pipe-separated list or a JSON array of strings');
      }
      if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string')) {
        throw new Error('aliases must be a comma/pipe-separated list or a JSON array of strings');
      }
      return aliases.map((alias) => alias.trim()).filter(Boolean);
    }
    return trimmed.split(/[|,]/).map((alias) => alias.trim()).filter(Boolean);
  }
  if (field === 'allergens') {
    return normalizeAllergenTags(trimmed);
  }
  if (JSON_FIELDS.has(field)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.split('|').map((item) => item.trim()).filter(Boolean);
    }
  }
  if (BOOLEAN_FIELDS.has(field)) {
    return ['true', 'yes', '1', 'active'].includes(trimmed.toLowerCase());
  }
  if (NUMBER_FIELDS.has(field)) {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) throw new Error(`${field} must be a number`);
    if (field === 'conversion_factor' && number <= 0) {
      throw new Error('conversion_factor must be greater than zero');
    }
    return number;
  }
  return trimmed;
}

function buildHeaderMap(moduleKey, definition) {
  const entries = definition.headers.map((header) => [normalizeHeader(header), header]);
  const aliases = HEADER_ALIASES[moduleKey] || {};
  Object.entries(aliases).forEach(([alias, field]) => {
    entries.push([normalizeHeader(alias), field]);
  });
  return new Map(entries);
}

function normalizeIngredientUploadUnit(value) {
  const trimmed = String(value || '').trim();
  const standardUnits = new Set(['kg', 'g', 'lb', 'oz', 'm3', 'l', 'ml', 'pieces', 'ct', 'ea', 'pak']);
  if (/^ct\s*\(\s*count\s*\)$/i.test(trimmed)) return 'ct';
  if (/^ea\s*\(\s*each\s*\)$/i.test(trimmed)) return 'ea';
  if (/^pak\s*\(\s*pack\s*\)$/i.test(trimmed)) return 'pak';
  const displayLabel = trimmed.match(/^(.*?)\s*\(([^)]+)\)$/);
  if (displayLabel) {
    const symbol = normalizeIngredientUnit(displayLabel[2]);
    if (standardUnits.has(symbol)) return symbol;
  }
  const normalized = normalizeIngredientUnit(trimmed);
  // Keep canonical legacy spellings such as EA and custom units unchanged.
  return standardUnits.has(normalized) || normalized !== trimmed.toLowerCase() ? normalized : trimmed;
}

function normalizeMappedPayload(moduleKey, payload) {
  if (moduleKey === 'recipes' && payload.recipe_type && !payload.cuisine_type) {
    payload.cuisine_type = payload.recipe_type;
  }
  if (moduleKey === 'recipes' && payload.recipe_type) {
    delete payload.recipe_type;
  }
  if (moduleKey === 'ingredients' && !payload.item_code) {
    payload.item_code = payload.ingredient_code || payload.sku || undefined;
  }
  if (moduleKey === 'ingredients') {
    ['unit', 'conversion_unit', 'package_base_unit'].forEach((field) => {
      if (payload[field]) payload[field] = normalizeIngredientUploadUnit(payload[field]);
    });
    if (payload.raw_weight_per_unit > 0 && payload.cooked_weight_per_unit > 0) {
      const yieldPercent = Number(((payload.cooked_weight_per_unit / payload.raw_weight_per_unit) * 100).toFixed(1));
      if (Number.isFinite(yieldPercent)) {
        if (payload.cooking_yield_percent === undefined) payload.cooking_yield_percent = yieldPercent;
        if (payload.shrinkage_percent === undefined) {
          payload.shrinkage_percent = Number((100 - payload.cooking_yield_percent).toFixed(1));
        }
      }
    }
    Object.assign(payload, inferPackageFields(payload));
  }
  if (moduleKey === 'inventory' && !payload.unit_cost && payload.unit_price) {
    payload.unit_cost = payload.unit_price;
  }
  if (moduleKey === 'production') {
    return normalizeProductionMenuScope(payload, { required: true });
  }
  return payload;
}

export function mapCsvRow(moduleKey, headers, values) {
  const definition = getUtilityModule(moduleKey);
  if (!definition) throw new Error('Unknown bulk upload module.');
  const canonicalHeaders = buildHeaderMap(moduleKey, definition);
  const payload = {};
  headers.forEach((header, index) => {
    const field = canonicalHeaders.get(normalizeHeader(header));
    if (!field) return;
    const parsed = parseCell(field, values[index]);
    if (parsed !== undefined) payload[field] = parsed;
  });
  definition.required.forEach((field) => {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      throw new Error(`${field} is required`);
    }
  });
  if (moduleKey === 'inventory' && !payload.item_code && !payload.ingredient_id) {
    throw new Error('item_code or ingredient_id is required');
  }
  const normalizedPayload = normalizeMappedPayload(moduleKey, payload);
  if (definition.entity === 'Recipe' && normalizedPayload.image_url) {
    normalizedPayload.image_url = normalizeRecipeImageReference(normalizedPayload.image_url);
    const imageError = validateRecipeImageReference(normalizedPayload.image_url);
    if (imageError) throw new Error(imageError);
  }
  const validatedPayload = validateEntityPayload(definition.entity, normalizedPayload);
  if (moduleKey === 'ingredients') {
    // Blank upload cells must not replace existing values with create-time defaults.
    ['source_name', 'allergens', 'is_active'].forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(normalizedPayload, field)) delete validatedPayload[field];
    });
  }
  return validatedPayload;
}

export function validateCsvHeaders(moduleKey, headers) {
  const definition = getUtilityModule(moduleKey);
  if (!definition) return ['Unknown bulk upload module.'];
  const incoming = new Set(headers.map(normalizeHeader));
  const aliases = HEADER_ALIASES[moduleKey] || {};
  const hasIncomingField = (field) => incoming.has(normalizeHeader(field))
    || Object.entries(aliases).some(([alias, target]) => (
      target === field && incoming.has(normalizeHeader(alias))
    ));
  const errors = definition.required
    .filter((field) => !hasIncomingField(field))
    .map((field) => `Missing required column: ${field}`);
  if (
    moduleKey === 'inventory'
    && !hasIncomingField('item_code')
    && !hasIncomingField('ingredient_id')
  ) {
    errors.unshift('Missing required column: item_code or ingredient_id');
  }
  return errors;
}

export function buildIngredientPayloadFromInventoryUpload(payload = {}) {
  const itemCode = String(payload.item_code || '').trim();
  const name = String(payload.ingredient_name || '').trim();
  const unit = String(payload.unit || '').trim();
  if (!itemCode || !name || !unit) return null;
  return validateEntityPayload('Ingredient', {
    item_code: itemCode,
    ingredient_code: payload.source_item_duplicate || itemCode,
    sku: itemCode,
    name,
    unit,
    category: payload.source_item_group || null,
    cost_per_unit: payload.unit_cost ?? 0,
    ...inferPackageFields({ ...payload, name, supplier_item_name: name, unit }),
    is_active: true,
    allergens: []
  });
}

function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase();
}

function getIngredientItemCodes(ingredient = {}) {
  return [
    ingredient.item_code,
    ingredient.ingredient_code,
    ingredient.sku,
    ingredient.d365_item_id
  ].map(normalizeLookup).filter(Boolean);
}

/**
 * Resolve an inventory-upload ingredient by Item Code first, while retaining
 * support for stable ingredient IDs. When both are supplied they must identify
 * the same active ingredient; this prevents a stale ID from receiving stock
 * intended for a different SKU.
 */
export function resolveBulkInventoryIngredient({
  ingredients = [],
  itemCode = '',
  ingredientId = ''
} = {}) {
  const normalizedCode = normalizeLookup(itemCode);
  const normalizedId = normalizeLookup(ingredientId);
  if (!normalizedCode && !normalizedId) {
    const error = new Error('Inventory upload rows require item_code or ingredient_id.');
    error.status = 400;
    throw error;
  }

  const idMatch = normalizedId
    ? ingredients.find((ingredient) => normalizeLookup(ingredient?.id) === normalizedId) || null
    : null;
  if (normalizedId && !idMatch) {
    const error = new Error(`Ingredient ID "${ingredientId}" was not found.`);
    error.status = 404;
    throw error;
  }

  const codeMatches = normalizedCode
    ? ingredients.filter((ingredient) => getIngredientItemCodes(ingredient).includes(normalizedCode))
    : [];
  if (normalizedCode && codeMatches.length === 0) {
    const error = new Error(`Item Code "${itemCode}" was not found.`);
    error.status = 404;
    throw error;
  }
  if (codeMatches.length > 1) {
    const error = new Error(`Item Code "${itemCode}" is assigned to multiple ingredients.`);
    error.status = 409;
    throw error;
  }

  const codeMatch = codeMatches[0] || null;
  if (idMatch && codeMatch && String(idMatch.id) !== String(codeMatch.id)) {
    const error = new Error(`Item Code "${itemCode}" does not match Ingredient ID "${ingredientId}".`);
    error.status = 409;
    throw error;
  }

  const ingredient = codeMatch || idMatch;
  if (ingredient?.is_active === false) {
    const error = new Error(`Ingredient ${ingredient.name || ingredient.id} is inactive.`);
    error.status = 409;
    throw error;
  }
  return ingredient;
}

function findInventoryStore(sites = [], value = '') {
  const normalized = normalizeLookup(value);
  if (!normalized) return null;
  return sites.find((site) => (
    normalizeLookup(site?.id) === normalized
    || normalizeLookup(site?.name) === normalized
    || normalizeLookup(site?.project_code) === normalized
    || normalizeLookup(site?.hierarchy_path) === normalized
  )) || null;
}

/**
 * Resolve the stock-owning Store for a bulk inventory row.
 *
 * A value explicitly supplied by a row is authoritative: if it is invalid we
 * reject the row instead of silently routing the receipt to the job default.
 */
export function resolveBulkInventoryStore({
  sites = [],
  rowSiteId = '',
  rowSiteName = '',
  defaultSiteId = '',
  defaultSiteName = ''
} = {}) {
  const rowValue = String(rowSiteId || rowSiteName || '').trim();
  const defaultValue = String(defaultSiteId || defaultSiteName || '').trim();
  const targetValue = rowValue || defaultValue;
  const targetSource = rowValue ? 'uploaded row' : 'selected default';

  if (!targetValue) {
    const error = new Error('Inventory upload rows require an active Store or a valid default Store.');
    error.status = 400;
    throw error;
  }

  const store = findInventoryStore(sites, targetValue);
  if (!store) {
    const error = new Error(`The ${targetSource} inventory location "${targetValue}" was not found.`);
    error.status = 400;
    throw error;
  }
  if (store.is_active === false) {
    const error = new Error(`The ${targetSource} inventory Store "${store.name || store.id}" is inactive.`);
    error.status = 409;
    throw error;
  }
  if (normalizeSiteType(store.type) !== SITE_HIERARCHY_TYPES.STORE) {
    const error = new Error(`The ${targetSource} inventory location "${store.name || store.id}" must be a Store.`);
    error.status = 409;
    throw error;
  }

  return store;
}

/** Return the ingredient-master unit and reject incompatible row units. */
export function resolveBulkInventoryUnit(ingredient = {}, suppliedUnit = '') {
  const masterUnit = String(ingredient?.unit || '').trim();
  if (!masterUnit) {
    const error = new Error(`Ingredient ${ingredient?.name || ingredient?.id || '(unknown)'} has no canonical inventory unit.`);
    error.status = 409;
    throw error;
  }

  const requestedUnit = String(suppliedUnit || '').trim();
  if (
    requestedUnit
    && !isIngredientUnitCompatible(requestedUnit, masterUnit, ingredient)
  ) {
    const error = new Error(`Inventory quantity must use the ingredient's canonical unit (${masterUnit}).`);
    error.status = 409;
    throw error;
  }

  return masterUnit;
}

export function serializeReportRows(rows = []) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row || {}).filter(([key]) => !['password', 'password_hash', 'temporary_password'].includes(key))
  ));
}
