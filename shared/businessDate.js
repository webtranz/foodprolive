export const BUSINESS_TIME_ZONE = 'Asia/Riyadh';

export function toBusinessDateOnly(value = new Date()) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsedDateOnly = new Date(`${raw}T00:00:00.000Z`);
    return !Number.isNaN(parsedDateOnly.getTime())
      && parsedDateOnly.toISOString().slice(0, 10) === raw
      ? raw
      : null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(parsed);
  const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}
