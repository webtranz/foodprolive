import { validateRecipeComposition } from '../shared/recipeComposition.js';
import { validateRecipeImageReference } from '../shared/recipeImage.js';
import { listDocuments } from './db.js';
import {
  assertPayloadLocationAccess,
  buildSiteHierarchy,
  getLocationScope,
  normalizeRecipeLocationPayload,
  normalizeUserLocationPayload
} from './locationScope.js';

export async function prepareEntityPayload(user, entity, payload = {}, existing = null, context = {}) {
  const scope = context.scope || await getLocationScope(user);
  assertPayloadLocationAccess(user, entity, payload, scope);
  const merged = existing ? { ...existing, ...payload } : payload;

  if (entity === 'Site') {
    return {
      ...merged,
      ...buildSiteHierarchy(merged, existing, scope)
    };
  }

  if (entity === 'User') {
    return normalizeUserLocationPayload(merged, scope);
  }

  if (entity === 'Recipe') {
    const normalizedRecipe = normalizeRecipeLocationPayload({
      ...merged,
      image_url: String(merged.image_url || '').trim()
    }, scope);
    const imageError = validateRecipeImageReference(normalizedRecipe.image_url);
    if (imageError) {
      const error = new Error(imageError);
      error.status = 400;
      throw error;
    }
    const recipeCatalog = context.recipeCatalog || await listDocuments('Recipe', { limit: 5000 });
    const compositionErrors = validateRecipeComposition(normalizedRecipe, recipeCatalog);
    if (compositionErrors.length > 0) {
      const error = new Error(compositionErrors[0]);
      error.status = 400;
      throw error;
    }
    return normalizedRecipe;
  }

  return merged;
}
