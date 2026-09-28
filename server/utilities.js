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
    headers: [
      'item_code',
      'name',
      'source_name',
      'ingredient_code',
      'sku',
      'alias',
      'aliases',
      'supplier_item_name',
      'unit',
      'conversion_unit',
      'conversion_factor',
      'category',
      'cuisine_type',
      'cost_per_unit',
      'supplier',
      'package_pack_count',
      'package_inner_count',
      'package_size_quantity',
      'package_size_unit',
      'package_base_quantity',
      'package_base_unit',
      'package_parse_source',
      'calories_per_100g',
      'protein_per_100g',
      'carbs_per_100g',
      'fat_per_100g',
      'fiber_per_100g',
      'sodium_per_100g',
      'sugar_per_100g',
      'cooking_yield_percent',
      'shrinkage_percent',
      'raw_weight_per_unit',
      'cooked_weight_per_unit',
      'allergens',
      'stock_summary',
      'created_date',
      'updated_date',
      'is_active'
    ]
  },
  recipes: {
    label: 'Recipes',
    entity: 'Recipe',
    required: ['name'],
    headers: [
      'recipe_code',
      'name',
      'description',
      'cuisine_type',
      'menu_category',
      'servings',
      'portion_size_grams',
      'batch_yield',
      'costing_method',
      'line_number',
      'ingredient_id',
      'item_code',
      'ingredient_code',
      'sku',
      'ingredient_name',
      'line_quantity',
      'line_unit',
      'line_yield_percent',
      'line_raw_weight_grams',
      'line_yielded_weight_grams',
      'line_cost',
      'instructions',
      'prep_time_minutes',
      'cook_time_minutes',
      'allergens',
      'site_scope',
      'site_ids',
      'site_names',
      'image_url',
      'is_active'
    ]
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
    headers: [
      ...commonSiteFields,
      'plan_date',
      'meal_type',
      'menu_type',
      'menu_category',
      'status',
      'line_number',
      'line_type',
      'recipe_id',
      'recipe_code',
      'recipe_name',
      'ingredient_id',
      'ingredient_name',
      'item_name',
      'expected_servings',
      'planned_weight_kg',
      'planned_weight_grams',
      'planned_unit',
      'estimated_cost',
      'event_name',
      'event_date',
      'expected_participants',
      'budget_amount',
      'notes'
    ]
  },
  production: {
    label: 'Production',
    entity: 'Production',
    required: ['production_date', 'menu_type', 'menu_category'],
    headers: [
      ...commonSiteFields,
      'fulfillment_store_id',
      'fulfillment_store_name',
      'production_date',
      'meal_type',
      'menu_type',
      'menu_category',
      'status',
      'issue_group_key',
      'menu_plan_id',
      'line_number',
      'menu_plan_line_id',
      'recipe_id',
      'recipe_code',
      'recipe_name',
      'ingredient_id',
      'ingredient_name',
      'item_name',
      'requested_servings',
      'requested_weight_kg',
      'requested_weight_grams',
      'produced_servings',
      'produced_weight_kg',
      'produced_weight_grams',
      'estimated_cost',
      'actual_cost',
      'notes'
    ]
  },
  'material-requests': {
    label: 'MR to Store',
    entity: 'MaterialRequest',
    required: ['request_number'],
    headers: [
      ...commonSiteFields,
      'request_number',
      'request_date',
      'period_start',
      'period_end',
      'fulfillment_store_id',
      'fulfillment_store_name',
      'source_type',
      'status',
      'line_number',
      'ingredient_id',
      'item_code',
      'ingredient_name',
      'required_quantity',
      'current_stock',
      'shortage_quantity',
      'request_quantity',
      'unit',
      'estimated_cost',
      'validation_status',
      'notes'
    ]
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
    headers: [
      ...commonSiteFields,
      'waste_date',
      'meal_type',
      'menu_type',
      'menu_category',
      'waste_category',
      'reason_code',
      'reason',
      'waste_scope',
      'source_type',
      'avoidable_type',
      'preventable',
      'line_number',
      'production_id',
      'production_name',
      'production_line_id',
      'produced_item_batch_id',
      'batch_reference',
      'recipe_id',
      'recipe_name',
      'ingredient_id',
      'ingredient_name',
      'batch_overproduction_item_key',
      'manifest_item_key',
      'source_menu_plan_item_key',
      'produced_weight_grams',
      'available_weight_grams_before',
      'wasted_production_equivalent_servings',
      'waste_weight_grams',
      'quantity',
      'unit',
      'estimated_cost',
      'evidence_image_url',
      'evidence_image_urls',
      'status',
      'notes'
    ]
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

const LIST_FIELDS = new Set([
  'site_ids',
  'site_names',
  'categories',
  'evidence_image_urls',
  'image_urls'
]);
const OBJECT_FIELDS = new Set([
  'stock_summary'
]);
const LEGACY_NESTED_UPLOAD_FIELDS = new Set([
  'ingredients',
  'sub_recipes',
  'meals',
  'menu_plan_lines',
  'manifest_lines',
  'items',
  'output_allocations'
]);
const BOOLEAN_FIELDS = new Set(['is_active', 'preventable', 'high_value']);
const NUMBER_FIELDS = new Set([
  'capacity', 'cost_per_unit', 'conversion_factor', 'package_base_quantity', 'package_pack_count',
  'package_inner_count', 'package_size_quantity', 'calories_per_100g', 'protein_per_100g',
  'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g', 'sodium_per_100g', 'sugar_per_100g',
  'cooking_yield_percent', 'shrinkage_percent', 'raw_weight_per_unit',
  'cooked_weight_per_unit', 'servings', 'portion_size_grams', 'batch_yield',
  'prep_time_minutes', 'cook_time_minutes',
  'quantity', 'unit_cost', 'average_unit_cost', 'reorder_level',
  'min_stock_level', 'max_stock_level', 'expected_participants',
  'budget_amount', 'target_servings', 'actual_servings', 'estimated_cost',
  'actual_cost', 'score', 'temperature', 'source_amount', 'source_quantity',
  'line_number', 'line_quantity', 'line_yield_percent', 'line_raw_weight_grams',
  'line_yielded_weight_grams', 'line_cost', 'expected_servings',
  'planned_servings', 'planned_weight_kg', 'planned_weight_grams',
  'requested_servings', 'requested_weight_kg', 'requested_weight_grams',
  'produced_servings', 'produced_weight_kg', 'produced_weight_grams',
  'required_quantity', 'current_stock', 'shortage_quantity', 'request_quantity',
  'live_reservable_quantity', 'live_shortage_quantity', 'source_line_count',
  'repairable_issue_count', 'total_estimated_cost', 'waste_weight_grams',
  'quantity_grams', 'wasted_weight_grams', 'produced_weight_grams',
  'available_weight_grams_before', 'wasted_production_equivalent_servings',
  'meal_service_adjustment_cost', 'inventory_deduction_quantity',
  'inventory_shortage_quantity'
]);

const HEADER_ALIASES = Object.freeze({
  recipes: {
    type: 'recipe_type',
    recipe_type: 'cuisine_type',
    cuisine: 'cuisine_type',
    category: 'menu_category',
    ingredients: 'ingredients',
    sub_recipes: 'sub_recipes',
    quantity: 'line_quantity',
    ingredient_quantity: 'line_quantity',
    recipe_line_quantity: 'line_quantity',
    unit: 'line_unit',
    ingredient_unit: 'line_unit',
    recipe_line_unit: 'line_unit',
    yield_percent: 'line_yield_percent',
    raw_weight_grams: 'line_raw_weight_grams',
    yielded_weight_grams: 'line_yielded_weight_grams',
    cost: 'line_cost'
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
    cuisine: 'menu_type',
    manifest_lines: 'manifest_lines',
    target_servings: 'requested_servings',
    actual_servings: 'produced_servings',
    recipe_name: 'recipe_name',
    production_size_kg: 'requested_weight_kg',
    production_size_g: 'requested_weight_grams',
    finished_weight_kg: 'produced_weight_kg',
    finished_weight_g: 'produced_weight_grams'
  },
  'menu-plans': {
    cuisine_type: 'menu_type',
    cuisine: 'menu_type',
    meals: 'meals',
    menu_plan_lines: 'menu_plan_lines',
    meal_period: 'meal_type',
    servings: 'expected_servings',
    planned_servings: 'expected_servings',
    recipe: 'recipe_name',
    weight_kg: 'planned_weight_kg',
    weight_g: 'planned_weight_grams'
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
  },
  'material-requests': {
    items: 'items',
    required_date: 'period_end',
    production_id: 'source_production_id',
    production_name: 'source_production_name',
    quantity: 'request_quantity',
    qty: 'request_quantity'
  },
  'food-waste': {
    output_allocations: 'output_allocations',
    cuisine_type: 'menu_type',
    category: 'waste_category',
    reason_category: 'reason_code',
    produced_batch_id: 'produced_item_batch_id',
    output_batch_id: 'produced_item_batch_id',
    line_cost: 'estimated_cost',
    image_url: 'evidence_image_url',
    image_urls: 'evidence_image_urls'
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
  if (LIST_FIELDS.has(field)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.split('|').map((item) => item.trim()).filter(Boolean);
    }
  }
  if (OBJECT_FIELDS.has(field)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      throw new Error(`${field} must be a JSON object`);
    }
  }
  if (LEGACY_NESTED_UPLOAD_FIELDS.has(field)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed;
    } catch {
      throw new Error(`${field} must be a JSON array when using the legacy nested upload format`);
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
  // Standard stock units use their canonical upload spelling; truly custom
  // units remain unchanged.
  return standardUnits.has(normalized) || normalized !== trimmed.toLowerCase() ? normalized : trimmed;
}

function hasText(value) {
  return String(value ?? '').trim() !== '';
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function kgToGrams(value) {
  return hasNumber(value) ? Number((Number(value) * 1000).toFixed(6)) : undefined;
}

function cleanUndefinedValues(record = {}) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

const RECIPE_LINE_FIELDS = new Set([
  'line_number',
  'ingredient_id',
  'item_code',
  'ingredient_code',
  'sku',
  'ingredient_name',
  'line_quantity',
  'line_unit',
  'line_yield_percent',
  'line_raw_weight_grams',
  'line_yielded_weight_grams',
  'line_cost'
]);

const MENU_PLAN_LINE_FIELDS = new Set([
  'line_number',
  'line_type',
  'recipe_id',
  'recipe_code',
  'recipe_name',
  'ingredient_id',
  'ingredient_name',
  'item_name',
  'expected_servings',
  'planned_servings',
  'planned_weight_kg',
  'planned_weight_grams',
  'planned_unit',
  'estimated_cost'
]);

const PRODUCTION_LINE_FIELDS = new Set([
  'line_number',
  'menu_plan_line_id',
  'recipe_id',
  'recipe_code',
  'recipe_name',
  'ingredient_id',
  'ingredient_name',
  'item_name',
  'requested_servings',
  'requested_weight_kg',
  'requested_weight_grams',
  'produced_servings',
  'produced_weight_kg',
  'produced_weight_grams',
  'estimated_cost',
  'actual_cost'
]);

const MATERIAL_REQUEST_LINE_FIELDS = new Set([
  'line_number',
  'ingredient_id',
  'item_code',
  'ingredient_name',
  'required_quantity',
  'current_stock',
  'shortage_quantity',
  'request_quantity',
  'unit',
  'estimated_cost',
  'validation_status'
]);

const FOOD_WASTE_LINE_FIELDS = new Set([
  'line_number',
  'production_line_id',
  'produced_item_batch_id',
  'output_batch_id',
  'recipe_id',
  'recipe_name',
  'ingredient_id',
  'ingredient_name',
  'batch_overproduction_item_key',
  'manifest_item_key',
  'source_menu_plan_item_key',
  'produced_weight_grams',
  'available_weight_grams_before',
  'wasted_production_equivalent_servings',
  'waste_weight_grams',
  'quantity_grams',
  'wasted_weight_grams'
]);

function stripFields(payload = {}, fields = new Set()) {
  fields.forEach((field) => {
    delete payload[field];
  });
}

function normalizeLineNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function recipeLineFromUploadPayload(payload = {}) {
  const hasLine = [
    payload.ingredient_id,
    payload.item_code,
    payload.ingredient_code,
    payload.sku,
    payload.ingredient_name,
    payload.line_quantity,
    payload.line_unit
  ].some(hasText);
  if (!hasLine) return null;
  return cleanUndefinedValues({
    line_number: normalizeLineNumber(payload.line_number, undefined),
    ingredient_id: payload.ingredient_id,
    item_code: payload.item_code,
    ingredient_code: payload.ingredient_code,
    sku: payload.sku,
    ingredient_name: payload.ingredient_name,
    name: payload.ingredient_name,
    quantity: payload.line_quantity,
    unit: payload.line_unit,
    yield_percent: payload.line_yield_percent,
    raw_weight_grams: payload.line_raw_weight_grams,
    yielded_weight_grams: payload.line_yielded_weight_grams,
    cost: payload.line_cost
  });
}

function menuPlanLineFromUploadPayload(payload = {}) {
  const hasLine = [
    payload.recipe_id,
    payload.recipe_code,
    payload.recipe_name,
    payload.ingredient_id,
    payload.ingredient_name,
    payload.item_name,
    payload.expected_servings,
    payload.planned_weight_kg,
    payload.planned_weight_grams
  ].some(hasText);
  if (!hasLine) return null;
  const plannedWeightGrams = firstValue(
    payload.planned_weight_grams,
    kgToGrams(payload.planned_weight_kg)
  );
  const lineType = String(payload.line_type || (payload.ingredient_id ? 'ingredient' : 'recipe')).trim().toLowerCase();
  const itemName = firstValue(
    payload.item_name,
    payload.recipe_name,
    payload.ingredient_name
  );
  return cleanUndefinedValues({
    line_number: normalizeLineNumber(payload.line_number, undefined),
    line_type: ['recipe', 'ingredient', 'manual'].includes(lineType) ? lineType : 'recipe',
    recipe_id: payload.recipe_id,
    recipe_code: payload.recipe_code,
    recipe_name: payload.recipe_name,
    ingredient_id: payload.ingredient_id,
    ingredient_name: payload.ingredient_name,
    item_name: itemName,
    meal_type: payload.meal_type,
    expected_servings: payload.expected_servings,
    planned_servings: firstValue(payload.planned_servings, payload.expected_servings),
    planned_weight_grams: plannedWeightGrams,
    planned_unit: payload.planned_unit,
    estimated_cost: payload.estimated_cost
  });
}

function productionManifestLineFromUploadPayload(payload = {}) {
  const hasLine = [
    payload.menu_plan_line_id,
    payload.recipe_id,
    payload.recipe_code,
    payload.recipe_name,
    payload.ingredient_id,
    payload.ingredient_name,
    payload.item_name,
    payload.requested_servings,
    payload.requested_weight_kg,
    payload.requested_weight_grams,
    payload.produced_servings,
    payload.produced_weight_kg,
    payload.produced_weight_grams
  ].some(hasText);
  if (!hasLine) return null;
  const requestedWeightGrams = firstValue(
    payload.requested_weight_grams,
    kgToGrams(payload.requested_weight_kg)
  );
  const producedWeightGrams = firstValue(
    payload.produced_weight_grams,
    kgToGrams(payload.produced_weight_kg)
  );
  return cleanUndefinedValues({
    line_number: normalizeLineNumber(payload.line_number, undefined),
    menu_plan_line_id: payload.menu_plan_line_id,
    recipe_id: payload.recipe_id,
    recipe_code: payload.recipe_code,
    recipe_name: payload.recipe_name,
    ingredient_id: payload.ingredient_id,
    ingredient_name: payload.ingredient_name,
    item_name: firstValue(payload.item_name, payload.recipe_name, payload.ingredient_name),
    requested_servings: payload.requested_servings,
    requested_weight_grams: requestedWeightGrams,
    produced_servings: payload.produced_servings,
    produced_weight_grams: producedWeightGrams,
    estimated_cost: payload.estimated_cost,
    actual_cost: payload.actual_cost
  });
}

function materialRequestLineFromUploadPayload(payload = {}) {
  const hasLine = [
    payload.ingredient_id,
    payload.item_code,
    payload.ingredient_name,
    payload.required_quantity,
    payload.shortage_quantity,
    payload.request_quantity
  ].some(hasText);
  if (!hasLine) return null;
  return cleanUndefinedValues({
    line_number: normalizeLineNumber(payload.line_number, undefined),
    ingredient_id: payload.ingredient_id,
    item_code: payload.item_code,
    ingredient_name: payload.ingredient_name,
    required_quantity: payload.required_quantity,
    current_stock: payload.current_stock,
    shortage_quantity: payload.shortage_quantity,
    request_quantity: firstValue(payload.request_quantity, payload.required_quantity),
    unit: payload.unit,
    estimated_cost: payload.estimated_cost,
    validation_status: payload.validation_status
  });
}

function foodWasteWeightGramsFromUploadPayload(payload = {}) {
  const direct = firstValue(
    payload.waste_weight_grams,
    payload.quantity_grams,
    payload.wasted_weight_grams
  );
  if (hasNumber(direct)) return Number(direct);
  if (!hasNumber(payload.quantity)) return undefined;
  const unit = String(payload.unit || 'g').trim().toLowerCase();
  return unit === 'kg' ? Number(payload.quantity) * 1000 : Number(payload.quantity);
}

function foodWasteLineFromUploadPayload(payload = {}) {
  const wasteWeightGrams = foodWasteWeightGramsFromUploadPayload(payload);
  const hasLine = [
    payload.production_line_id,
    payload.produced_item_batch_id,
    payload.output_batch_id,
    payload.recipe_id,
    payload.recipe_name,
    payload.ingredient_id,
    payload.ingredient_name,
    payload.batch_overproduction_item_key,
    payload.manifest_item_key,
    payload.source_menu_plan_item_key,
    wasteWeightGrams
  ].some(hasText);
  if (!hasLine) return null;
  return cleanUndefinedValues({
    line_number: normalizeLineNumber(payload.line_number, undefined),
    production_line_id: payload.production_line_id,
    produced_item_batch_id: payload.produced_item_batch_id || payload.output_batch_id,
    output_batch_id: payload.produced_item_batch_id || payload.output_batch_id,
    production_id: payload.production_id,
    recipe_id: payload.recipe_id,
    recipe_name: payload.recipe_name,
    ingredient_id: payload.ingredient_id,
    ingredient_name: payload.ingredient_name,
    item_name: firstValue(payload.recipe_name, payload.ingredient_name),
    batch_number: payload.batch_reference,
    batch_overproduction_item_key: payload.batch_overproduction_item_key,
    manifest_item_key: payload.manifest_item_key,
    source_menu_plan_item_key: payload.source_menu_plan_item_key,
    produced_weight_grams: payload.produced_weight_grams,
    available_weight_grams_before: payload.available_weight_grams_before,
    wasted_production_equivalent_servings: payload.wasted_production_equivalent_servings,
    waste_weight_grams: wasteWeightGrams,
    cost: payload.estimated_cost
  });
}

function normalizeMappedPayload(moduleKey, payload) {
  if (moduleKey === 'recipes' && payload.recipe_type && !payload.cuisine_type) {
    payload.cuisine_type = payload.recipe_type;
  }
  if (moduleKey === 'recipes' && payload.recipe_type) {
    delete payload.recipe_type;
  }
  if (moduleKey === 'recipes') {
    const line = recipeLineFromUploadPayload(payload);
    stripFields(payload, RECIPE_LINE_FIELDS);
    if (line) {
      payload.ingredients = [
        ...(Array.isArray(payload.ingredients) ? payload.ingredients : []),
        line
      ];
    }
    if (payload.menu_category && !payload.category) payload.category = payload.menu_category;
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
  if (moduleKey === 'menu-plans') {
    const line = menuPlanLineFromUploadPayload(payload);
    stripFields(payload, MENU_PLAN_LINE_FIELDS);
    if (payload.menu_type && !payload.cuisine_type) payload.cuisine_type = payload.menu_type;
    if (line) {
      payload.menu_plan_lines = [
        ...(Array.isArray(payload.menu_plan_lines) ? payload.menu_plan_lines : []),
        line
      ];
      if (line.line_type === 'recipe') {
        payload.meals = [
          ...(Array.isArray(payload.meals) ? payload.meals : []),
          cleanUndefinedValues({
            meal_type: payload.meal_type || line.meal_type,
            recipe_id: line.recipe_id,
            recipe_code: line.recipe_code,
            recipe_name: line.recipe_name,
            expected_servings: line.expected_servings,
            total_cost: line.estimated_cost
          })
        ];
      }
    }
  }
  if (moduleKey === 'production') {
    const line = productionManifestLineFromUploadPayload(payload);
    stripFields(payload, PRODUCTION_LINE_FIELDS);
    if (line) {
      payload.manifest_lines = [
        ...(Array.isArray(payload.manifest_lines) ? payload.manifest_lines : []),
        line
      ];
      if (!payload.recipe_id && line.recipe_id) payload.recipe_id = line.recipe_id;
      if (!payload.recipe_name && line.recipe_name) payload.recipe_name = line.recipe_name;
      if (!payload.target_servings && line.requested_servings) payload.target_servings = line.requested_servings;
    }
    return normalizeProductionMenuScope(payload, { required: true });
  }
  if (moduleKey === 'material-requests') {
    const line = materialRequestLineFromUploadPayload(payload);
    stripFields(payload, MATERIAL_REQUEST_LINE_FIELDS);
    if (line) {
      payload.items = [
        ...(Array.isArray(payload.items) ? payload.items : []),
        line
      ];
      if (!payload.total_estimated_cost && hasNumber(line.estimated_cost)) {
        payload.total_estimated_cost = Number(line.estimated_cost);
      }
    }
  }
  if (moduleKey === 'food-waste') {
    const line = foodWasteLineFromUploadPayload(payload);
    stripFields(payload, FOOD_WASTE_LINE_FIELDS);
    if (line) {
      payload.output_allocations = [
        ...(Array.isArray(payload.output_allocations) ? payload.output_allocations : []),
        line
      ];
      if (!payload.quantity && hasNumber(line.waste_weight_grams)) {
        payload.quantity = Number(line.waste_weight_grams);
        payload.quantity_grams = Number(line.waste_weight_grams);
        payload.waste_weight_grams = Number(line.waste_weight_grams);
      }
      payload.unit = payload.unit || 'g';
    }
  }
  return payload;
}

function textKey(value) {
  return String(value || '').trim().toLowerCase();
}

function mergeUploadBase(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    if ([
      'ingredients',
      'sub_recipes',
      'meals',
      'menu_plan_lines',
      'manifest_lines',
      'items',
      'output_allocations'
    ].includes(key)) return;
    if (target[key] === undefined || target[key] === null || target[key] === '') {
      target[key] = value;
    }
  });
}

function lineSort(left = {}, right = {}) {
  const leftLine = Number(left.line_number || 0);
  const rightLine = Number(right.line_number || 0);
  if (leftLine && rightLine && leftLine !== rightLine) return leftLine - rightLine;
  if (leftLine && !rightLine) return -1;
  if (!leftLine && rightLine) return 1;
  return 0;
}

function groupKeyForUploadPayload(moduleKey, payload = {}) {
  if (moduleKey === 'recipes') {
    return [
      textKey(payload.recipe_code),
      textKey(payload.name),
      textKey(payload.site_scope),
      Array.isArray(payload.site_ids) ? payload.site_ids.map(textKey).join('|') : textKey(payload.site_ids),
      textKey(payload.cuisine_type),
      textKey(payload.category || payload.menu_category)
    ].join('::');
  }
  if (moduleKey === 'menu-plans') {
    return [
      textKey(payload.site_id || payload.site_name),
      textKey(payload.plan_date),
      textKey(payload.menu_type || payload.cuisine_type || 'general'),
      textKey(payload.menu_category || 'senior')
    ].join('::');
  }
  if (moduleKey === 'production') {
    return [
      textKey(payload.issue_group_key),
      textKey(payload.site_id || payload.fulfillment_store_id || payload.site_name),
      textKey(payload.production_date),
      textKey(payload.meal_type || 'breakfast'),
      textKey(payload.menu_type || payload.cuisine_type || 'general'),
      textKey(payload.menu_category || 'senior'),
      textKey(payload.menu_plan_id)
    ].join('::');
  }
  if (moduleKey === 'material-requests') {
    const requestNumber = textKey(payload.request_number);
    if (!requestNumber) return '';
    return [
      textKey(payload.site_id || payload.site_name),
      requestNumber
    ].join('::');
  }
  if (moduleKey === 'food-waste') {
    return [
      textKey(payload.waste_reference || payload.idempotency_key),
      textKey(payload.site_id || payload.site_name),
      textKey(payload.waste_date),
      textKey(payload.meal_type || 'all'),
      textKey(payload.menu_type || payload.cuisine_type || 'general'),
      textKey(payload.menu_category || 'senior'),
      textKey(payload.waste_category || 'ingredient'),
      textKey(payload.reason_code || payload.reason),
      textKey(payload.batch_reference)
    ].join('::');
  }
  return '';
}

export function groupBulkUploadRows(moduleKey, stagedRows = []) {
  if (!['recipes', 'menu-plans', 'production', 'material-requests', 'food-waste'].includes(moduleKey)) {
    return stagedRows;
  }
  const groups = new Map();
  for (const staged of stagedRows) {
    const payload = staged?.payload || {};
    const key = groupKeyForUploadPayload(moduleKey, payload) || `row:${staged.rowNumber}`;
    if (!groups.has(key)) {
      groups.set(key, {
        rowNumber: staged.rowNumber,
        rowNumbers: [],
        sourceRowCount: 0,
        payload: { ...payload }
      });
      if (moduleKey === 'recipes') {
        groups.get(key).payload.ingredients = [];
        groups.get(key).payload.sub_recipes = Array.isArray(payload.sub_recipes) ? payload.sub_recipes : [];
      }
      if (moduleKey === 'menu-plans') {
        groups.get(key).payload.meals = [];
        groups.get(key).payload.menu_plan_lines = [];
      }
      if (moduleKey === 'production') {
        groups.get(key).payload.manifest_lines = [];
      }
      if (moduleKey === 'material-requests') {
        groups.get(key).payload.items = [];
      }
      if (moduleKey === 'food-waste') {
        groups.get(key).payload.output_allocations = [];
      }
    }
    const group = groups.get(key);
    group.rowNumbers.push(staged.rowNumber);
    group.sourceRowCount += 1;
    mergeUploadBase(group.payload, payload);
    if (moduleKey === 'recipes') {
      group.payload.ingredients.push(...(Array.isArray(payload.ingredients) ? payload.ingredients : []));
      group.payload.sub_recipes.push(...(Array.isArray(payload.sub_recipes) ? payload.sub_recipes : []));
    } else if (moduleKey === 'menu-plans') {
      group.payload.meals.push(...(Array.isArray(payload.meals) ? payload.meals : []));
      group.payload.menu_plan_lines.push(...(Array.isArray(payload.menu_plan_lines) ? payload.menu_plan_lines : []));
    } else if (moduleKey === 'production') {
      group.payload.manifest_lines.push(...(Array.isArray(payload.manifest_lines) ? payload.manifest_lines : []));
    } else if (moduleKey === 'material-requests') {
      group.payload.items.push(...(Array.isArray(payload.items) ? payload.items : []));
    } else if (moduleKey === 'food-waste') {
      group.payload.output_allocations.push(...(Array.isArray(payload.output_allocations) ? payload.output_allocations : []));
    }
  }
  return [...groups.values()].map((group) => {
    if (moduleKey === 'recipes') {
      group.payload.ingredients = group.payload.ingredients
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
      group.payload.sub_recipes = group.payload.sub_recipes
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
    } else if (moduleKey === 'menu-plans') {
      group.payload.meals = group.payload.meals
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
      group.payload.menu_plan_lines = group.payload.menu_plan_lines
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
    } else if (moduleKey === 'production') {
      group.payload.manifest_lines = group.payload.manifest_lines
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
    } else if (moduleKey === 'material-requests') {
      group.payload.items = group.payload.items
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
      const totalEstimatedCost = group.payload.items.reduce((sum, line) => (
        sum + (hasNumber(line.estimated_cost) ? Number(line.estimated_cost) : 0)
      ), 0);
      if (totalEstimatedCost > 0) group.payload.total_estimated_cost = Number(totalEstimatedCost.toFixed(6));
    } else if (moduleKey === 'food-waste') {
      group.payload.output_allocations = group.payload.output_allocations
        .map((line, index) => ({ ...line, line_number: normalizeLineNumber(line.line_number, index + 1) }))
        .sort(lineSort);
      const totalWasteWeightGrams = group.payload.output_allocations.reduce((sum, line) => (
        sum + (hasNumber(line.waste_weight_grams) ? Number(line.waste_weight_grams) : 0)
      ), 0);
      if (totalWasteWeightGrams > 0) {
        group.payload.quantity = Number(totalWasteWeightGrams.toFixed(6));
        group.payload.quantity_grams = Number(totalWasteWeightGrams.toFixed(6));
        group.payload.waste_weight_grams = Number(totalWasteWeightGrams.toFixed(6));
        group.payload.unit = group.payload.unit || 'g';
      }
    }
    return group;
  });
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
