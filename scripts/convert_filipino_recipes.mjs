import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sourceDir = 'C:/Users/HP/Downloads/philpino menu/Phillipino reciepe + menu';
const ingredientMasterPath = path.resolve('artifacts/inventory-ingredients-only/kbr-384-31-8-26/kbr-384-31-8-26-ingredients-upload.csv');
const outputDir = path.resolve('artifacts/filipino-recipes-bulk-upload');
const SITE_ID = 'KBR-384';
const SITE_NAME = 'KBR';

const headers = [
  'name',
  'recipe_code',
  'description',
  'recipe_type',
  'cuisine_type',
  'category',
  'servings',
  'portion_size_grams',
  'ingredients',
  'sub_recipes',
  'instructions',
  'prep_time_minutes',
  'cook_time_minutes',
  'allergens',
  'site_scope',
  'site_ids',
  'site_names',
  'image_url',
  'is_active'
];

const measureDensity = {
  soy: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  vinegar: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  sauce: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  ketchup: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  paste: { cup: 240, tbsp: 15, tsp: 5, unit: 'g' },
  oil: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  milk: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  cream: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  water: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  broth: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  stock: { cup: 240, tbsp: 15, tsp: 5, unit: 'ml' },
  sugar: { cup: 200, tbsp: 12.5, tsp: 4.2, unit: 'g' },
  salt: { cup: 288, tbsp: 18, tsp: 6, unit: 'g' },
  pepper: { cup: 128, tbsp: 8, tsp: 2.7, unit: 'g' },
  flour: { cup: 125, tbsp: 8, tsp: 2.6, unit: 'g' },
  starch: { cup: 128, tbsp: 8, tsp: 2.6, unit: 'g' },
  powder: { cup: 120, tbsp: 7, tsp: 2.3, unit: 'g' },
  beans: { cup: 200, tbsp: 12, tsp: 4, unit: 'g' },
  noodles: { cup: 100, tbsp: 6, tsp: 2, unit: 'g' },
  default: { cup: 240, tbsp: 15, tsp: 5, unit: 'g' }
};

const countWeights = [
  { pattern: /egg/i, grams: 50 },
  { pattern: /garlic/i, grams: 3 },
  { pattern: /onion/i, grams: 150 },
  { pattern: /tomato/i, grams: 120 },
  { pattern: /potato/i, grams: 180 },
  { pattern: /carrot/i, grams: 100 },
  { pattern: /pepper|capsicum/i, grams: 150 },
  { pattern: /hot\s*dog|frank|sausage/i, grams: 45 },
  { pattern: /bouillon|cube/i, grams: 20 },
  { pattern: /bay/i, grams: 0.25 },
  { pattern: /chili|pepper/i, grams: 5 },
  { pattern: /corn/i, grams: 180 },
  { pattern: /taro|gabi/i, grams: 150 },
  { pattern: /okra/i, grams: 12 },
  { pattern: /eggplant/i, grams: 150 },
  { pattern: /papaya|chayote|sayote/i, grams: 450 },
  { pattern: /fish/i, grams: 170 },
  { pattern: /can/i, grams: 155 },
  { pattern: /pack/i, grams: 55 },
  { pattern: /bunch|bundle|stalk/i, grams: 80 },
  { pattern: /thumb|ginger/i, grams: 20 },
  { pattern: /.*/, grams: 100 }
];

