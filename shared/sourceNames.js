export const SOURCE_NAME_OPTIONS = Object.freeze(['D365', 'Cash']);
export const DEFAULT_SOURCE_NAME = 'D365';

export function normalizeSourceName(value, fallback = DEFAULT_SOURCE_NAME) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'd365') return 'D365';
  if (normalized === 'cash') return 'Cash';
  return fallback;
}

export function isValidSourceName(value) {
  return SOURCE_NAME_OPTIONS.includes(normalizeSourceName(value, ''));
}
