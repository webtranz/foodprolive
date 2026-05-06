export const SAR_SYMBOL = '\u20C1';
export const SAR_CODE = 'SAR';
export const SAR_NAME = 'Saudi Riyal';

function toSafeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function formatNumber(value, digits = 0, locale = 'en-US') {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(toSafeNumber(value, 0));
}

export function formatCurrency(value, options = {}) {
  const {
    locale = 'en-US',
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    showCode = false
  } = options;

  const numeric = toSafeNumber(value, 0);
  const absolute = Math.abs(numeric);
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits
  }).format(absolute);
  const prefix = numeric < 0 ? '-' : '';
  const symbol = showCode ? SAR_CODE : SAR_SYMBOL;

  return `${prefix}${symbol} ${formatted}`;
}

export function getCurrencyLabel({ code = false } = {}) {
  return code ? SAR_CODE : SAR_NAME;
}

export function replaceVisibleUSDCurrency(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  const placeholders = [];
  const protectedText = text.replace(/\$\{[^}]+\}/g, (match) => {
    const token = `__TPL_${placeholders.length}__`;
    placeholders.push(match);
    return token;
  });

  const replaced = protectedText
    .replace(/\bUSD\b/g, SAR_CODE)
    .replace(/\bDollar\b/gi, SAR_NAME)
    .replace(/(^|[^\w{])\$\s*(?=\d)/g, (_, prefix) => `${prefix}${SAR_SYMBOL} `);

  return placeholders.reduce(
    (result, original, index) => result.replace(`__TPL_${index}__`, original),
    replaced
  );
}

export function currencyAriaLabel() {
  return SAR_NAME;
}