const manualMasterRules = [
  [/butter\s+or\s+oil|butter oil|oil from tuna/i, '221871'],
  [/bouillon|cube/i, '102426'],
  [/water spinach|kangkong|malunggay|moringa|sili leaves|chili leaves|leafy greens|spinach|pechay/i, 'PR000061'],
  [/\bwater\b|broth|stock|reserved water|rice washing|liquid/i, '224894'],
  [/tuna/i, '267650'],
  [/sardine/i, '153319'],
  [/mackerel/i, '134884'],
  [/tilapia|ruhi/i, '306998'],
  [/milk fish/i, '163290'],
  [/hamour|white fish|grouper|snapper|fillet/i, '144669'],
  [/chicken franks|chicken frank|hot dogs|frankfurters|vienna/i, '182833'],
  [/luncheon/i, '132996'],
  [/chicken breast/i, '180259'],
  [/chicken wing/i, '179446'],
  [/chicken/i, '205101'],
  [/beef|pork|chicharon/i, '141396'],
  [/eggplant/i, 'PR000012'],
  [/taro|gabi/i, 'PHMIS-016'],
  [/green papaya|chayote|sayote/i, 'PHMIS-018'],
  [/calabasa|squash|kabocha/i, 'PHMIS-013'],
  [/yardlong beans|string beans|sitaw/i, 'PHMIS-014'],
  [/bell pepper|red bell|green pepper|capsicum|finger chilies|long green chili|chili peppers|thai chili|siling labuyo|bird s eye chil|sili/i, 'PR000009'],
  [/soy sauce|dark soy/i, '100782'],
  [/vinegar/i, '367022'],
  [/fish sauce|patis/i, '273104'],
  [/oyster sauce/i, '110196'],
  [/tomato paste/i, '103023'],
  [/tomato sauce|passata|peeled tomato/i, '381887'],
  [/ketchup/i, '161290'],
  [/green olives|olives/i, '191744'],
  [/coconut milk/i, '174476'],
  [/coconut powder/i, '404322'],
  [/cooking oil|neutral oil|vegetable oil|sunflower oil|deep frying|shallow/i, '221871'],
  [/olive oil/i, '185208'],
  [/butter/i, 'DR000039'],
  [/milk powder/i, '376366'],
  [/evaporated milk/i, '153758'],
  [/milk/i, '118807'],
  [/cream/i, '342384'],
  [/cheese/i, '171301'],
  [/\begg\b|eggs/i, '142110'],
  [/shrimp/i, '110196'],
  [/spaghetti/i, '386762'],
  [/macaroni/i, '262511'],
  [/chinese noodles|canton/i, '402514'],
  [/vermicelli|sotanghon|bihon|misua|miswa|noodles/i, '402514'],
  [/cornstarch|corn starch/i, '139554'],
  [/flour|dredging/i, '188559'],
  [/raisins?/i, '404314'],
  [/sugar/i, '176065'],
  [/salt/i, '166780'],
  [/whole black pepper|peppercorn/i, 'GR001017'],
  [/black pepper|ground pepper|pepper/i, '185836'],
  [/white pepper/i, '185837'],
  [/bay/i, '147040'],
  [/curry/i, 'GR000041'],
  [/garlic powder/i, '401030'],
  [/garlic/i, 'PR000018'],
  [/ginger/i, 'PR000019'],
  [/white onion/i, 'PR000049'],
  [/onion/i, 'PR000020'],
  [/potato|hashbrown/i, 'PR000022'],
  [/carrot/i, 'PR000026'],
  [/tomato/i, 'PR000005'],
  [/cabbage|bok choy|pechay/i, 'PR000002'],
  [/green onion|spring onion|scallion/i, 'PR000065'],
  [/lemon|lime|calamansi/i, 'PR000090'],
  [/sweet corn|corn/i, '199838'],
  [/rice/i, 'GR003726']
];

const generatedMissingCodes = new Map();
const reservedGeneratedCodes = new Set(
  manualMasterRules
    .map(([, code]) => String(code || '').toUpperCase())
    .filter((code) => code.startsWith('PHMIS-'))
);
const fallbackMasterByCode = new Map([
  ['102426', {
    item_code: '102426',
    ingredient_name: 'TAFGA MAGGI CUBES CHICKEN 24/24/20G',
    unit: 'EA',
    category: 'GROCERY',
    cost_per_unit: 0.814965
  }]
]);

function nextGeneratedMissingCode() {
  let index = 1;
  while (true) {
    const code = `PHMIS-${String(index).padStart(3, '0')}`;
    if (!reservedGeneratedCodes.has(code) && ![...generatedMissingCodes.values()].includes(code)) return code;
    index += 1;
  }
}

function clean(value) {
  return String(value ?? '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))].join('\n') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const columns = rows.shift() || [];
  return rows.filter((entry) => entry.some((value) => value !== '')).map((entry) => Object.fromEntries(columns.map((column, index) => [column, entry[index] ?? ''])));
}

function extractDocxText(filePath) {
  const script = `
    Add-Type -AssemblyName System.IO.Compression;
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $stream=[System.IO.File]::Open($env:DOCX_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite);
    $zip=New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Read);
    $entry=$zip.GetEntry('word/document.xml');
    $reader=New-Object IO.StreamReader($entry.Open());
    $xml=$reader.ReadToEnd();
    $reader.Close();
    $zip.Dispose();
    $stream.Dispose();
    $text=$xml -replace '<w:tab/>',' ' -replace '</w:p>',[Environment]::NewLine -replace '<[^>]+>','' -replace '&amp;','&' -replace '&lt;','<' -replace '&gt;','>';
    Write-Output $text;
  `;
  return execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, DOCX_PATH: filePath },
    maxBuffer: 1024 * 1024
  });
}

