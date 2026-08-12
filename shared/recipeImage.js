export const MAX_RECIPE_IMAGE_BYTES = 1024 * 1024;

export const RECIPE_IMAGE_MIME_TYPES = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
});

export function validateRecipeImageFile(file) {
  if (!file) return 'Select an image to upload.';
  if (!Object.hasOwn(RECIPE_IMAGE_MIME_TYPES, file.type)) {
    return 'Recipe pictures must be JPG, PNG, WebP, or GIF files.';
  }
  if (Number(file.size) > MAX_RECIPE_IMAGE_BYTES) {
    return 'Recipe pictures must not exceed 1 MB.';
  }
  return '';
}

function isPrivateHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) return true;
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function validateSecureImageUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.length > 2048) return 'The secure image path is too long.';
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return 'Enter a valid HTTPS image path.';
  }
  if (parsed.protocol !== 'https:') return 'Recipe image paths must use HTTPS.';
  if (parsed.username || parsed.password) return 'HTTPS image paths must not contain credentials.';
  if (isPrivateHostname(parsed.hostname)) return 'HTTPS image paths must use a public secure host.';
  return '';
}

export function validateRecipeImageReference(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.startsWith('/uploads/')) return '';
  return validateSecureImageUrl(candidate);
}
