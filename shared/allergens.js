function normalizeAllergenText(value) {
  return String(value || '')
    .trim()
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseMaybeJsonArray(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const unwrapped = text.replace(/^["'\s]+|["'\s]+$/g, '');
  if (!/^\[.*\]$/.test(unwrapped)) return null;

  const attempts = [
    unwrapped,
    unwrapped.replace(/""/g, '"'),
    unwrapped.replace(/\\"/g, '"')
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next representation. CSV exports sometimes preserve doubled
      // quotes inside JSON-looking allergen values, e.g. [""egg""].
    }
  }

  return null;
}

export function normalizeAllergenTags(value) {
  const output = [];
  const seen = new Set();

  const add = (candidate) => {
    const normalized = normalizeAllergenText(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  };

  const visit = (candidate) => {
    if (candidate === null || candidate === undefined) return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== 'string') {
      add(candidate);
      return;
    }

    const trimmed = candidate.trim();
    if (!trimmed || /^(none|no|n\/a|na|null|no allergen|no allergens|no tagged allergens|no allergens declared)$/i.test(trimmed)) return;

    const jsonArray = parseMaybeJsonArray(trimmed);
    if (jsonArray) {
      jsonArray.forEach(visit);
      return;
    }

    if (/[|,]/.test(trimmed)) {
      trimmed.split(/[|,]/).forEach(visit);
      return;
    }

    add(trimmed);
  };

  visit(value);
  return output;
}