function parseNumberToken(value) {
  const text = clean(value)
    .replace(/¼/g, '1/4')
    .replace(/½/g, '1/2')
    .replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3')
    .replace(/⅔/g, '2/3');
  if (/^\d+\/\d+$/.test(text)) {
    const [a, b] = text.split('/').map(Number);
    return b ? a / b : 0;
  }
  const mixed = text.match(/^(\d+)\s*(?:&|and)?\s*(\d+\/\d+)$/i);
  if (mixed) return Number(mixed[1]) + parseNumberToken(mixed[2]);
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return Number(text) || 0;
}

function averageQuantity(text) {
  const normalized = clean(text).replace(/[–—-]/g, ' to ');
  const token = String.raw`(?:\d+\s*(?:&|and)\s*\d+\/\d+|\d+\/\d+|¼|½|¾|⅓|⅔|\d+(?:\.\d+)?)`;
  const range = normalized.match(new RegExp(`(${token})\\s*(?:to|or)\\s*(${token})`, 'i'));
  if (range) return (parseNumberToken(range[1]) + parseNumberToken(range[2])) / 2;
  const simple = normalized.match(new RegExp(`(${token})`, 'i'));
  return simple ? parseNumberToken(simple[1]) : 0;
}

function extractQuantityAndUnit(text) {
  const normalized = clean(text)
    .replace(/¼/g, '1/4')
    .replace(/½/g, '1/2')
    .replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3')
    .replace(/⅔/g, '2/3');
  const numberToken = String.raw`(?:\d+\s*(?:&|and)\s*\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)`;
  const eachPack = normalized.match(new RegExp(`(${numberToken})(?:\\s*(?:to|or|[–—-])\\s*(${numberToken}))?\\s*(cans?|packs?|tetra packs?)\\b[^()]*\\((?:approx\\.?\\s*)?(${numberToken})\\s*(g|grams?|ml|milliliters?|millilitres?)\\s*(?:each)?`, 'i'));
  if (eachPack) {
    const count = eachPack[2]
      ? (parseNumberToken(eachPack[1]) + parseNumberToken(eachPack[2])) / 2
      : parseNumberToken(eachPack[1]);
    const size = parseNumberToken(eachPack[4]);
    const unit = /^m/i.test(eachPack[5]) ? 'ml' : 'g';
    return { quantity: count * size, unit };
  }

  const compact = normalized.match(new RegExp(`(${numberToken})(?:\\s*(?:to|or|[–—-])\\s*(${numberToken}))?\\s*(kg|kilograms?|g|grams?|lbs?|pounds?|oz|ounces?|ml|milliliters?|millilitres?|ltr|liters?|litres?|l\\b|cups?|tablespoons?|tbsp|teaspoons?|tsp|cloves?|pcs?|pieces?|cans?|packs?|bunches?|bundles?|stalks?|thumbs?|ears?|handfuls?|eggs?|cubes?)`, 'i'));
  if (compact) {
    const quantity = compact[2]
      ? (parseNumberToken(compact[1]) + parseNumberToken(compact[2])) / 2
      : parseNumberToken(compact[1]);
    return { quantity, unit: normalizeSourceUnit(compact[3]) };
  }

  return { quantity: averageQuantity(normalized), unit: detectUnit(normalized) || 'piece' };
}

function normalizeSourceUnit(unit) {
  const value = String(unit || '').toLowerCase();
  if (/^kg|kilogram/.test(value)) return 'kg';
  if (/^g|gram/.test(value)) return 'g';
  if (/^lb|pound/.test(value)) return 'lb';
  if (/^oz|ounce/.test(value)) return 'oz';
  if (/^ml|millil/.test(value)) return 'ml';
  if (/^l\b|^ltr|liter|litre/.test(value)) return 'l';
  if (/cup/.test(value)) return 'cup';
  if (/tbsp|tablespoon/.test(value)) return 'tbsp';
  if (/tsp|teaspoon/.test(value)) return 'tsp';
  if (/can/.test(value)) return 'can';
  if (/pack/.test(value)) return 'pack';
  return 'piece';
}

