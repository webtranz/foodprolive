import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { mapCsvRow, parseCsvLine, validateCsvHeaders } from '../server/utilities.js';
import { validateMenuPlanPayload } from '../server/menuPlanningApi.js';
import { MENU_CATEGORY_OPTIONS, normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';

const GENERAL_WORKBOOK = 'C:/Users/HP/Downloads/384 MENU/MENU/Senior Junior Menu.xlsx';
const PHILIPPINES_WORKBOOK = 'C:/Users/HP/Downloads/philpino menu/Phillipino reciepe + menu/PHILIPPINO MENU.xlsx';
const GENERAL_RECIPE_UPLOAD = 'artifacts/inventory-ingredients-only/UPLOAD-THIS-RECIPES-KBR-384-102-SOURCE-EXACT-1SERVING-V5.csv';
const PHILIPPINES_RECIPE_UPLOAD = 'artifacts/inventory-ingredients-only/kbr-384-31-8-26/UPLOAD-THIS-FILIPINO-RECIPES-KBR-384-28-1SERVING.csv';
const OUTPUT_DIR = 'artifacts/menu-planning-kbr-384';
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'UPLOAD-THIS-MENU-PLAN-KBR-384-2026-09-01-TO-2026-09-05.csv');
const QC_CSV = path.join(OUTPUT_DIR, 'menu-plan-kbr-384-2026-09-01-to-2026-09-05-qc.csv');

const SITE_ID = 'KBR-384';
const SITE_NAME = 'KBR';
const START_DATE = '2026-09-01';

const DAY_TO_DATE = new Map([
  ['TUESDAY', '2026-09-01'],
  ['WEDNESDAY', '2026-09-02'],
  ['THURSDAY', '2026-09-03'],
  ['FRIDAY', '2026-09-04'],
  ['SATURDAY', '2026-09-05']
]);

const MEAL_LABELS = new Map([
  ['BREAK FAST', 'breakfast'],
  ['BREAKFAST', 'breakfast'],
  ['LUNCH', 'lunch'],
  ['DINNER', 'dinner']
]);

const SKIP_ITEMS = new Set([
  '',
  '-',
  'DINNER',
  'PROJECT MANAGER',
  'ARABIC BREAD',
  'SLICE BREAD',
  'WATER BTL',
  'WATER BOTTLE',
  'CORN FLAKES',
  'JAM',
  'HONEY',
  'PEANUT BUTTER',
  'MILK POWDER',
  'SMALL MILK',
  'SOFT DRINK'
]);

const COMBINED_ITEMS = new Map([
  ['MUTTON / CHICKEN BIRYANI', ['MUTTON BIRYANI', 'CHICKEN BIRYANI']],
  ['MUTTON/CHICKEN BIRYANI', ['MUTTON BIRYANI', 'CHICKEN BIRYANI']],
  ['CHICKEN/MUTTON BIRYANI', ['CHICKEN BIRYANI', 'MUTTON BIRYANI']],
  ['EGG OMLET/BOILED', ['EGG OMLET', 'BOILED EGG']],
  ['OATS/HALWA', ['OATS', 'HALWA']],
  ['CURRY PAKURA/ALO PALAK', ['CURRY PAKURA', 'ALO PALAK']],
  ['SOFT DRINK+ FRUIT', ['SOFT DRINK', 'FRUIT']]
]);

