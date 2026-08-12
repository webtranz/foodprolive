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