function detectUnit(text) {
  const lower = clean(text).toLowerCase();
  if (/\bkg\b|kilogram/.test(lower)) return 'kg';
  if (/\bg\b|gram/.test(lower)) return 'g';
  if (/\blb|pound/.test(lower)) return 'lb';
  if (/\boz|ounce/.test(lower)) return 'oz';
  if (/\bml\b/.test(lower)) return 'ml';
  if (/\bl\b|liter|litre|ltr/.test(lower)) return 'l';
  if (/\bcup/.test(lower)) return 'cup';
  if (/\btbsp|tablespoon/.test(lower)) return 'tbsp';
  if (/\btsp|teaspoon/.test(lower)) return 'tsp';
  if (/\bcan/.test(lower)) return 'can';
  if (/\bpack/.test(lower)) return 'pack';
  if (/\bclove/.test(lower)) return 'clove';
  if (/\bpiece|\bpcs?\b|cube|egg|onion|tomato|potato|carrot|pepper|fish|ear|bunch|bundle|stalk|thumb|handful/.test(lower)) return 'piece';
  return '';
}

function densityFor(name) {
  const text = normalize(name);
  const key = Object.keys(measureDensity).find((entry) => text.includes(entry));
  return measureDensity[key] || measureDensity.default;
}

function countWeightFor(name, unit) {
  const text = `${name} ${unit}`;
  return countWeights.find((entry) => entry.pattern.test(text))?.grams || 100;
}

function shouldKeepAsPieces(name, unit) {
  return /^(piece|ct)$/.test(String(unit || '').toLowerCase()) && /\beggs?\b/i.test(name);
}

function convertToUploadQuantity(quantity, unit, name) {
  if (!quantity) return { quantity: 0, unit: 'g' };
  const density = densityFor(name);
  if (unit === 'kg') return { quantity: quantity * 1000, unit: 'g' };
  if (unit === 'g') return { quantity, unit: 'g' };
  if (unit === 'lb') return { quantity: quantity * 453.59237, unit: 'g' };
  if (unit === 'oz') return { quantity: quantity * 28.349523125, unit: 'g' };
  if (unit === 'l') return { quantity, unit: 'l' };
  if (unit === 'ml') return { quantity: quantity / 1000, unit: 'l' };
  if (unit === 'cup') {
    const measured = quantity * density.cup;
    return density.unit === 'ml' ? { quantity: measured / 1000, unit: 'l' } : { quantity: measured, unit: 'g' };
  }
  if (unit === 'tbsp') {
    const measured = quantity * density.tbsp;
    return density.unit === 'ml' ? { quantity: measured / 1000, unit: 'l' } : { quantity: measured, unit: 'g' };
  }
  if (unit === 'tsp') {
    const measured = quantity * density.tsp;
    return density.unit === 'ml' ? { quantity: measured / 1000, unit: 'l' } : { quantity: measured, unit: 'g' };
  }
  if (shouldKeepAsPieces(name, unit)) return { quantity, unit: 'pieces' };
  if (unit === 'can') return { quantity: quantity * countWeightFor(name, unit), unit: 'g' };
  if (unit === 'pack') return { quantity: quantity * countWeightFor(name, unit), unit: 'g' };
  return { quantity: quantity * countWeightFor(name, unit), unit: 'g' };
}

function isMatchedVolumeItem(match) {
  const text = normalize(`${match?.ingredient_name || ''} ${match?.unit || ''}`);
  return /\b(water|juice|oil|vinegar|sauce|ketchup|milk|cream|broth|stock|liquid)\b/.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:ml|ltr|liter|litre|l)\b/i.test(match?.ingredient_name || '');
}

function normalizeForMatchedItem(parsed, match) {
  if (!isMatchedVolumeItem(match)) return parsed;
  if (parsed.unit === 'g') {
    return { ...parsed, quantity_for_10: parsed.quantity_for_10 / 1000, unit: 'l' };
  }
  if (parsed.unit === 'kg') {
    return { ...parsed, unit: 'l' };
  }
  if (parsed.unit === 'ml') {
    return { ...parsed, quantity_for_10: parsed.quantity_for_10 / 1000, unit: 'l' };
  }
  return parsed;
}