const ALIASES = new Map([
  ['CHANA MASSALA', 'Chana Masala'],
  ['CHANA MASALA', 'Chana Masala'],
  ['CHANA DHAL', 'Dal Chana Fry'],
  ['CHANA DALL', 'Dal Chana Fry'],
  ['DAAL CHANA', 'Dal Chana Fry'],
  ['DHAL CHANA', 'Dal Chana Fry'],
  ['CHANA MONGO', 'Dall Mong'],
  ['DALL MONGO', 'Dall Mongo'],
  ['DHAL MONGO', 'Dall Mongo'],
  ['DAAL MOONG', 'Dall Mongo'],
  ['DHAL MOONG', 'Dall Mongo'],
  ['MIX DALL', 'Dall Makhni Mix'],
  ['DALL MASOOR', 'Dal Masoor'],
  ['DAAL MASOOR', 'Dal Masoor'],
  ['DHAL MASOOR', 'Dal Masoor'],
  ['DHAL BROWN LENTAL', 'Dal Makhni'],
  ['DAAL BROWN LENTAL', 'Dal Makhni'],
  ['DHAL CHICK PEAS', 'Chickpeas Masala'],
  ['CHICK PEAS ( CHANA)', 'Chickpeas Masala'],
  ['CHICK PEAS', 'Chickpeas Masala'],
  ['DHAL RED KIDNEY BEANS', 'Daal Lobia'],
  ['RED KIDNEY BEANS', 'Daal Lobia'],
  ['WHITE BEANS', 'Daal Lobia'],
  ['DALL MASH', 'Dall Mash'],
  ['DHAL MASH', 'Dall Mash'],
  ['DAAL MASH', 'Dall Mash'],
  ['OATS', 'Oatmeal'],
  ['HALWA', 'Standard Catering Sweet'],
  ['EGG OMLET', 'Omlette with onion and tomato'],
  ['EGG OMLET', 'Omlette with onion and tomato'],
  ['BOILED', 'Boiled Eggs'],
  ['BOILED EGG', 'Boiled Eggs'],
  ['EGG CURRY', 'Egg Curry'],
  ['CHICKEN CURRY', 'Chicken Curry'],
  ['MUTTON CURRY', 'Mutton Curry'],
  ['BUTTER CHICKEN', 'Butter Chicken'],
  ['CHICKEN KORMA', 'Chicken Korma'],
  ['CHICKEN TADORI', 'Chicken Tandori'],
  ['CHICKEN TANDOORI', 'Chicken Tandori'],
  ['CHICKEN BIRYANI', 'Chicken Biryani'],
  ['MUTTON BIRYANI', 'Mutton Biryani'],
  ['BAKED FISH FILLET W/ SAUCE', 'Baked Lemon Butter fillet fish'],
  ['GRILLED FISH FILLET', 'Grilled Fish Fillet'],
  ['FISH CURRY', 'Fish Curry'],
  ['CHICKEN BROASTED', 'Chicken Broasted'],
  ['CHICKEN JALFREZI', 'Chicken Jalfrezi'],
  ['CHICKEN STRIPE', 'Crispy Chicken Strips'],
  ['CHICKEN STRIPS', 'Crispy Chicken Strips'],
  ['CHICKEN TIKKA MASALA', 'Chicken Tikka'],
  ['CHICKEN WINGS FRIED', 'Chicken Broasted'],
  ['WINGH CURRY', 'Chicken Curry'],
  ['CHICKEN PALAK', 'Chicken Palak'],
  ['CHICKEN CHILLI', 'Chicken Chilli'],
  ['CAULIFLOWER', 'Cauliflower Potato Curry'],
  ['BITTER GUARD', 'Bitter Gourd POTATO'],
  ['OKRA', 'Achari Okra'],
  ['GREEN BEANS', 'Green Beans'],
  ['CUT GREEN BEAN', 'Green Beans'],
  ['GREEN .PEAS', 'carrot potato green peas mix'],
  ['MIX VEGETABLE', 'Mix Vegetable Curry'],
  ['ALO GOBI', 'ALOO GOBI'],
  ['ALOO GOBI', 'ALOO GOBI'],
  ['ALO PALAK', 'Chicken Palak'],
  ['CURRY PAKURA', 'Dahi Kari with Pakora'],
  ['LONG MARROW', 'LONE MARROW POTATO SWEET PEPPER'],
  ['LONG MERROW', 'LONE MARROW POTATO SWEET PEPPER'],
  ['FRESH SMALL MERROW', 'LONE MARROW POTATO SWEET PEPPER'],
  ['SMALL MARROW', 'LONE MARROW POTATO SWEET PEPPER'],
  ['VIGGES POTATO', 'Roast Potatoes'],
  ['PASTA', 'Pasta with Tomato Sauce'],
  ['SALAD', 'Green Salad Mix'],
  ['GREEN SALAD', 'Green Salad Mix'],
  ['RAITA', 'Raita'],
  ['RAITHA', 'Raita'],
  ['VERMICELLI RISE', 'Vermicelli Rice'],
  ['RED RICE', 'Yellow Rice'],
  ['BROWN RICE', 'Plain Pulao Rice'],
  ['SAYDIA RICE', 'Sayadiyah Rice'],
  ['KABSA RICE', 'Plain Kabsa Rice'],
  ['CHANA POLAW', 'Chickpea Rice'],
  ['RICE POLAW', 'Pulao Rice'],
  ['ZERA RICE', 'Cumin Rice'],
  ['POTATO RICE', 'Vegetable Rice'],
  ['MANDI RICE', 'arabic Mandi Rice'],
  ['WHITE RICE', 'White Rice'],
  ['RICE', 'White Rice'],
  ['VEGETABLE RICE', 'Vegetable Rice'],
  ['SWEET', 'Standard Catering Sweet'],
  ['FRUIT', 'Fruit Salad'],
  ['FRESH FRUIT', 'Fruit Salad'],
  ['JUICE', 'CLASSIC COFFEE & TANG'],
  ['TANG JUICE', 'CLASSIC COFFEE & TANG'],
  ['TEA/ COFFEE/ MILK', 'CLASSIC COFFEE & TANG'],
  ['TEA/COFFEE', 'CLASSIC COFFEE & TANG'],
  ['TEA+COFFEE+MILK', 'CLASSIC COFFEE & TANG'],
  ['SPAGHETTI', 'SPAGHETTI PHILIPPINES'],
  ['SOPAS', 'Sopas Pilippines'],
  ['CHICKEN FRANK', 'Chicken franks Pilippines'],
  ['CHICKEN LUNCHION MEAT', 'Ch.Luncheon Chicken / Beef Philippines'],
  ['SARDINES', 'Sardine Philippines'],
  ['SCRAMBLED EGGS', 'Scramble Egg Philippines'],
  ['BEEF BISTEK', 'Beef Steak Philippines'],
  ['CHICKEN MINANO', 'Chicken Menudo Philippines'],
  ['CHICKEN FRY', 'Chicken fry Philippines'],
  ['BEEF CALDERETA', 'Beef Caldareta Philippines'],
  ['CHICKEN ADOBO', 'Chicken Adobo Philippines'],
  ['CHICKEN GINATAANG', 'Ginataang Manok Philippines'],
  ['CHIICKEN BROASTED', 'Chicken fry Philippines'],
  ['NILAGA SOUP', 'Nilaga soup Philippines'],
  ['NIGALA SOUP', 'Nilaga soup Philippines'],
  ['TINOLA SOUP', 'Tinola soup Philippines'],
  ['TRINOLA', 'Tinola soup Philippines'],
  ['SINIGANG SOUP', 'Sinigang soup Philippines'],
  ['PRESANG SOUP', 'Pesang soup Philippines'],
  ['CHICKEN SOTANGHON SOUP', 'Chicken Sotanghon Philippines'],
  ['CHICKEN ADOBO COCO', 'Chicken Adobo coconut Philippines'],
  ['MACKRAL FISH FRY', 'Mackerel Tilapia milk fry fish Philippines'],
  ['SWEET & SOUR FISH FILLET', 'White hamour fry fish Philippines'],
  ['CHICKEN TINOLA', 'Tinola soup Philippines'],
  ['TILAPIA FISH', 'Mackerel Tilapia milk fry fish Philippines'],
  ['MILK FISH BANGUS', 'Mackerel Tilapia milk fry fish Philippines'],
  ['FISH FILLET FRY', 'White hamour fry fish Philippines'],
  ['SARDIN SOTANGON', 'Sardine Sotanghon Philippines'],
  ['COCO VEGETABLE', 'Coconut vegetable Philippines'],
  ['NOODLES', 'Chinese noodle Philippines'],
  ['CH SOTANGHON', 'Chicken Sotanghon Philippines'],
  ['MUNG BEAN SOUP', 'Mung Bean Soup Philippines'],
  ['PAK BET', 'Pak Bet Philippines'],
  ['PANCIT MIX', 'Pancit Mix Philippines'],
  ['BOILED RICE', 'White Rice']
]);

