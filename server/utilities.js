import { validateEntityPayload } from './entities.js';
import { validateRecipeImageReference } from '../shared/recipeImage.js';

const commonSiteFields = ['site_id', 'site_name'];

export const utilityModules = Object.freeze({
  sites: {
    label: 'Projects & Sites',
    entity: 'Site',
    required: ['name'],
    headers: ['name', 'project_code', 'type', 'hierarchy_level', 'parent_site_id', 'parent_site_name', 'company_name', 'region_name', 'location_name', 'kitchen_name', 'storage_name', 'address', 'city', 'country', 'capacity', 'contact_person', 'contact_phone', 'contact_email', 'is_active']
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
    headers: ['name', 'ingredient_code', 'sku', 'alias', 'supplier_item_name', 'unit', 'category', 'cuisine_type', 'cost_per_unit', 'calories_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'sodium_per_100g', 'sugar_per_100g', 'cooking_yield_percent', 'shrinkage_percent', 'raw_weight_per_unit', 'cooked_weight_per_unit', 'allergens', 'is_active']
  },
  recipes: {
    label: 'Recipes',
    entity: 'Recipe',
    required: ['name'],
    headers: ['name', 'recipe_code', 'description', 'cuisine_type', 'category', 'servings', 'ingredients', 'sub_recipes', 'instructions', 'prep_time_minutes', 'cook_time_minutes', 'allergens', 'site_scope', 'site_ids', 'site_names', 'image_url', 'is_active']
  },
  inventory: {
    label: 'Inventory',
    entity: 'Inventory',
    required: ['ingredient_id'],
    headers: [...commonSiteFields, 'ingredient_id', 'ingredient_name', 'quantity', 'unit', 'average_unit_cost', 'reorder_level', 'status']
  },
  'menu-plans': {
    label: 'Menu Plans',
    entity: 'MenuPlan',
    required: ['plan_date'],
    headers: [...commonSiteFields, 'plan_date', 'status', 'event_name', 'event_date', 'expected_participants', 'budget_amount', 'meals', 'notes']
  },
  production: {
    label: 'Production',
    entity: 'Production',
    required: ['production_date'],
    headers: [...commonSiteFields, 'production_date', 'recipe_id', 'recipe_name', 'meal_type', 'target_servings', 'actual_servings', 'status', 'estimated_cost', 'actual_cost', 'ingredients_used', 'notes']
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
  'capacity', 'cost_per_unit', 'calories_per_100g', 'protein_per_100g',
  'carbs_per_100g', 'fat_per_100g', 'sodium_per_100g', 'sugar_per_100g',
  'cooking_yield_percent', 'shrinkage_percent', 'raw_weight_per_unit',
  'cooked_weight_per_unit', 'servings', 'prep_time_minutes', 'cook_time_minutes',
  'quantity', 'average_unit_cost', 'reorder_level', 'expected_participants',
  'budget_amount', 'target_servings', 'actual_servings', 'estimated_cost',
  'actual_cost', 'score', 'temperature'
]);

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
    return number;
  }
  return trimmed;
}

export function mapCsvRow(moduleKey, headers, values) {
  const definition = getUtilityModule(moduleKey);
  if (!definition) throw new Error('Unknown bulk upload module.');
  const canonicalHeaders = new Map(definition.headers.map((header) => [normalizeHeader(header), header]));
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
  if (definition.entity === 'Recipe' && payload.image_url) {
    const imageError = validateRecipeImageReference(payload.image_url);
    if (imageError) throw new Error(imageError);
  }
  return validateEntityPayload(definition.entity, payload);
}

export function validateCsvHeaders(moduleKey, headers) {
  const definition = getUtilityModule(moduleKey);
  if (!definition) return ['Unknown bulk upload module.'];
  const incoming = new Set(headers.map(normalizeHeader));
  return definition.required
    .filter((field) => !incoming.has(normalizeHeader(field)))
    .map((field) => `Missing required column: ${field}`);
}

export function serializeReportRows(rows = []) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row || {}).filter(([key]) => !['password', 'password_hash', 'temporary_password'].includes(key))
  ));
}