function roundUploadQuantity(quantity, unit = '') {
  const numeric = Number(quantity);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const precision = unit === 'l' ? 4 : unit === 'g' ? 2 : 3;
  return Math.max(unit === 'l' ? 0.0001 : 0.01, Number(numeric.toFixed(precision)));
}

function estimatePieceWeightGrams(name) {
  if (/\beggs?\b/i.test(name)) return 50;
  return 100;
}

function estimateServingSizeGrams(ingredients = []) {
  const total = ingredients.reduce((sum, ingredient) => {
    const quantity = Number(ingredient.quantity) || 0;
    const unit = String(ingredient.unit || '').toLowerCase();
    if (unit === 'g') return sum + quantity;
    if (unit === 'kg') return sum + (quantity * 1000);
    if (unit === 'l') return sum + (quantity * 1000);
    if (unit === 'ml') return sum + quantity;
    if (unit === 'pieces') return sum + (quantity * estimatePieceWeightGrams(ingredient.ingredient_name));
    return sum;
  }, 0);
  return Number(total.toFixed(1));
}

function cleanupIngredientName(text) {
  return clean(text)
    .replace(/^\d+(?:\.\d+)?\s*/g, '')
    .replace(/^\/\d+\s*/g, '')
    .replace(/^&\s*\d+\/\d+\s*/g, '')
    .replace(/^(?:to|or)\s+\d+(?:\.\d+)?\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(?:kg|g|grams?|lbs?|pounds?|ounces?|oz|ml|ltr|liters?|litres?|cups?|tablespoons?|tbsp|teaspoons?|tsp|cloves?|pcs?|pieces?|large|medium|small|cans?|packs?|bunches?|stalks?|thumb-sized|thumbs?|ears?|handfuls?)\b/gi, ' ')
    .replace(/\b(?:peeled|sliced|minced|chopped|crushed|cubed|diced|thinly|julienned|optional|for|about|approx|regular|fresh|ground|whole|dried|large|medium|small|cut|into|and|or|of|the|a|an|to|taste|adjust|desired|heat|serving|garnish|divided)\b/gi, ' ')
    .replace(/[^a-z0-9/&\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removePorkText(text) {
  return clean(text)
    .replace(/\bchicharon\b/gi, 'beef cracklings')
    .replace(/\bpork\s+rinds?\b/gi, 'beef cracklings')
    .replace(/\bpork\s+belly\b/gi, 'beef')
    .replace(/\bpork\s+shoulder\b/gi, 'beef')
    .replace(/\bpork\s+spare\s+ribs?\b/gi, 'beef ribs')
    .replace(/\bpork\s+liver\b/gi, 'beef liver')
    .replace(/\bground\s+pork\b/gi, 'ground beef')
    .replace(/\bpork\b/gi, 'beef')
    .replace(/\bbeef\s+or\s+beef\b/gi, 'beef')
    .replace(/\bbeef\s+cracklings\s+\(beef\s+cracklings\)/gi, 'beef cracklings');
}

function splitCompoundLine(line) {
  const text = removePorkText(line);
  if (!/\d|¼|½|¾|⅓|⅔/.test(text)) return [];
  const afterColon = text.includes(':') ? text.split(':').slice(1).join(':') : text;
  const normalized = afterColon
    .replace(/\band\b/gi, ',')
    .replace(/;+/g, ',')
    .replace(/\)\s*,/g, '),');
  const parts = normalized.split(/,(?=\s*(?:\d|¼|½|¾|⅓|⅔))/).map(clean).filter(Boolean);
  return parts.length > 1 ? parts : [afterColon];
}

function parsedIngredientFromLine(line, contextLabel = '') {
  const text = removePorkText(line);
  const { quantity, unit } = extractQuantityAndUnit(text);
  if (!quantity) return null;
  let rawName = contextLabel && !/^(aromatics|vegetables|meat|seafood|sauce|broth|garnish|base|protein|add-ins|flavor|color|optional|souring|leafy)/i.test(contextLabel)
    ? contextLabel
    : cleanupIngredientName(text);
  if (/^optional$/i.test(rawName)) rawName = cleanupIngredientName(text);
  if (!rawName || rawName.length < 2) rawName = cleanupIngredientName(text);
  const converted = convertToUploadQuantity(quantity, unit || 'piece', rawName || text);
  return {
    source_line: text,
    source_quantity: quantity,
    source_unit: unit || 'piece',
    parsed_name: rawName,
    quantity_for_10: Number(converted.quantity.toFixed(4)),
    unit: converted.unit
  };
}

function loadMaster() {
  const rows = parseCsv(fs.readFileSync(ingredientMasterPath, 'utf8')).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      String(key || '').replace(/^\uFEFF/, '').trim(),
      typeof value === 'string' ? value.trim() : value
    ])
  ));
  const byCode = new Map();
  for (const row of rows) {
    const payload = {
      item_code: row.ingredient_code || row.sku,
      ingredient_name: row.ingredient_name,
      unit: row.unit,
      category: row.item_group,
      cost_per_unit: row.unit_price
    };
    for (const code of [row.ingredient_code, row.sku].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)) {
      byCode.set(code, payload);
    }
  }
  for (const [code, payload] of fallbackMasterByCode.entries()) {
    if (!byCode.has(code)) byCode.set(code, payload);
  }
  return { rows, byCode };
}

