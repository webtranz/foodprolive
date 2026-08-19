import { expandRecipeIngredients, validateRecipeComposition } from '../shared/recipeComposition.js';
import { validateRecipeImageReference } from '../shared/recipeImage.js';
import { calculateRecipeCostingSnapshot } from '../shared/recipeCosting.js';
import { normalizeRecipeNumericFields } from '../shared/recipeNumbers.js';
import { calculateYieldAdjustedQuantity } from '../shared/ingredientYield.js';
import { calculateIngredientCost, convertIngredientQuantity } from '../shared/ingredientUnits.js';
import { getItemCodeFromRecords } from '../shared/itemCode.js';
import {
  applyLinkedProductionLocation,
  applyRequiredOperationalLocation
} from '../shared/productionQualityLocation.js';
import {
  buildCanonicalHierarchyFields,
  isCanonicalSiteType,
  isSupportedSiteType,
  normalizeSiteType,
  validateCanonicalSiteParent
} from '../shared/siteHierarchy.js';
import { findDocument, listDocuments } from './db.js';
import { getIngredientCostSnapshots } from './ingredientSearch.js';
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
    const requestedType = String(merged.type || 'area').trim().toLowerCase();
    if (!isSupportedSiteType(requestedType)) {
      const error = new Error(`Unsupported site type "${requestedType}". Use Area, Project, or Store.`);
      error.status = 400;
      throw error;
    }
    const preserveLegacyType = Boolean(
      existing &&
      !isCanonicalSiteType(existing.type) &&
      String(payload.type || '') === String(existing.type || '')
    );
    const sitePayload = {
      ...merged,
      type: preserveLegacyType
        ? existing.type
        : normalizeSiteType(requestedType, 'area')
    };
    const parentId = String(sitePayload.parent_site_id || '').trim();
    const parent = parentId ? scope?.graph?.byId?.get(parentId) || null : null;

    if (isCanonicalSiteType(sitePayload.type)) {
      const hierarchyError = validateCanonicalSiteParent({
        type: sitePayload.type,
        parent,
        parentId
      });
      if (hierarchyError) {
        const error = new Error(hierarchyError);
        error.status = 400;
        throw error;
      }
    }

    const ancestors = [];
    const visited = new Set();
    let cursor = parent;
    while (cursor) {
      const cursorId = String(cursor.id || '');
      if (!cursorId || visited.has(cursorId)) break;
      visited.add(cursorId);
      ancestors.unshift(cursor);
      cursor = cursor.parent_site_id
        ? scope?.graph?.byId?.get(String(cursor.parent_site_id)) || null
        : null;
    }
    const hierarchy = buildSiteHierarchy(sitePayload, existing, scope);

    return {
      ...sitePayload,
      ...hierarchy,
      ...buildCanonicalHierarchyFields({ site: sitePayload, ancestors })
    };
  }

  if (entity === 'User') {
    return normalizeUserLocationPayload(merged, scope);
  }

  if (entity === 'Recipe') {
    const locationNormalizedRecipe = normalizeRecipeLocationPayload({
      ...merged,
      image_url: String(merged.image_url || '').trim()
    }, scope);
    const numericResult = normalizeRecipeNumericFields(locationNormalizedRecipe);
    if (numericResult.errors.length > 0) {
      const error = new Error(numericResult.errors[0]);
      error.status = 400;
      throw error;
    }
    const normalizedRecipe = numericResult.recipe;
    const imageError = validateRecipeImageReference(normalizedRecipe.image_url);
    if (imageError) {
      const error = new Error(imageError);
      error.status = 400;
      throw error;
    }
    const [recipeCatalog, ingredientCatalog] = await Promise.all([
      context.recipeCatalog || listDocuments('Recipe', { limit: 5000 }),
      context.ingredientCatalog || listDocuments('Ingredient', { limit: 10000 })
    ]);
    const compositionErrors = validateRecipeComposition(normalizedRecipe, recipeCatalog);
    if (compositionErrors.length > 0) {
      const error = new Error(compositionErrors[0]);
      error.status = 400;
      throw error;
    }
    const siteIds = normalizedRecipe.site_scope === 'specific'
      ? normalizedRecipe.site_ids || []
      : null;
    const expandedIngredients = expandRecipeIngredients(
      normalizedRecipe,
      recipeCatalog,
      ingredientCatalog,
      { aggregate: false }
    ).ingredients;
    const ingredientCostSnapshots = context.ingredientCostSnapshots || await getIngredientCostSnapshots({
      ingredientIds: expandedIngredients.map((line) => line.ingredient_id),
      siteIds
    });
    const costingIngredients = ingredientCatalog.map((ingredient) => {
      const snapshot = ingredientCostSnapshots[ingredient.id] || {};
      return {
        ...ingredient,
        standard_cost: ingredient.standard_cost ?? ingredient.cost_per_unit,
        last_cost: snapshot.last_cost ?? ingredient.last_cost ?? ingredient.cost_per_unit,
        average_cost: snapshot.average_cost ?? ingredient.average_cost ?? ingredient.cost_per_unit
      };
    });
    const costing = calculateRecipeCostingSnapshot(
      normalizedRecipe,
      costingIngredients,
      recipeCatalog
    );
    return {
      ...normalizedRecipe,
      total_cost: costing.total_cost,
      cost_per_serving: costing.cost_per_serving,
      cost_per_100g: costing.cost_per_100g,
      total_recipe_weight_grams: costing.total_recipe_weight_grams,
      margin_per_serving: costing.margin_per_serving,
      food_cost_percent: costing.food_cost_percent,
      costing_updated_at: new Date().toISOString()
    };
  }

  if (entity === 'ProductionBatch') {
    let preparedBatch = merged;
    if (merged.production_id) {
      const production = (
        context.production
        && String(context.production.id) === String(merged.production_id)
      ) ? context.production
        : await findDocument('Production', String(merged.production_id));
      if (!production) {
        const error = new Error('The selected production plan no longer exists.');
        error.status = 400;
        throw error;
      }

      assertPayloadLocationAccess(user, 'Production', production, scope);
      if (
        merged.recipe_id
        && production.recipe_id
        && String(merged.recipe_id) !== String(production.recipe_id)
      ) {
        const error = new Error('The selected recipe does not match the production plan.');
        error.status = 409;
        throw error;
      }

      preparedBatch = applyLinkedProductionLocation(
        merged,
        production,
        scope.sites,
        'linked production plan'
      );
      preparedBatch = {
        ...preparedBatch,
        production_id: production.id,
        recipe_id: production.recipe_id || preparedBatch.recipe_id || null,
        recipe_name: production.recipe_name || preparedBatch.recipe_name || null,
        meal_type: production.meal_type || preparedBatch.meal_type || null
      };
    } else {
      const accessibleSiteIds = [...(scope.accessibleSiteIds || [])];
      const fallbackSiteId = !existing && !scope.unrestricted
        ? user?.site_id || (accessibleSiteIds.length === 1 ? accessibleSiteIds[0] : '')
        : '';
      preparedBatch = applyRequiredOperationalLocation(
        merged,
        scope.sites,
        fallbackSiteId,
        'production batch'
      );
    }

    assertPayloadLocationAccess(user, entity, preparedBatch, scope);
    return preparedBatch;
  }

  if (entity === 'QualityControl') {
    let preparedQualityControl = merged;
    let linkedSource = null;
    let linkedLabel = 'linked production record';

    if (merged.batch_id) {
      const batch = (
        context.productionBatch
        && String(context.productionBatch.id) === String(merged.batch_id)
      ) ? context.productionBatch
        : await findDocument('ProductionBatch', String(merged.batch_id));
      if (!batch) {
        const error = new Error('The selected production batch no longer exists.');
        error.status = 400;
        throw error;
      }

      if (
        merged.production_id
        && batch.production_id
        && String(merged.production_id) !== String(batch.production_id)
      ) {
        const error = new Error('The selected production plan does not match the production batch.');
        error.status = 409;
        throw error;
      }

      linkedSource = batch;
      linkedLabel = 'linked production batch';
      let linkedProduction = null;
      if (batch.production_id) {
        linkedProduction = (
          context.production
          && String(context.production.id) === String(batch.production_id)
        ) ? context.production : await findDocument('Production', String(batch.production_id));
        const production = linkedProduction;
        if (!production) {
          const error = new Error('The production plan linked to this batch no longer exists.');
          error.status = 400;
          throw error;
        }
        if (
          batch.site_id
          && production.site_id
          && String(batch.site_id) !== String(production.site_id)
        ) {
          const error = new Error('The production batch site does not match its linked production plan.');
          error.status = 409;
          throw error;
        }
        if (!batch.site_id) {
          linkedSource = production;
          linkedLabel = 'production plan linked to the batch';
        }
      }

      preparedQualityControl = {
        ...preparedQualityControl,
        batch_id: batch.id,
        batch_number: batch.batch_number || preparedQualityControl.batch_number || null,
        production_id: linkedProduction?.id || null,
        recipe_id: batch.recipe_id || linkedProduction?.recipe_id || preparedQualityControl.recipe_id || null,
        recipe_name: batch.recipe_name || linkedProduction?.recipe_name || preparedQualityControl.recipe_name || null
      };
    } else if (merged.production_id) {
      const production = (
        context.production
        && String(context.production.id) === String(merged.production_id)
      ) ? context.production : await findDocument('Production', String(merged.production_id));
      if (!production) {
        const error = new Error('The selected production plan no longer exists.');
        error.status = 400;
        throw error;
      }
      linkedSource = production;
      linkedLabel = 'linked production plan';
      preparedQualityControl = {
        ...preparedQualityControl,
        production_id: production.id,
        recipe_id: production.recipe_id || preparedQualityControl.recipe_id || null,
        recipe_name: production.recipe_name || preparedQualityControl.recipe_name || null
      };
    }

    if (linkedSource) {
      assertPayloadLocationAccess(user, entity, linkedSource, scope);
      preparedQualityControl = applyLinkedProductionLocation(
        preparedQualityControl,
        linkedSource,
        scope.sites,
        linkedLabel
      );
    } else {
      const accessibleSiteIds = [...(scope.accessibleSiteIds || [])];
      const fallbackSiteId = !existing && !scope.unrestricted
        ? user?.site_id || (accessibleSiteIds.length === 1 ? accessibleSiteIds[0] : '')
        : '';
      preparedQualityControl = applyRequiredOperationalLocation(
        preparedQualityControl,
        scope.sites,
        fallbackSiteId,
        'quality-control inspection'
      );
    }

    assertPayloadLocationAccess(user, entity, preparedQualityControl, scope);
    return preparedQualityControl;
  }

  if (entity === 'Production') {
    const isOpenLegacyProduction = Boolean(
      existing
      && existing.yield_adjustment_applied !== true
      && String(merged.status || '').toLowerCase() !== 'completed'
    );
    const shouldRecalculate = !existing
      || isOpenLegacyProduction
      || Object.prototype.hasOwnProperty.call(payload, 'recipe_id')
      || Object.prototype.hasOwnProperty.call(payload, 'target_servings')
      || Object.prototype.hasOwnProperty.call(payload, 'ingredients_used');

    if (!shouldRecalculate || !merged.recipe_id) {
      return merged;
    }

    const [recipeCatalog, ingredientCatalog] = await Promise.all([
      context.recipeCatalog || listDocuments('Recipe', { limit: 5000 }),
      context.ingredientCatalog || listDocuments('Ingredient', { limit: 10000 })
    ]);
    const recipe = recipeCatalog.find((candidate) => String(candidate.id) === String(merged.recipe_id));
    if (!recipe) {
      const error = new Error('The selected production recipe no longer exists.');
      error.status = 400;
      throw error;
    }

    const targetServings = Math.max(0, Number(merged.target_servings) || 0);
    if (targetServings <= 0) {
      const error = new Error('Production target servings must be greater than zero.');
      error.status = 400;
      throw error;
    }

    const ingredientMap = new Map(
      ingredientCatalog.map((ingredient) => [String(ingredient.id), ingredient])
    );
    const submittedLines = new Map(
      (Array.isArray(merged.ingredients_used) ? merged.ingredients_used : [])
        .map((line) => [String(line?.ingredient_id || ''), line])
    );
    const multiplier = targetServings / Math.max(1, Number(recipe.servings) || 1);
    const expansion = expandRecipeIngredients(
      recipe,
      recipeCatalog,
      ingredientCatalog,
      { multiplier, aggregate: true }
    );

    const productionIngredients = expansion.ingredients.map((line) => {
      const ingredient = ingredientMap.get(String(line.ingredient_id)) || {};
      const submitted = submittedLines.get(String(line.ingredient_id)) || {};
      const unit = ingredient.unit || line.unit || 'unit';
      const yieldAdjustment = calculateYieldAdjustedQuantity(line.quantity, ingredient);
      const netQuantity = convertIngredientQuantity(
        line.quantity,
        line.unit || unit,
        unit,
        ingredient
      );
      const rawQuantity = convertIngredientQuantity(
        yieldAdjustment.required_raw_quantity,
        line.unit || unit,
        unit,
        ingredient
      );
      const submittedActual = submitted.actual_quantity;
      const actualQuantity = submittedActual === null || submittedActual === undefined || submittedActual === ''
        ? null
        : convertIngredientQuantity(
          Number(submittedActual) || 0,
          submitted.unit || unit,
          unit,
          ingredient
        );
      const unitCost = Number(
        ingredient.cost_per_unit
          ?? ingredient.last_cost
          ?? ingredient.average_cost
          ?? submitted.unit_cost
          ?? 0
      ) || 0;
      const estimatedCost = calculateIngredientCost(rawQuantity, unit, ingredient, unitCost);

      return {
        ingredient_id: line.ingredient_id,
        item_code: getItemCodeFromRecords([ingredient, line, submitted], null),
        ingredient_name: ingredient.name || line.ingredient_name,
        source_recipe_names: line.source_recipe_names || [],
        net_quantity: Number(netQuantity.toFixed(4)),
        planned_quantity: Number(rawQuantity.toFixed(4)),
        required_quantity: Number(rawQuantity.toFixed(4)),
        yield_adjusted_quantity: Number(rawQuantity.toFixed(4)),
        yield_multiplier: Number(yieldAdjustment.yield_multiplier.toFixed(6)),
        yield_percent: Number(yieldAdjustment.yield_percent.toFixed(2)),
        yield_source: yieldAdjustment.yield_source,
        actual_quantity: actualQuantity === null ? null : Number(actualQuantity.toFixed(4)),
        unit,
        cost_quantity: Number(rawQuantity.toFixed(4)),
        cost_unit: unit,
        unit_cost: Number(unitCost.toFixed(2)),
        estimated_cost: Number(estimatedCost.toFixed(2))
      };
    });
    const estimatedBatchCost = productionIngredients.reduce(
      (total, line) => total + Number(line.estimated_cost || 0),
      0
    );

    return {
      ...merged,
      recipe_name: recipe.name || merged.recipe_name || '',
      target_servings: targetServings,
      ingredients_used: productionIngredients,
      estimated_batch_cost: Number(estimatedBatchCost.toFixed(2)),
      estimated_cost_per_serving: Number((estimatedBatchCost / targetServings).toFixed(2)),
      yield_adjustment_applied: true,
      yield_adjustment_version: 1,
      yield_adjustment_updated_at: new Date().toISOString(),
      production_warnings: [...new Set([
        ...(Array.isArray(merged.production_warnings) ? merged.production_warnings : []),
        ...expansion.warnings,
        ...expansion.cycles.map((cycle) => `Circular recipe reference: ${cycle.join(' → ')}`)
      ])]
    };
  }

  return merged;
}