function normalize(value) {
  return String(value || '')
    .replace(/\uFEFF/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupKey(value) {
  return normalize(value).toUpperCase();
}

function stripRecipeSuffix(value) {
  return normalize(value)
    .replace(/\s+KBR-384\s+ONEGO\s+V\d+$/i, '')
    .replace(/\s+Recipe$/i, '')
    .replace(/\s+Ingredients$/i, '')
    .trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function readRecipeCatalog(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map((header) => normalize(header));
  const recipes = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
  const byName = new Map();
  recipes.forEach((recipe) => {
    [
      recipe.name,
      stripRecipeSuffix(recipe.name),
      recipe.description,
      stripRecipeSuffix(recipe.description)
    ].forEach((candidate) => {
      const key = lookupKey(candidate);
      if (key && !byName.has(key)) byName.set(key, recipe);
    });
  });
  return { recipes, byName };
}

function combineRecipeCatalogs(catalogs) {
  const recipes = catalogs.flatMap((catalog) => catalog.recipes);
  const byName = new Map();
  catalogs.forEach((catalog) => {
    catalog.byName.forEach((recipe, key) => {
      if (!byName.has(key)) byName.set(key, recipe);
    });
  });
  return { recipes, byName };
}

function findRecipe(rawItem, mealType, catalog) {
  const item = lookupKey(rawItem);
  const alias = ALIASES.get(item) || rawItem;
  const candidates = [
    alias,
    rawItem,
    `${alias} KBR-384 ONEGO V3`
  ].map(lookupKey);
  for (const candidate of candidates) {
    if (catalog.byName.has(candidate)) return catalog.byName.get(candidate);
  }

  const words = lookupKey(alias).split(/\s+/).filter((word) => word.length > 2);
  const scored = catalog.recipes
    .map((recipe) => {
      const haystack = lookupKey(`${recipe.name} ${recipe.description} ${recipe.category}`);
      const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
      const mealBoost = mealType === 'breakfast' && lookupKey(recipe.category).includes('BREAKFAST') ? 1 : 0;
      return { recipe, score: score + mealBoost };
    })
    .filter((entry) => entry.score >= Math.min(2, words.length))
    .sort((left, right) => right.score - left.score);
  return scored[0]?.recipe || null;
}

function splitMenuCell(value) {
  const text = normalize(value);
  if (!text) return [];
  if (/^(note:|approved by|31\/08|08-2026)/i.test(text)) {
    return [{ item: text, skipped: true, reason: 'Workbook footer/non-menu text' }];
  }
  if (SKIP_ITEMS.has(lookupKey(text))) return [{ item: text, skipped: true, reason: 'Support/non-recipe item' }];
  if (COMBINED_ITEMS.has(lookupKey(text))) {
    return COMBINED_ITEMS.get(lookupKey(text)).map((item) => ({
      item,
      skipped: SKIP_ITEMS.has(lookupKey(item)),
      reason: SKIP_ITEMS.has(lookupKey(item)) ? 'Support/non-recipe item' : ''
    }));
  }
  if (ALIASES.has(lookupKey(text))) return [{ item: text, skipped: false, reason: '' }];
  return text
    .split(/\s*(?:\/|\+)\s*/)
    .map(normalize)
    .filter(Boolean)
    .map((item) => ({
      item,
      skipped: SKIP_ITEMS.has(lookupKey(item)),
      reason: SKIP_ITEMS.has(lookupKey(item)) ? 'Support/non-recipe item' : ''
    }));
}

function resolveWorkbookMenuCategory(sheetName, fallbackCategory) {
  const sheetKey = lookupKey(sheetName);
  if (sheetKey.includes('SENIOR')) return 'senior';
  if (sheetKey.includes('JUNIOR')) return 'junior';
  if (sheetKey.includes('LABOR') || sheetKey.includes('LABOUR')) return 'labor';
  return normalizeMenuCategory(fallbackCategory, 'senior');
}

function extractMenuEntries({
  workbookPath,
  catalog,
  cuisineType,
  fallbackCategory = 'senior',
  categoryOverrides = null,
  categoryOverridesBySource = null
}) {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const entries = [];
  const qc = [];
  const cuisine = normalizeMenuCuisine(cuisineType, 'general');

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    const workbookCategory = resolveWorkbookMenuCategory(sheetName, fallbackCategory);
    const sourceOverrides = categoryOverridesBySource?.[workbookCategory];
    const targetCategories = Array.isArray(sourceOverrides) && sourceOverrides.length
      ? sourceOverrides.map((category) => normalizeMenuCategory(category, 'senior'))
      : Array.isArray(categoryOverrides) && categoryOverrides.length
      ? categoryOverrides.map((category) => normalizeMenuCategory(category, 'senior'))
      : [workbookCategory];
    let currentMeal = '';
    let dayColumns = new Map();

    rows.forEach((row, rowIndex) => {
      const rowDayColumns = new Map();
      row.forEach((cell, columnIndex) => {
        const value = lookupKey(cell);
        if (DAY_TO_DATE.has(value)) {
          rowDayColumns.set(columnIndex, { day: value, planDate: DAY_TO_DATE.get(value) });
        }
        if (MEAL_LABELS.has(value)) {
          currentMeal = MEAL_LABELS.get(value);
        }
      });
      if (rowDayColumns.size > 0) {
        dayColumns = rowDayColumns;
        return;
      }

      if (!currentMeal || dayColumns.size === 0) return;

      for (const [columnIndex, dayInfo] of dayColumns.entries()) {
        const rawCell = normalize(row[columnIndex]);
        if (!rawCell || DAY_TO_DATE.has(lookupKey(rawCell))) continue;
        splitMenuCell(rawCell).forEach(({ item, skipped, reason }) => {
          if (skipped) {
            targetCategories.forEach((menuCategory) => {
              qc.push({
                status: 'skipped',
                sheet: sheetName,
                cuisine_type: cuisine,
                menu_category: menuCategory,
                source_menu_category: workbookCategory,
                row: rowIndex + 1,
                day: dayInfo.day,
                plan_date: dayInfo.planDate,
                meal_type: currentMeal,
                menu_item: item,
                mapped_recipe_code: '',
                mapped_recipe_name: '',
                reason
              });
            });
            return;
          }
          const recipe = findRecipe(item, currentMeal, catalog);
          if (!recipe) {
            targetCategories.forEach((menuCategory) => {
              qc.push({
                status: 'unmapped',
                sheet: sheetName,
                cuisine_type: cuisine,
                menu_category: menuCategory,
                source_menu_category: workbookCategory,
                row: rowIndex + 1,
                day: dayInfo.day,
                plan_date: dayInfo.planDate,
                meal_type: currentMeal,
                menu_item: item,
                mapped_recipe_code: '',
                mapped_recipe_name: '',
                reason: 'No matching recipe found'
              });
            });
            return;
          }
          targetCategories.forEach((menuCategory) => {
            entries.push({
              plan_date: dayInfo.planDate,
              meal_type: currentMeal,
              recipe_id: recipe.recipe_code,
              recipe_code: recipe.recipe_code,
              recipe_name: recipe.name,
              expected_servings: 1,
              source_menu_item: item,
              cuisine_type: cuisine,
              menu_category: menuCategory,
              source_menu_category: workbookCategory
            });
            qc.push({
              status: 'mapped',
              sheet: sheetName,
              cuisine_type: cuisine,
              menu_category: menuCategory,
              source_menu_category: workbookCategory,
              row: rowIndex + 1,
              day: dayInfo.day,
              plan_date: dayInfo.planDate,
              meal_type: currentMeal,
              menu_item: item,
              mapped_recipe_code: recipe.recipe_code,
              mapped_recipe_name: recipe.name,
              reason: 'Matched to recipe upload catalog'
            });
          });
        });
      }
    });
  }

  return { entries, qc };
}

function buildPlanRows(entries) {
  const grouped = new Map();
  entries.forEach((entry) => {
    const key = `${entry.cuisine_type}|${entry.menu_category}|${entry.plan_date}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  });

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, meals]) => {
      const planDate = meals[0]?.plan_date || '';
      const cuisineType = meals[0]?.cuisine_type || 'general';
      const menuCategory = meals[0]?.menu_category || 'senior';
      const sourceCategories = [...new Set(meals.map((meal) => meal.source_menu_category).filter(Boolean))];
      const deduped = new Map();
      meals.forEach((meal) => {
        const key = `${meal.meal_type}|${meal.recipe_code}|${meal.menu_category}`;
        if (!deduped.has(key)) {
          deduped.set(key, {
            meal_type: meal.meal_type,
            recipe_id: meal.recipe_id,
            recipe_code: meal.recipe_code,
            recipe_name: meal.recipe_name,
            expected_servings: meal.expected_servings,
            menu_category: meal.menu_category,
            source_menu_category: meal.source_menu_category,
            source_menu_items: [meal.source_menu_item]
          });
          return;
        }
        const existing = deduped.get(key);
        existing.source_menu_items = [...new Set([...existing.source_menu_items, meal.source_menu_item])];
      });

      const menuMeals = [...deduped.values()]
        .sort((left, right) => (
          ['breakfast', 'lunch', 'dinner'].indexOf(left.meal_type)
          - ['breakfast', 'lunch', 'dinner'].indexOf(right.meal_type)
          || left.menu_category.localeCompare(right.menu_category)
          || left.recipe_name.localeCompare(right.recipe_name)
        ));

      return {
        site_id: SITE_ID,
        site_name: SITE_NAME,
        plan_date: planDate,
        cuisine_type: cuisineType,
        menu_category: menuCategory,
        status: 'draft',
        event_name: '',
        event_date: '',
        expected_participants: '',
        budget_amount: '',
        meals: JSON.stringify(menuMeals),
        notes: `Generated ${cuisineType} ${menuCategory} menu for ${SITE_ID}${sourceCategories.length && !sourceCategories.includes(menuCategory) ? ` from ${sourceCategories.join('/')} source menu` : ''}. Expected servings defaulted to 1 per scheduled recipe because source workbook does not include headcounts.`
      };
    });
}

function rowsFor(rows, cuisineType, menuCategory) {
  return rows.filter((row) => row.cuisine_type === cuisineType && row.menu_category === menuCategory);
}

function outputName(cuisineType, menuCategory) {
  return `UPLOAD-THIS-MENU-PLAN-KBR-384-${cuisineType.toUpperCase()}-${menuCategory.toUpperCase()}-2026-09-01-TO-2026-09-05.csv`;
}

function writeCsv(filePath, headers, rows) {
  const content = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))
  ].join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function validateOutput(rows) {
  const headers = ['site_id', 'site_name', 'plan_date', 'cuisine_type', 'menu_category', 'status', 'event_name', 'event_date', 'expected_participants', 'budget_amount', 'meals', 'notes'];
  const headerErrors = validateCsvHeaders('menu-plans', headers);
  const rowErrors = [];
  rows.forEach((row, index) => {
    try {
      const values = headers.map((header) => row[header]);
      const payload = mapCsvRow('menu-plans', headers, values);
      const errors = validateMenuPlanPayload(payload);
      if (errors.length) rowErrors.push({ row: index + 2, message: errors.join(' ') });
    } catch (error) {
      rowErrors.push({ row: index + 2, message: error.message });
    }
  });
  return { headerErrors, rowErrors };
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const catalog = combineRecipeCatalogs([
  readRecipeCatalog(GENERAL_RECIPE_UPLOAD),
  readRecipeCatalog(PHILIPPINES_RECIPE_UPLOAD)
]);
const general = extractMenuEntries({
  workbookPath: GENERAL_WORKBOOK,
  catalog,
  cuisineType: 'general',
  categoryOverridesBySource: {
    senior: ['senior', 'labor', 'management_menu'],
    junior: ['junior']
  }
});
const philippines = extractMenuEntries({
  workbookPath: PHILIPPINES_WORKBOOK,
  catalog,
  cuisineType: 'philippines',
  categoryOverrides: ['senior', 'junior', 'labor']
});
const entries = [...general.entries, ...philippines.entries];
const qc = [...general.qc, ...philippines.qc];
const rows = buildPlanRows(entries);
const uploadHeaders = ['site_id', 'site_name', 'plan_date', 'cuisine_type', 'menu_category', 'status', 'event_name', 'event_date', 'expected_participants', 'budget_amount', 'meals', 'notes'];
writeCsv(OUTPUT_CSV, uploadHeaders, rows);
writeCsv(QC_CSV, ['status', 'sheet', 'cuisine_type', 'menu_category', 'source_menu_category', 'row', 'day', 'plan_date', 'meal_type', 'menu_item', 'mapped_recipe_code', 'mapped_recipe_name', 'reason'], qc);

const generatedFiles = [];
[
  ['general', 'senior'],
  ['general', 'junior'],
  ['general', 'labor'],
  ['general', 'management_menu'],
  ['philippines', 'senior'],
  ['philippines', 'junior'],
  ['philippines', 'labor']
].forEach(([cuisineType, menuCategory]) => {
  const fileRows = rowsFor(rows, cuisineType, menuCategory);
  const filePath = path.join(OUTPUT_DIR, outputName(cuisineType, menuCategory));
  writeCsv(filePath, uploadHeaders, fileRows);
  generatedFiles.push({
    cuisine_type: cuisineType,
    menu_category: menuCategory,
    file: path.resolve(filePath),
    rows: fileRows.length
  });
});

const validation = validateOutput(rows);
console.log(JSON.stringify({
  sources: [GENERAL_WORKBOOK, PHILIPPINES_WORKBOOK],
  start_date: START_DATE,
  end_date: '2026-09-05',
  upload_file: path.resolve(OUTPUT_CSV),
  qc_file: path.resolve(QC_CSV),
  generated_files: generatedFiles,
  plan_rows: rows.length,
  supported_menu_categories: MENU_CATEGORY_OPTIONS.map((option) => option.value),
  mapped_entries: qc.filter((row) => row.status === 'mapped').length,
  skipped_support_items: qc.filter((row) => row.status === 'skipped').length,
  unmapped_items: qc.filter((row) => row.status === 'unmapped').length,
  header_errors: validation.headerErrors,
  row_errors: validation.rowErrors
}, null, 2));