function matchMaster(parsed, master) {
  const text = parsed.parsed_name || parsed.source_line;
  for (const [pattern, code] of manualMasterRules) {
    if (pattern.test(text)) {
      const match = master.byCode.get(code.toUpperCase()) || fallbackMasterByCode.get(code.toUpperCase());
      if (match) return { ...match, match_status: 'mapped' };
      if (String(code).toUpperCase().startsWith('PHMIS-')) {
        const missingName = clean(text || parsed.source_line);
        generatedMissingCodes.set(normalize(missingName), code.toUpperCase());
        return {
          item_code: code.toUpperCase(),
          ingredient_name: missingName,
          unit: parsed.unit,
          category: 'Filipino Recipe Ingredients',
          cost_per_unit: 0,
          match_status: 'generated_missing'
        };
      }
    }
  }
  const tokens = normalize(text).split(' ').filter((token) => token.length > 2);
  const scored = master.rows.map((row) => {
    const haystack = normalize(`${row.ingredient_name} ${row.item_group}`);
    return {
      row,
      score: tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
    };
  }).sort((a, b) => b.score - a.score)[0];
  if (scored?.score >= Math.min(2, tokens.length)) {
    return {
      item_code: scored.row.ingredient_code || scored.row.sku,
      ingredient_name: scored.row.ingredient_name,
      unit: scored.row.unit,
      category: scored.row.item_group,
      cost_per_unit: scored.row.unit_price,
      match_status: 'fuzzy'
    };
  }
  const missingKey = normalize(text || parsed.source_line);
  if (!generatedMissingCodes.has(missingKey)) {
    generatedMissingCodes.set(missingKey, nextGeneratedMissingCode());
  }
  return {
    item_code: generatedMissingCodes.get(missingKey),
    ingredient_name: text || parsed.source_line,
    unit: parsed.unit,
    category: 'Filipino Recipe Ingredients',
    cost_per_unit: 0,
    match_status: 'generated_missing'
  };
}

function recipeCode(title, index) {
  const slug = normalize(title).replace(/\s+/g, '').slice(0, 12).toUpperCase();
  return `PH-${String(index + 1).padStart(3, '0')}-${slug}`;
}

function categoryForTitle(title) {
  const text = normalize(title);
  if (text.includes('soup')) return 'Soup';
  if (text.includes('salad')) return 'Starter/Salad/Soup';
  if (text.includes('beverages')) return 'Beverages';
  if (text.includes('vegetable') || text.includes('pak bet')) return 'Vegetable';
  return 'Main Course';
}

fs.mkdirSync(outputDir, { recursive: true });
const master = loadMaster();
const files = fs.readdirSync(sourceDir).filter((file) => file.toLowerCase().endsWith('.docx')).sort();
const recipeRows = [];
const lineRows = [];
const missingRows = [];

for (const [recipeIndex, file] of files.entries()) {
  const filePath = path.join(sourceDir, file);
  const lines = extractDocxText(filePath).split(/\r?\n/).map(clean).filter(Boolean);
  const title = lines[0]?.replace(/\s*recipe\s+10(?:-\d+)?\s*(?:persons|servings)?/i, '').trim() || path.basename(file, '.docx');
  const ingredientStart = lines.findIndex((line) => /^ingredients/i.test(line));
  const candidateLines = lines.slice(Math.max(0, ingredientStart + 1));
  const ingredients = [];

  for (const line of candidateLines) {
    if (/^(instructions|method|procedure|directions)\b/i.test(line)) break;
    if (/^(the\s+)?(base|protein|aromatics|veggies|vegetables|meat\s*&\s*seafood|sauce\s*&\s*broth|garnish|add-ins|flavor\s*&\s*color)$/i.test(line.replace(/:$/, ''))) continue;
    const label = line.includes(':') ? removePorkText(line.split(':')[0]) : '';
    const parts = splitCompoundLine(line);
    for (const part of parts) {
      const parsed = parsedIngredientFromLine(part, label);
      if (!parsed) continue;
      const match = matchMaster(parsed, master);
      const uploadParsed = normalizeForMatchedItem(parsed, match);
      const perServingQty = roundUploadQuantity(uploadParsed.quantity_for_10 / 10, uploadParsed.unit);
      const ingredientLine = {
        ingredient_name: match.ingredient_name,
        quantity: perServingQty,
        unit: uploadParsed.unit,
        item_code: match.item_code,
        ingredient_id: ''
      };
      ingredients.push(ingredientLine);
      const qc = {
        file,
        recipe_name: title,
        source_line: removePorkText(parsed.source_line),
        parsed_name: removePorkText(parsed.parsed_name),
        quantity_for_10: uploadParsed.quantity_for_10,
        upload_quantity_1_serving: perServingQty,
        upload_unit: uploadParsed.unit,
        item_code: match.item_code,
        mapped_ingredient_name: match.ingredient_name,
        match_status: match.match_status
      };
      lineRows.push(qc);
      if (match.match_status === 'generated_missing') missingRows.push(qc);
    }
  }

  recipeRows.push({
    name: `${title} Filipino KBR-384 1 Serving`,
    recipe_code: recipeCode(title, recipeIndex),
    description: `${title} converted from 10-person Filipino source recipe to 1 serving.`,
    recipe_type: 'Filipino',
    cuisine_type: 'Filipino',
    category: categoryForTitle(title),
    servings: 1,
    portion_size_grams: estimateServingSizeGrams(ingredients),
    ingredients: JSON.stringify(ingredients),
    sub_recipes: '[]',
    instructions: candidateLines.map(removePorkText).join(' | '),
    prep_time_minutes: '',
    cook_time_minutes: '',
    allergens: '[]',
    site_scope: 'specific',
    site_ids: JSON.stringify([SITE_ID]),
    site_names: JSON.stringify([SITE_NAME]),
    image_url: '',
    is_active: 'true'
  });
}

const missingIngredientRows = [...new Map(missingRows.map((row) => [row.item_code, row])).values()].map((row) => ({
  item_group: 'Filipino Recipe Ingredients',
  ingredient_code: row.item_code,
  sku: row.item_code,
  ingredient_name: removePorkText(row.parsed_name),
  unit: row.upload_unit,
  unit_price: 0,
  cooking_yield_percent: 100,
  calories_per_100g: '',
  allergens: 'none',
  package_base_quantity: '',
  package_base_unit: '',
  package_parse_source: ''
}));

fs.writeFileSync(path.join(outputDir, 'UPLOAD-THIS-FILIPINO-RECIPES-KBR-384-28-1SERVING.csv'), toCsv(recipeRows, headers));
fs.writeFileSync(path.join(outputDir, 'filipino-recipes-line-mapping-qc.csv'), toCsv(lineRows, Object.keys(lineRows[0] || {})));
fs.writeFileSync(path.join(outputDir, 'filipino-missing-ingredients-to-add.csv'), toCsv(missingIngredientRows, Object.keys(missingIngredientRows[0] || {
  item_group: '', ingredient_code: '', sku: '', ingredient_name: '', unit: '', unit_price: '', cooking_yield_percent: '', calories_per_100g: '', allergens: '', package_base_quantity: '', package_base_unit: '', package_parse_source: ''
})));

console.log(JSON.stringify({
  recipes: recipeRows.length,
  ingredientLines: lineRows.length,
  generatedMissingIngredients: missingIngredientRows.length,
  outputDir
}, null, 2));
