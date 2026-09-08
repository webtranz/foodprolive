import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { convertIngredientQuantity } from '../shared/ingredientUnits.js';
import { calculateRecipeServingWeight } from '../shared/recipeWeight.js';
import { calculateRecipeCostingSnapshot } from '../shared/recipeCosting.js';
import { calculateRecipeNutrition } from '../shared/recipeNutrition.js';
import { roundStandardDecimal } from '../shared/recipeNumbers.js';
import { getItemCodeFromRecords } from '../shared/itemCode.js';
import { toBusinessDateTimeParts } from '../shared/businessDate.js';
import { resolveMenuRecipeLinks } from '../shared/menuRecipeLinks.js';
import {
  assertBulkUploadAdministrator,
  isBulkInventoryUpload
} from '../shared/bulkUploadAccess.js';
import {
  enrichIngredientItemCodes,
  enrichRecordsWithIngredientItemCodes
} from './itemCodes.js';
import {
  assertEventReadyForSubmission,
  buildEventProductionPlanPayloads,
  buildEventPurchaseRequestItems,
  calculateEventPlanningSnapshot
} from '../shared/specialEventPlanning.js';
import {
  MAX_RECIPE_IMAGE_BYTES,
  RECIPE_IMAGE_MIME_TYPES
} from '../shared/recipeImage.js';
import {
  uploadsDir,
  pool,
  withTransaction,
  listDocuments,
  listDocumentsPage,
  findDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  deleteSiteSubtree,
  initDatabase,
  getUserByToken,
  revokeToken,
  loginUser,
  inviteUser,
  deactivateUserAccount,
  createAppLog,
  listAuditLogs,
  createBulkUploadJob,
  getBulkUploadJob,
  listBulkUploadJobs,
  createEmailLog,
  invalidateRoleProfileCache
} from './db.js';
import {
  canCancelProduction,
  hasAcknowledgedMaterialRequest,
  hasAreaProductionApproval,
  hasStartableProductionInventory,
  hasAuthoritativeNoMaterialRequirement,
  normalizeProductionStatus,
  requiresAreaProductionApproval
} from '../shared/productionWorkflow.js';
import { resolveProductionFulfillmentStore } from '../shared/productionFulfillment.js';
import {
  authorizeEntityAction,
  ensureKnownEntity,
  sanitizeErpIntegrationConfig
} from './entities.js';
import { getUserEffectiveRole, hasPermission } from './entities.js';
import {
  getPosSources,
  createPosSource,
  updatePosSource,
  deletePosSource,
  getRecipeMappings,
  createRecipeMapping,
  updateRecipeMapping,
  deleteRecipeMapping,
  getSyncLogs,
  importPosOrders,
  syncPosSource,
  getDailySalesSummary,
  getSalesProductionVariance
} from './pos.js';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listPurchaseRequests,
  getPurchaseRequestById,
  getPurchaseRequestBySourceEventId,
  createPurchaseRequest,
  approvePurchaseRequest,
  autoGeneratePurchaseRequestFromLowStock,
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  listGoodsReceipts,
  getGoodsReceiptById,
  createGoodsReceipt,
  listSupplierInvoices,
  createSupplierInvoice,
  listSupplierPriceComparison,
  getSupplierPerformanceDashboard
} from './procurement.js';
import {
  receiveStock,
  deductStock,
  adjustStock,
  transferStock,
  completeProduction,
  consumeProductionInventoryReservation,
  reconcileProductionInventoryCommitment,
  releaseProductionInventoryCommitment,
  hasProductionInventoryCommitment,
  getStockOnHandReport,
  getStockMovementReport,
  getExpiryReport,
  getVelocityReports,
  getInventoryValuationReport,
  listInventoryLots
} from './inventory.js';
import { getInventoryValueHistoryReport } from './inventoryValueReport.js';
import {
  extractD365WarehouseId,
  stableD365Hash
} from '../shared/d365Inventory.js';
import { resolveAuthorizedD365PullStore } from './erpInventoryImport.js';
import {
  exportToErp,
  getD365ImportLogDetails,
  importD365Ingredients,
  importD365Inventory,
  previewD365InventoryImport,
  pullD365InventoryRecords,
  retryErpSync,
  listErpLogs
} from './erpIntegration.js';
import {
  buildForecastSummary,
  runForecastScenario
} from './forecasting.js';
import {
  getMenuPlanPRContext,
  saveMenuPlanPRScheduleConfig,
  generatePurchaseRequestFromMenuPlans
} from './menuPlanningProcurement.js';
import {
  buildApiObjectResponse,
  buildMenuPlanWeekRange,
  filterMenuPlansForWeek,
  summarizeMenuPlanCostPreview,
  validateSiteAndDateInput,
  validateMenuPlanPayload,
  validatePRGenerationPayload,
  validateFoodWasteContextInput
} from './menuPlanningApi.js';
import {
  allocateBatchOverproductionWaste,
  buildBatchOverproductionDishSummary,
  buildFoodWasteMenuPlanSummary,
  decorateFoodWasteRecord,
  getFoodWasteRecordingWindow,
  getLatestSuccessfulProductionCompletedAt,
  isApprovalOnlyWastePatch,
  normalizeFoodWasteWeightGrams,
  normalizeMealType
} from './foodWaste.js';
import {
  SPECIAL_EVENT_STATUSES,
  appendApprovalHistory,
  assertSpecialEventBudgetApproval,
  buildSpecialEventWritePayload,
  createApprovalHistoryEntry,
  isSpecialEventPlan
} from './specialEvents.js';
import {
  getLocationScope,
  filterRecordsByLocation,
  assertPayloadLocationAccess,
  invalidateLocationScopeCache,
  isLocationScopedEntity,
  hasUnrestrictedLocationAccess
} from './locationScope.js';
import {
  assertInventoryLedgerDeleteAllowed,
  prepareEntityPayload,
  scaleApprovedProductionSnapshot
} from './entityPreparation.js';
import { auditAction } from './audit.js';
import {
  createTemplateCsv,
  getUtilityModule,
  listUtilityModules,
  serializeReportRows
} from './utilities.js';
import { enqueueBulkUpload, resumeBulkUploadQueue, stopBulkUploadQueue } from './bulkUploadQueue.js';
import { getIngredientCostSnapshots, searchIngredients } from './ingredientSearch.js';
import { closeRealtime, subscribeToEntityEvents } from './realtime.js';
import { isValidSourceName, normalizeSourceName } from '../shared/sourceNames.js';
import { normalizeMenuCategory, normalizeMenuCuisine } from '../shared/menuCategories.js';
import { normalizeSiteType, SITE_HIERARCHY_TYPES } from '../shared/siteHierarchy.js';
import { hasAdminAccess } from './accessControl.js';
import { getManagementDashboardSnapshot } from './managementDashboard.js';
import {
  getMealServiceReport,
  getProducedItemAvailability,
  previewMealService,
  recordMealServiceAttendance,
  reverseMealServiceAttendance,
  resolveLegacyProductionMenuClassification,
  updateMealServicePortionSize
} from './mealService.js';
import {
  createObjectKey,
  getStoredObject,
  objectReference,
  objectStorageEnabled,
  proxiedObjectPath,
  publicObjectPath,
  putStoredObject,
  removeStoredReference
} from './objectStorage.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const rootDir = path.resolve(process.cwd());
const distDir = path.join(rootDir, 'dist');
const databaseInitAttempts = Number(process.env.DATABASE_INIT_ATTEMPTS || 30);
const databaseInitDelayMs = Number(process.env.DATABASE_INIT_DELAY_MS || 2000);
const costingCatalogCacheTtlMs = Math.max(0, Number(process.env.COSTING_CATALOG_CACHE_TTL_MS || 10000));
let costingCatalogCache = null;
let costingCatalogPromise = null;
let costingCatalogGeneration = 0;
const recipeDecorationCache = new Map();
const maximumRecipeDecorationCacheEntries = 10000;
const activeEventResponses = new Set();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));
app.get('/files/*', async (request, response, next) => {
  if (!objectStorageEnabled) return response.status(404).json({ message: 'File not found' });
  try {
    const key = request.params[0];
    if (!key) return response.status(404).json({ message: 'File not found' });
    const object = await getStoredObject(key);
    response.setHeader('Content-Type', object.contentType);
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (object.contentLength) response.setHeader('Content-Length', String(object.contentLength));
    return response.send(object.buffer);
  } catch (error) {
    if (/\(404\)/.test(error.message || '')) return response.status(404).json({ message: 'File not found' });
    return next(error);
  }
});

const localStorage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '');
    const baseName = path.basename(file.originalname || 'upload', extension).replace(/[^a-zA-Z0-9-_]/g, '-');
    callback(null, `${Date.now()}-${baseName}${extension}`);
  }
});
const storage = objectStorageEnabled ? multer.memoryStorage() : localStorage;

const upload = multer({
  storage,
  limits: {
    fileSize: Math.max(1, Number(process.env.GENERAL_UPLOAD_MAX_MB || 25)) * 1024 * 1024,
    files: 1
  }
});

const localRecipeImageStorage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadsDir),
  filename: (_request, file, callback) => {
    const extension = RECIPE_IMAGE_MIME_TYPES[file.mimetype] || '';
    callback(null, `${Date.now()}-recipe-${Math.random().toString(36).slice(2, 10)}${extension}`);
  }
});
const recipeImageStorage = objectStorageEnabled ? multer.memoryStorage() : localRecipeImageStorage;

const recipeImageUpload = multer({
  storage: recipeImageStorage,
  limits: { fileSize: MAX_RECIPE_IMAGE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!Object.hasOwn(RECIPE_IMAGE_MIME_TYPES, file.mimetype)) {
      return callback(new Error('Recipe pictures must be JPG, PNG, WebP, or GIF files.'));
    }
    return callback(null, true);
  }
});

const bulkUpload = multer({
  storage,
  limits: {
    fileSize: Math.max(1, Number(process.env.BULK_UPLOAD_MAX_MB || 25)) * 1024 * 1024,
    files: 1
  },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const allowed = extension === '.csv' || file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel';
    if (!allowed) return callback(new Error('Bulk uploads must be CSV files.'));
    return callback(null, true);
  }
});

async function persistUploadedFile(file, prefix = 'uploads') {
  if (!file) return null;
  if (!objectStorageEnabled) {
    const fileUrl = `/uploads/${file.filename}`;
    return { reference: file.path, fileUrl };
  }
  const storageName = prefix === 'recipe-images'
    ? `recipe${RECIPE_IMAGE_MIME_TYPES[file.mimetype] || ''}`
    : file.originalname;
  const key = createObjectKey(storageName, prefix);
  await putStoredObject(key, file.buffer, file.mimetype || 'application/octet-stream');
  return {
    reference: objectReference(key),
    fileUrl: proxiedObjectPath(key),
    publicFileUrl: publicObjectPath(key)
  };
}

function absoluteFileUrl(request, fileUrl) {
  return /^https:\/\//i.test(fileUrl) ? fileUrl : `${resolvePublicBaseUrl(request)}${fileUrl}`;
}

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function initDatabaseWithRetry() {
  let lastError = null;

  for (let attempt = 1; attempt <= databaseInitAttempts; attempt += 1) {
    try {
      await initDatabase();
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Database initialization attempt ${attempt}/${databaseInitAttempts} failed: ${error.message}`);

      if (attempt < databaseInitAttempts) {
        await delay(databaseInitDelayMs);
      }
    }
  }

  throw lastError;
}

function getBearerToken(request) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireAuth(request, response, next) {
  const token = getBearerToken(request);
  const user = await getUserByToken(token);

  if (!user) {
    return response.status(401).json({ message: 'Authentication required' });
  }

  request.user = user;
  request.token = token;
  return next();
}

function requireRole(roles) {
  return (request, response, next) => {
    const effectiveRole = getUserEffectiveRole(request.user);
    if (!request.user || !roles.includes(effectiveRole)) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

function requirePermission(permission) {
  return (request, response, next) => {
    if (!request.user || !hasPermission(request.user, permission)) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

function requireAnyPermission(permissions) {
  return (request, response, next) => {
    if (!request.user || !permissions.some((permission) => hasPermission(request.user, permission))) {
      return response.status(403).json({ message: 'You do not have permission to access this resource' });
    }
    return next();
  };
}

function requireBulkUploadAdministrator(request, response, next) {
  try {
    assertBulkUploadAdministrator(request.user);
    return next();
  } catch (error) {
    return response.status(error.status || 403).json({ message: error.message });
  }
}

async function getEntityLocationContext(user, entity) {
  if (!isLocationScopedEntity(entity) || hasUnrestrictedLocationAccess(user)) {
    return { scope: null, location: null };
  }
  const scope = await getLocationScope(user);
  const location = {
    unrestricted: false,
    accessibleSiteIds: [...scope.accessibleSiteIds]
  };
  return { scope, location };
}

async function scopeEntityRecords(user, entity, records = [], existingScope = null) {
  if (!isLocationScopedEntity(entity) || hasUnrestrictedLocationAccess(user)) {
    return records;
  }
  const scope = existingScope || await getLocationScope(user);
  return filterRecordsByLocation(user, entity, records, scope);
}

function invalidateEntityAccessCaches(entity) {
  if (entity === 'Site') invalidateLocationScopeCache();
  if (entity === 'RoleProfile') invalidateRoleProfileCache();
}

function recordChanged(entity) {
  invalidateEntityDataCaches(entity);
}

async function decorateRecipesWithServingWeights(records = []) {
  if (!Array.isArray(records) || records.length === 0) return records;
  const { recipeCatalog, ingredients } = await getCostingCatalogs();

  return records.map((recipe) => {
    const cacheKey = `${costingCatalogGeneration}:${recipe.id}:${recipe.updated_date || recipe.updated_at || ''}`;
    const cached = costingCatalogCacheTtlMs > 0 ? recipeDecorationCache.get(cacheKey) : null;
    if (cached) return cached;
    const weight = calculateRecipeServingWeight(recipe, recipeCatalog, ingredients);
    const costing = calculateRecipeCostingSnapshot(recipe, ingredients, recipeCatalog);
    const totalCost = recipe.total_cost ?? costing.total_cost;
    const servings = Math.max(1, Number(recipe.servings) || 1);
    const costPerServing = recipe.cost_per_serving
      ?? (totalCost === null ? null : roundStandardDecimal(totalCost / servings, 4));
    const costPer100g = recipe.cost_per_100g
      ?? (totalCost !== null && weight.cooked_total_grams > 0
        ? roundStandardDecimal((totalCost / weight.cooked_total_grams) * 100, 4)
        : null);
    const sellingPrice = recipe.target_selling_price === null || recipe.target_selling_price === undefined || recipe.target_selling_price === ''
      ? null
      : Number(recipe.target_selling_price);
    const decorated = {
      ...recipe,
      // Rebuild derived values on reads too: imported and older recipes must
      // not need a manual edit/save to acquire nutrition and allergen details.
      ...calculateRecipeNutrition(recipe, recipeCatalog, ingredients),
      total_cost: totalCost,
      cost_per_serving: costPerServing,
      cost_per_100g: costPer100g,
      total_recipe_weight_grams: recipe.total_recipe_weight_grams ?? costing.total_recipe_weight_grams,
      margin_per_serving: recipe.margin_per_serving
        ?? (sellingPrice === null || costPerServing === null ? null : roundStandardDecimal(sellingPrice - costPerServing, 4)),
      food_cost_percent: recipe.food_cost_percent
        ?? (sellingPrice === null || sellingPrice <= 0 || costPerServing === null
          ? null
          : roundStandardDecimal((costPerServing / sellingPrice) * 100, 2)),
      grams_per_serving: weight.grams_per_serving,
      raw_grams_per_serving: weight.raw_grams_per_serving,
      serving_weight_complete: weight.is_complete,
      serving_weight_basis: 'cooked_yield_adjusted',
      serving_weight_warnings: weight.warnings
    };
    if (costingCatalogCacheTtlMs > 0) {
      recipeDecorationCache.set(cacheKey, decorated);
      if (recipeDecorationCache.size > maximumRecipeDecorationCacheEntries) {
        recipeDecorationCache.delete(recipeDecorationCache.keys().next().value);
      }
    }
    return decorated;
  });
}

async function getCostingCatalogs() {
  if (costingCatalogCacheTtlMs > 0 && costingCatalogCache?.expiresAt > Date.now()) {
    return costingCatalogCache.value;
  }
  if (costingCatalogPromise) return costingCatalogPromise;

  const generation = costingCatalogGeneration;
  const loadingPromise = Promise.all([
    listDocuments('Recipe', { limit: 5000 }),
    listDocuments('Ingredient', { limit: 5000 })
  ]).then(([recipeCatalog, ingredients]) => {
    const value = { recipeCatalog, ingredients };
    if (costingCatalogCacheTtlMs > 0 && generation === costingCatalogGeneration) {
      costingCatalogGeneration += 1;
      recipeDecorationCache.clear();
      costingCatalogCache = {
        value,
        expiresAt: Date.now() + costingCatalogCacheTtlMs
      };
    }
    return value;
  }).finally(() => {
    if (costingCatalogPromise === loadingPromise) costingCatalogPromise = null;
  });
  costingCatalogPromise = loadingPromise;

  return costingCatalogPromise;
}

function invalidateEntityDataCaches(entity) {
  if (entity === 'Recipe' || entity === 'Ingredient') {
    costingCatalogGeneration += 1;
    costingCatalogCache = null;
    costingCatalogPromise = null;
    recipeDecorationCache.clear();
  }
}

async function decorateEntityRecords(entity, records = [], user = null) {
  if (entity === 'MenuPlan' && records.length) {
    const scope = await getLocationScope(user);
    const recipes = await scopeEntityRecords(user, 'Recipe', await listDocuments('Recipe', { limit: 5000 }));
    return records.map((plan) => resolveMenuRecipeLinks(plan, recipes, scope.sites));
  }
  if (entity === 'Recipe') {
    return decorateRecipesWithServingWeights(records);
  }
  if (entity === 'Inventory') {
    return enrichIngredientItemCodes(records);
  }
  if (entity === 'ERPIntegrationConfig') {
    return records.map((record) => sanitizeErpIntegrationConfig(record, user));
  }
  return records;
}

app.get('/api/events', requireAuth, async (request, response, next) => {
  try {
    const scope = hasUnrestrictedLocationAccess(request.user)
      ? null
      : await getLocationScope(request.user);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();
    activeEventResponses.add(response);

    const send = (eventName, payload) => {
      if (response.writableEnded) return;
      response.write(`event: ${eventName}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const canReceive = (event) => {
      if (!scope) return true;
      const directSiteIds = [event.site_id, ...(Array.isArray(event.site_ids) ? event.site_ids : [])]
        .filter(Boolean)
        .map(String);
      return directSiteIds.length === 0
        || directSiteIds.some((siteId) => scope.accessibleSiteIds.has(siteId));
    };
    const unsubscribe = await subscribeToEntityEvents((event) => {
      if (canReceive(event)) send('entity-change', event);
    });
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': heartbeat\n\n');
    }, 25000);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      activeEventResponses.delete(response);
      if (!response.writableEnded) response.end();
    };
    request.once('close', close);
    send('ready', { connected: true, occurred_at: new Date().toISOString() });
  } catch (error) {
    if (!response.headersSent) return next(error);
    return response.end();
  }
});

function filterRowsByAccessibleSites(rows = [], scope, fields = ['site_id']) {
  if (scope?.unrestricted) {
    return rows;
  }

  return rows.filter((row) => {
    const siteIds = fields
      .map((field) => row?.[field])
      .filter(Boolean);
    return siteIds.length > 0
      && siteIds.every((siteId) => scope.accessibleSiteIds.has(String(siteId)));
  });
}

function assertProcurementRecordLocationAccess(record, scope, label) {
  if (!filterRowsByAccessibleSites([record], scope).length) {
    const error = new Error(`${label} is outside your assigned location scope`);
    error.status = 403;
    throw error;
  }
  return record;
}

function numericMatch(input, fallback = 0) {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function buildInventoryShortages(production = {}, inventoryRows = [], ingredients = []) {
  return (Array.isArray(production.ingredients_used) ? production.ingredients_used : [])
    .map((ingredientLine) => {
      const sourceRequiredQuantity = numericMatch(
        ingredientLine.planned_quantity ?? ingredientLine.adjusted_quantity ?? ingredientLine.required_quantity,
        0
      );
      const inventoryItem = inventoryRows.find((item) => item.ingredient_id === ingredientLine.ingredient_id);
      const ingredientMaster = ingredients.find((item) => item.id === ingredientLine.ingredient_id);
      const inventoryUnit = ingredientMaster?.unit || inventoryItem?.unit || ingredientLine.unit || 'unit';
      const requiredQuantity = convertIngredientQuantity(
        sourceRequiredQuantity,
        ingredientLine.unit || inventoryUnit,
        inventoryUnit,
        ingredientMaster
      );
      const currentStock = convertIngredientQuantity(
        numericMatch(inventoryItem?.quantity, 0),
        inventoryItem?.unit || inventoryUnit,
        inventoryUnit,
        ingredientMaster
      );
      const shortageQuantity = Math.max(0, requiredQuantity - currentStock);
      const unitCost = numericMatch(
        ingredientLine.unit_cost ?? ingredientMaster?.cost_per_unit ?? inventoryItem?.average_unit_cost,
        0
      );

      return {
        ingredient_id: ingredientLine.ingredient_id,
        item_code: getItemCodeFromRecords([ingredientMaster, ingredientLine, inventoryItem], null),
        ingredient_name: ingredientLine.ingredient_name,
        unit: inventoryUnit,
        required_quantity: Number(requiredQuantity.toFixed(2)),
        current_stock: Number(currentStock.toFixed(2)),
        shortage_quantity: Number(shortageQuantity.toFixed(2)),
        estimated_unit_cost: Number(unitCost.toFixed(2)),
        estimated_cost: Number((shortageQuantity * unitCost).toFixed(2))
      };
    })
    .filter((item) => item.ingredient_id && item.shortage_quantity > 0);
}

function normalizeProductionReviewAction(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function appendProductionApprovalHistory(existing, entry) {
  return [
    ...(Array.isArray(existing?.approval_history) ? existing.approval_history : []),
    entry
  ];
}

function getProductionWorkflowAuditAction(record) {
  return {
    submitted: 'PRODUCTION_SUBMITTED_FOR_PM_APPROVAL',
    pm_approved: 'PRODUCTION_PM_APPROVED',
    pm_rejected: 'PRODUCTION_PM_REJECTED_AND_RETURNED',
    changes_requested: 'PRODUCTION_CHANGES_REQUESTED',
    area_approved: 'PRODUCTION_AREA_APPROVED',
    area_rejected: 'PRODUCTION_AREA_REJECTED_AND_RETURNED',
    procurement_acknowledged: 'PRODUCTION_PROCUREMENT_ACKNOWLEDGED',
    procurement_not_required: 'PRODUCTION_PROCUREMENT_NOT_REQUIRED',
    production_started: 'PRODUCTION_STARTED',
    production_completed: 'PRODUCTION_COMPLETED'
  }[normalizeProductionReviewAction(record?.last_review_action)] || 'PRODUCTION_UPDATE';
}

function applyProductionWorkflowMetadata(user, payload, existing = null, workflowIntent = {}) {
  const now = new Date().toISOString();
  const currentStatus = normalizeProductionStatus(existing?.status, 'draft');
  const nextStatus = normalizeProductionStatus(payload?.status, currentStatus);
  const reviewAction = normalizeProductionReviewAction(workflowIntent?.review_action);
  const reviewReason = String(
    workflowIntent?.rejection_reason || workflowIntent?.review_notes || ''
  ).trim() || null;
  const actor = {
    id: user?.id || null,
    email: user?.email || null,
    name: user?.full_name || user?.email || null
  };
  const prepared = { ...payload };
  let historyAction = '';
  let historyStage = '';

  if (!existing && nextStatus === 'pending_approval') {
    Object.assign(prepared, {
      submitted_by: actor.email,
      submitted_by_name: actor.name,
      submitted_at: now
    });
  }

  if (currentStatus !== nextStatus && nextStatus === 'pending_approval') {
    historyAction = 'submitted';
    historyStage = 'project_manager';
    Object.assign(prepared, {
      submitted_by: actor.email,
      submitted_by_name: actor.name,
      submitted_at: now,
      pm_approval_status: 'pending',
      area_approval_status: null,
      area_approved_by: null,
      area_approved_by_name: null,
      area_approved_at: null,
      procurement_approved_by: null,
      procurement_approved_by_name: null,
      procurement_approved_at: null,
      rejection_reason: null,
      rejection_stage: null,
      rejection_return_status: null,
      last_review_action: 'submitted'
    });
  }

  if (currentStatus === 'pending_approval' && nextStatus === 'pending_procurement') {
    historyAction = 'pm_approved';
    historyStage = 'project_manager';
    Object.assign(prepared, {
      pm_approval_status: 'approved',
      pm_approved_by: actor.email,
      pm_approved_by_name: actor.name,
      pm_approved_at: now,
      reviewed_at: now,
      procurement_approved_by: null,
      procurement_approved_by_name: null,
      procurement_approved_at: null,
      rejection_reason: null,
      rejection_stage: null,
      rejection_return_status: null,
      last_review_action: 'pm_approved'
    });
  }

  if (currentStatus === 'pending_production' && nextStatus === 'approved') {
    historyAction = 'area_approved';
    historyStage = 'area_manager';
    Object.assign(prepared, {
      area_approval_status: 'approved',
      area_approved_by: actor.email,
      area_approved_by_name: actor.name,
      area_approved_at: now,
      reviewed_at: now,
      rejection_reason: null,
      rejection_stage: null,
      rejection_return_status: null,
      last_review_action: 'area_approved'
    });
  }

  if (
    currentStatus === 'pending_approval'
    && nextStatus === 'changes_requested'
    && ['changes_requested', 'rejected'].includes(reviewAction)
  ) {
    historyAction = reviewAction === 'rejected' ? 'pm_rejected' : 'changes_requested';
    historyStage = 'project_manager';
    Object.assign(prepared, {
      pm_approval_status: reviewAction,
      pm_reviewed_by: actor.email,
      pm_reviewed_by_name: actor.name,
      pm_reviewed_at: now,
      reviewed_at: now,
      procurement_approved_by: null,
      procurement_approved_by_name: null,
      procurement_approved_at: null,
      rejection_reason: reviewReason,
      rejection_stage: 'project_manager',
      rejection_return_status: 'changes_requested',
      last_review_action: historyAction
    });
  }

  if (
    ['pending_production', 'approved'].includes(currentStatus)
    && nextStatus === 'pending_procurement'
    && reviewAction === 'rejected'
  ) {
    historyAction = 'area_rejected';
    historyStage = 'area_manager';
    Object.assign(prepared, {
      area_approval_status: 'rejected',
      area_approved_by: null,
      area_approved_by_name: null,
      area_approved_at: null,
      area_reviewed_by: actor.email,
      area_reviewed_by_name: actor.name,
      area_reviewed_at: now,
      reviewed_at: now,
      procurement_approved_by: null,
      procurement_approved_by_name: null,
      procurement_approved_at: null,
      rejection_reason: reviewReason,
      rejection_stage: 'area_manager',
      rejection_return_status: 'pending_procurement',
      last_review_action: 'area_rejected'
    });
  }

  if (nextStatus === 'changes_requested' && currentStatus === 'pending_production') {
    historyAction = 'changes_requested';
    historyStage = 'area_manager';
    Object.assign(prepared, {
      area_approval_status: 'changes_requested',
      area_reviewed_by: actor.email,
      area_reviewed_by_name: actor.name,
      area_reviewed_at: now,
      reviewed_at: now,
      procurement_approved_by: null,
      procurement_approved_by_name: null,
      procurement_approved_at: null,
      rejection_reason: reviewReason,
      rejection_stage: 'area_manager',
      rejection_return_status: 'changes_requested',
      last_review_action: 'changes_requested'
    });
  }

  if (currentStatus === 'approved' && nextStatus === 'in_progress') {
    historyAction = 'production_started';
    historyStage = 'production';
    Object.assign(prepared, {
      started_by: actor.email,
      started_by_name: actor.name,
      started_at: now,
      last_review_action: 'production_started'
    });
  }

  if (currentStatus !== nextStatus && historyAction) {
    prepared.approval_history = appendProductionApprovalHistory(existing, {
      action: historyAction,
      stage: historyStage || null,
      from_status: currentStatus || null,
      to_status: nextStatus || null,
      actor_id: actor.id,
      actor_email: actor.email,
      actor_name: actor.name,
      reason: reviewReason,
      note: String(workflowIntent?.review_notes || '').trim() || reviewReason,
      timestamp: now
    });
  }

  return prepared;
}

async function assertProductionStartPrerequisites(production, executor = null, user = null) {
  // Existing approved records may predate reservation support. The atomic
  // start transaction repairs/reserves those records immediately before it
  // consumes stock, while current records must already pass the shared gate.
  if (!hasAreaProductionApproval(production) || !hasAcknowledgedMaterialRequest(production)) {
    const error = new Error('Production cannot start until Store / Procurement has acknowledged the material request and inventory is fully reserved.');
    error.status = 409;
    throw error;
  }

  const siteCatalog = await listDocuments('Site', { limit: 5000 }, executor || undefined);
  const fulfillmentStore = resolveProductionFulfillmentStore(production, siteCatalog);
  if (user) {
    const scope = await getLocationScope(user);
    if (!scope.unrestricted && !scope.accessibleSiteIds.has(String(fulfillmentStore.id))) {
      const error = new Error('You do not have access to the fulfillment Store for this production');
      error.status = 403;
      throw error;
    }
  }
  const materialStatus = String(production.material_request_status || '').toLowerCase();

  if (materialStatus === 'not_required') {
    if (!hasAuthoritativeNoMaterialRequirement(production)) {
      const error = new Error('Production cannot start because its no-material requirement is not authoritative. Reconcile procurement first.');
      error.status = 409;
      throw error;
    }
    return fulfillmentStore;
  }

  const materialRequest = production.linked_material_request_id
    ? await findDocument('MaterialRequest', production.linked_material_request_id, executor || undefined, Boolean(executor))
    : null;
  if (
    !materialRequest
    || String(materialRequest.status || '').toLowerCase() !== 'acknowledged'
    || String(materialRequest.source_production_id || '') !== String(production.id)
    || String(materialRequest.site_id || '') !== String(fulfillmentStore.id)
  ) {
    const error = new Error('The linked material request has not been acknowledged by Store / Procurement.');
    error.status = 409;
    throw error;
  }
  return fulfillmentStore;
}

async function reconcileProductionInventoryForWorkflow({
  production,
  user,
  executor,
  fulfillmentStore = null,
  siteCatalog = null,
  desiredIngredients = null,
  operation,
  reason = '',
  expectedRevision = null,
  targetServings = null
}) {
  const sites = siteCatalog || await listDocuments('Site', { limit: 5000 }, executor);
  const store = fulfillmentStore || resolveProductionFulfillmentStore(production, sites);
  const [ingredients, inventory] = await Promise.all([
    listDocuments('Ingredient', { limit: 10000 }, executor),
    listDocuments('Inventory', {
      filters: { site_id: store.id },
      limit: 10000
    }, executor)
  ]);
  return reconcileProductionInventoryCommitment({
    production,
    actor: user,
    desiredIngredients: desiredIngredients ?? production.ingredients_used ?? [],
    operation,
    reason,
    allowShortage: false,
    expectedRevision,
    siteCatalog: sites,
    ingredientCatalog: ingredients,
    inventoryCatalog: inventory,
    fulfillmentStore: store,
    asOfDate: production.production_date || null,
    targetServings: targetServings ?? production.target_servings ?? null
  }, executor);
}

async function syncMaterialRequestForProduction(
  user,
  production,
  mode = 'draft',
  executor = null,
  forceFreshAcknowledgement = false,
  preserveApprovedSnapshot = false
) {
  if (!production?.id) {
    return null;
  }

  if (
    !preserveApprovedSnapshot
    && production.recipe_snapshot_locked !== true
    && production.yield_snapshot_source !== 'server_recipe_expansion'
    && production.recipe_id
    && String(production.status || '').toLowerCase() !== 'completed'
  ) {
    const yieldPreparedProduction = await prepareEntityPayload(
      user,
      'Production',
      { ingredients_used: production.ingredients_used || [] },
      production
    );
    production = await updateDocument('Production', production.id, yieldPreparedProduction, executor);
  }

  const normalizedMode = String(mode || 'draft').toLowerCase();
  const isDraftMode = normalizedMode === 'draft';

  if (!isDraftMode && String(production.status || '') !== 'pending_procurement') {
    const error = new Error('Material requests can only be activated after PM approval.');
    error.status = 400;
    throw error;
  }

  const existingRequests = await listDocuments('MaterialRequest', {
    filters: { source_production_id: production.id },
    sort: '-request_date',
    limit: 20
  }, executor || undefined);

  const [siteCatalog, ingredients] = await Promise.all([
    listDocuments('Site', { limit: 5000 }, executor || undefined),
    listDocuments('Ingredient', { limit: 10000 }, executor || undefined)
  ]);
  const productionSite = siteCatalog.find((site) => String(site.id) === String(production.site_id));
  const fulfillmentStore = resolveProductionFulfillmentStore(production, siteCatalog);
  const inventorySiteId = fulfillmentStore?.id || production.site_id;
  const inventorySiteName = fulfillmentStore?.name || production.site_name;
  const inventoryRows = await listDocuments('Inventory', {
    filters: { site_id: inventorySiteId },
    limit: 10000
  }, executor || undefined);

  const productionItems = (Array.isArray(production.ingredients_used) ? production.ingredients_used : []).map((item) => {
    const inventoryItem = inventoryRows.find((inventoryRow) => inventoryRow.ingredient_id === item.ingredient_id);
    const ingredientMaster = ingredients.find((ingredient) => ingredient.id === item.ingredient_id);
    const sourceRequiredQuantity = numericMatch(
      item.planned_quantity ?? item.adjusted_quantity ?? item.required_quantity,
      0
    );
    const inventoryUnit = ingredientMaster?.unit || inventoryItem?.unit || item.unit || 'unit';
    const requiredQuantity = convertIngredientQuantity(
      sourceRequiredQuantity,
      item.unit || inventoryUnit,
      inventoryUnit,
      ingredientMaster
    );
    const currentStock = convertIngredientQuantity(
      numericMatch(inventoryItem?.quantity, 0),
      inventoryItem?.unit || inventoryUnit,
      inventoryUnit,
      ingredientMaster
    );
    const unitCost = numericMatch(
      item.unit_cost ?? ingredientMaster?.cost_per_unit ?? inventoryItem?.average_unit_cost,
      0
    );

    return {
      ingredient_id: item.ingredient_id,
      item_code: getItemCodeFromRecords([ingredientMaster, item, inventoryItem], null),
      ingredient_name: item.ingredient_name,
      required_quantity: requiredQuantity,
      current_stock: currentStock,
      shortage_quantity: Math.max(0, requiredQuantity - currentStock),
      request_quantity: requiredQuantity,
      unit: inventoryUnit,
      estimated_cost: Number((requiredQuantity * unitCost).toFixed(2))
    };
  });

  if (!productionItems.length) {
    for (const request of existingRequests) {
      if (['cancelled', 'rejected'].includes(String(request.status || '').toLowerCase())) continue;
      await updateDocument('MaterialRequest', request.id, {
        status: 'cancelled',
        procurement_notes: 'Cancelled automatically because the production recipe has no stock-managed ingredients.'
      }, executor);
    }
    const noMaterialReviewAt = new Date().toISOString();
    await updateDocument('Production', production.id, {
      status: isDraftMode ? production.status : 'approved',
      material_request_status: 'not_required',
      linked_material_request_id: null,
      linked_material_request_number: null,
      fulfillment_store_id: fulfillmentStore?.id || null,
      fulfillment_store_name: fulfillmentStore?.name || null,
      ...(!isDraftMode ? {
        area_approval_status: null,
        last_review_action: 'procurement_not_required',
        approval_history: appendProductionApprovalHistory(production, {
          action: 'procurement_not_required',
          stage: 'store_procurement',
          from_status: normalizeProductionStatus(production.status),
          to_status: 'approved',
          actor_id: user?.id || null,
          actor_email: user?.email || null,
          actor_name: user?.full_name || user?.email || null,
          reason: 'No stock-managed ingredients are required.',
          note: 'No stock-managed ingredients are required.',
          timestamp: noMaterialReviewAt
        })
      } : {})
    }, executor);
    return null;
  }

  const targetStatus = isDraftMode ? 'awaiting_production_approval' : 'pending_procurement_ack';
  const existingRequest = existingRequests.find((item) => !['cancelled', 'rejected'].includes(String(item.status || '').toLowerCase()));
  const payload = {
    site_id: inventorySiteId || null,
    site_name: inventorySiteName || null,
    requesting_site_id: production.site_id || null,
    requesting_site_name: production.site_name || productionSite?.name || null,
    fulfillment_store_id: fulfillmentStore?.id || null,
    fulfillment_store_name: fulfillmentStore?.name || null,
    request_date: new Date().toISOString().slice(0, 10),
    period_start: production.production_date || null,
    period_end: production.production_date || null,
    items: productionItems,
    total_estimated_cost: productionItems.reduce((sum, item) => sum + item.estimated_cost, 0),
    status: targetStatus,
    source_type: 'production',
    source_production_id: production.id,
    source_production_name: production.recipe_name || null,
    created_by: user?.email || production.created_by || null,
    created_by_name: user?.full_name || user?.email || production.created_by_name || production.created_by || null,
    notes: `Requested from production batch ${production.recipe_name || production.id}`
  };

  const preserveExistingAcknowledgement = Boolean(
    existingRequest
    && !isDraftMode
    && !forceFreshAcknowledgement
    && String(existingRequest.status || '').toLowerCase() === 'acknowledged'
  );

  const materialRequest = existingRequest
    ? await updateDocument('MaterialRequest', existingRequest.id, {
        ...payload,
        created_by: existingRequest.created_by || payload.created_by,
        created_by_name: existingRequest.created_by_name || payload.created_by_name,
        request_number: existingRequest.request_number || `MR-PROD-${Date.now()}`,
        status: preserveExistingAcknowledgement ? 'acknowledged' : targetStatus,
        ...(!preserveExistingAcknowledgement ? {
          acknowledged_by: null,
          acknowledged_by_name: null,
          acknowledged_at: null
        } : {})
      }, executor)
    : await createDocument('MaterialRequest', {
        request_number: `MR-PROD-${Date.now()}`,
        ...payload
      }, executor);

  await updateDocument('Production', production.id, {
    linked_material_request_id: materialRequest.id,
    linked_material_request_number: materialRequest.request_number,
    material_request_status: materialRequest.status,
    fulfillment_store_id: fulfillmentStore?.id || null,
    fulfillment_store_name: fulfillmentStore?.name || null,
    ...(!isDraftMode && String(materialRequest.status || '').toLowerCase() === 'acknowledged'
      ? { status: 'approved', area_approval_status: null }
      : {})
  }, executor);

  return materialRequest;
}

async function cancelMaterialRequestsForProduction(productionId, reason, executor = null) {
  const requests = await listDocuments('MaterialRequest', {
    filters: { source_production_id: productionId },
    limit: 50
  }, executor || undefined);
  for (const request of requests) {
    if (['cancelled', 'rejected'].includes(String(request.status || '').toLowerCase())) continue;
    await updateDocument('MaterialRequest', request.id, {
      status: 'rejected',
      procurement_notes: reason || request.procurement_notes || 'Production request rejected'
    }, executor);
  }
}

const CORE_MENU_MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner']);

function isOperationalMenuPlan(plan) {
  return !String(plan?.event_name || '').trim();
}

function summarizeMenuPlanMeals(meals = []) {
  return meals.reduce((summary, meal) => {
    const servings = numericMatch(meal.expected_servings, 0);
    const calories = numericMatch(meal.calories_per_serving, 0);
    const totalCost = numericMatch(meal.total_cost, 0);
    return {
      total_expected_servings: summary.total_expected_servings + servings,
      total_calories: summary.total_calories + (servings * calories),
      total_planned_cost: summary.total_planned_cost + totalCost
    };
  }, {
    total_expected_servings: 0,
    total_calories: 0,
    total_planned_cost: 0
  });
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function budgetMatchesDate(budget, planDate) {
  const targetDate = normalizeDateOnly(planDate);
  const startDate = normalizeDateOnly(budget?.start_date);
  const endDate = normalizeDateOnly(budget?.end_date);
  if (!targetDate || !startDate || !endDate) {
    return false;
  }
  return targetDate >= startDate && targetDate <= endDate;
}

function scoreBudgetMatch(budget, plan = {}) {
  let score = 0;
  if (budget?.site_id === plan.site_id) score += 30;
  if (String(budget?.meal_type || 'all') === 'all') score += 5;
  if (budget?.meal_type && budget.meal_type !== 'all') score += 10;
  if (budget?.event_name && budget.event_name === plan.event_name) score += 12;
  if (budget?.category && budget.category === plan.category) score += 8;
  const startDate = normalizeDateOnly(budget?.start_date);
  const endDate = normalizeDateOnly(budget?.end_date);
  if (startDate && endDate) {
    const duration = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);
    score += Math.max(0, 15 - duration);
  }
  return score;
}

async function getMenuPlanBudgetContext(user, planLike = {}) {
  const planDate = normalizeDateOnly(planLike.plan_date);
  if (!planLike?.site_id || !planDate) {
    return {
      linked_budget: null,
      budget_candidates: [],
      budget_comparison: {
        planned_cost: numericMatch(planLike.total_planned_cost, 0),
        budget_amount: 0,
        remaining_budget: 0,
        exceeded_amount: 0,
        is_over_budget: false
      }
    };
  }

  const budgetRecords = await listDocuments('Budget', {
    filters: { site_id: planLike.site_id },
    sort: 'start_date',
    limit: 500
  });
  const scopedBudgets = await scopeEntityRecords(user, 'Budget', budgetRecords);
  const candidates = scopedBudgets
    .filter((budget) => String(budget?.status || 'active') !== 'inactive')
    .filter((budget) => budgetMatchesDate(budget, planDate))
    .sort((left, right) => scoreBudgetMatch(right, planLike) - scoreBudgetMatch(left, planLike));

  const linkedBudget = planLike.budget_id
    ? candidates.find((budget) => budget.id === planLike.budget_id) || null
    : (candidates[0] || null);

  const plannedCost = numericMatch(planLike.total_planned_cost, 0);
  const budgetAmount = numericMatch(linkedBudget?.budget_amount ?? planLike.budget_amount, 0);

  return {
    linked_budget: linkedBudget ? {
      id: linkedBudget.id,
      name: linkedBudget.name,
      budget_amount: budgetAmount,
      currency: linkedBudget.currency || 'SAR',
      start_date: linkedBudget.start_date,
      end_date: linkedBudget.end_date,
      meal_type: linkedBudget.meal_type || 'all',
      scope_type: linkedBudget.scope_type || 'site_period'
    } : null,
    budget_candidates: candidates.map((budget) => ({
      id: budget.id,
      name: budget.name,
      budget_amount: numericMatch(budget.budget_amount, 0),
      currency: budget.currency || 'SAR',
      start_date: budget.start_date,
      end_date: budget.end_date,
      meal_type: budget.meal_type || 'all',
      scope_type: budget.scope_type || 'site_period'
    })),
    budget_comparison: {
      planned_cost: plannedCost,
      budget_amount: budgetAmount,
      remaining_budget: Math.max(0, budgetAmount - plannedCost),
      exceeded_amount: Math.max(0, plannedCost - budgetAmount),
      is_over_budget: budgetAmount > 0 && plannedCost > budgetAmount
    }
  };
}

async function findScopedOperationalMenuPlan(user, siteId, planDate, options = {}) {
  const cuisineType = normalizeMenuCuisine(options.cuisine_type || options.cuisineType, 'general');
  const menuCategory = normalizeMenuCategory(options.menu_category || options.menuCategory, 'senior');
  const records = await listDocuments('MenuPlan', {
    filters: { site_id: siteId, plan_date: planDate },
    limit: 50
  });
  const scopedRecords = await scopeEntityRecords(
    user,
    'MenuPlan',
    records
      .filter(isOperationalMenuPlan)
      .filter((record) => normalizeMenuCuisine(record.cuisine_type, 'general') === cuisineType)
      .filter((record) => normalizeMenuCategory(record.menu_category, 'senior') === menuCategory)
  );
  return (await decorateEntityRecords('MenuPlan', scopedRecords.slice(0, 1), user))[0] || null;
}

async function listScopedOperationalMenuPlansForWeek(user, siteId, weekStart, options = {}) {
  const range = buildMenuPlanWeekRange(weekStart);
  if (!range) {
    return null;
  }

  const records = await listDocuments('MenuPlan', {
    filters: { site_id: siteId },
    sort: 'plan_date'
  });
  const weeklyRecords = filterMenuPlansForWeek(records, siteId, weekStart, options);

  return {
    ...range,
    plans: await decorateEntityRecords('MenuPlan', await scopeEntityRecords(user, 'MenuPlan', weeklyRecords), user)
  };
}

async function findScopedSpecialEventById(user, eventId) {
  const existing = await findDocument('MenuPlan', eventId);
  if (!existing || !isSpecialEventPlan(existing)) {
    return null;
  }
  return (await scopeEntityRecords(user, 'MenuPlan', [existing]))[0] || null;
}

async function listScopedSpecialEvents(user, limit = 300) {
  const records = await listDocuments('MenuPlan', {
    sort: '-plan_date',
    limit
  });
  const scopedRecords = await scopeEntityRecords(user, 'MenuPlan', records.filter(isSpecialEventPlan));
  return scopedRecords;
}

async function getSpecialEventBudgetContext(user, planLike = {}) {
  return getMenuPlanBudgetContext(user, {
    ...planLike,
    site_id: planLike.site_id || null,
    plan_date: planLike.event_date || planLike.plan_date || null,
    total_planned_cost: numericMatch(planLike.estimated_cost ?? planLike.total_planned_cost, 0),
    budget_id: planLike.budget_id || null,
    event_name: planLike.event_name || null
  });
}

const BUDGET_PLANNING_MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'dinner', 'snacks', 'other']);

function normalizeBudgetPlanningMonth(value) {
  const requested = String(value || '').trim();
  if (/^\d{4}-\d{2}$/.test(requested)) return requested;
  if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested.slice(0, 7);
  return new Date().toISOString().slice(0, 7);
}

function budgetPlanningMonthBounds(monthToken) {
  const [year, month] = monthToken.split('-').map((part) => Number(part));
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${monthToken}-01`,
    endDate: `${monthToken}-${String(lastDay).padStart(2, '0')}`,
    daysInMonth: lastDay
  };
}

function normalizeBudgetPlanningDate(value, fallback, bounds) {
  const candidate = normalizeDateOnly(value) || normalizeDateOnly(fallback) || bounds.startDate;
  if (candidate < bounds.startDate) return bounds.startDate;
  if (candidate > bounds.endDate) return bounds.endDate;
  return candidate;
}

function budgetPlanningDateFromRecord(record = {}, fields = []) {
  for (const field of fields) {
    const normalized = normalizeDateOnly(String(record?.[field] || '').slice(0, 10));
    if (normalized) return normalized;
  }
  return '';
}

function budgetPlanningSiteChildren(sites = []) {
  const children = new Map();
  sites.forEach((site) => {
    const parentId = site.parent_site_id ? String(site.parent_site_id) : null;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(site);
  });
  return children;
}

function budgetPlanningDescendantSiteIds(rootId, children) {
  const result = new Set();
  const queue = rootId ? [String(rootId)] : [];
  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId || result.has(currentId)) continue;
    result.add(currentId);
    (children.get(currentId) || []).forEach((child) => queue.push(String(child.id)));
  }
  return result;
}

function budgetPlanningOperationalProjectId(siteId, sitesById) {
  let current = sitesById.get(String(siteId || '')) || null;
  const visited = new Set();
  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id));
    if (normalizeSiteType(current.type) === SITE_HIERARCHY_TYPES.PROJECT) {
      return String(current.id);
    }
    current = current.parent_site_id ? sitesById.get(String(current.parent_site_id)) || null : null;
  }
  return sitesById.has(String(siteId || '')) ? String(siteId) : '';
}

function budgetPlanningProductionCost(production = {}) {
  const explicitFields = [
    production.production_cost_total,
    production.ingredient_cost_total,
    production.actual_cost,
    production.total_cost,
    production.estimated_batch_cost,
    production.estimated_cost
  ];
  const explicit = explicitFields.find((value) => Number.isFinite(Number(value)));
  if (typeof explicit !== 'undefined') return Math.max(0, numericMatch(explicit, 0));

  return (Array.isArray(production.ingredients_used) ? production.ingredients_used : [])
    .reduce((sum, line) => {
      const lineCost = [
        line?.actual_cost,
        line?.line_cost,
        line?.estimated_cost
      ].find((value) => Number.isFinite(Number(value)));
      if (typeof lineCost !== 'undefined') return sum + Math.max(0, numericMatch(lineCost, 0));
      const quantity = numericMatch(
        line?.actual_quantity
          ?? line?.planned_quantity
          ?? line?.yield_adjusted_quantity
          ?? line?.adjusted_quantity
          ?? line?.required_quantity
          ?? line?.quantity,
        0
      );
      const unitCost = numericMatch(line?.actual_unit_cost ?? line?.unit_cost ?? line?.cost_per_unit, 0);
      return sum + Math.max(0, quantity * unitCost);
    }, 0);
}

function budgetPlanningWasteCost(record = {}) {
  return Math.max(0, numericMatch(record.estimated_cost ?? record.waste_cost ?? record.total_cost, 0));
}

function budgetPlanningWasteWeightGrams(record = {}) {
  const explicit = [
    record.waste_weight_grams,
    record.quantity_grams,
    record.weight_grams,
    record.recorded_waste_grams,
    record.total_waste_grams
  ].find((value) => Number.isFinite(Number(value)));
  if (typeof explicit !== 'undefined') return Math.max(0, numericMatch(explicit, 0));
  try {
    return Math.max(0, normalizeFoodWasteWeightGrams(record.quantity, record.unit));
  } catch {
    const quantity = numericMatch(record.quantity, 0);
    const unit = String(record.unit || '').trim().toLowerCase();
    if (unit === 'kg') return quantity * 1000;
    return quantity;
  }
}

function emptyBudgetPlanningMealStats() {
  return Object.fromEntries(BUDGET_PLANNING_MEAL_TYPES.map((mealType) => [mealType, {
    monthly_food_cost: 0,
    daily_food_cost: 0,
    monthly_wastage_cost: 0,
    daily_wastage_cost: 0,
    monthly_wastage_grams: 0,
    daily_wastage_grams: 0
  }]));
}

function createBudgetPlanningSiteSummary(site = {}) {
  return {
    site_id: site.id || '',
    site_name: site.name || 'Unknown site',
    area_id: site.parent_site_id || null,
    monthly_food_cost: 0,
    daily_food_cost: 0,
    monthly_wastage_cost: 0,
    daily_wastage_cost: 0,
    monthly_wastage_grams: 0,
    daily_wastage_grams: 0,
    meal_stats: emptyBudgetPlanningMealStats()
  };
}

function addBudgetPlanningProduction(summary, production, date, dailyDate) {
  const amount = budgetPlanningProductionCost(production);
  const mealType = BUDGET_PLANNING_MEAL_TYPES.includes(normalizeMealType(production.meal_type))
    ? normalizeMealType(production.meal_type)
    : 'other';
  summary.monthly_food_cost += amount;
  summary.meal_stats[mealType].monthly_food_cost += amount;
  if (date === dailyDate) {
    summary.daily_food_cost += amount;
    summary.meal_stats[mealType].daily_food_cost += amount;
  }
}

function addBudgetPlanningWaste(summary, waste, date, dailyDate) {
  const cost = budgetPlanningWasteCost(waste);
  const grams = budgetPlanningWasteWeightGrams(waste);
  const mealType = BUDGET_PLANNING_MEAL_TYPES.includes(normalizeMealType(waste.meal_type))
    ? normalizeMealType(waste.meal_type)
    : 'other';
  summary.monthly_wastage_cost += cost;
  summary.monthly_wastage_grams += grams;
  summary.meal_stats[mealType].monthly_wastage_cost += cost;
  summary.meal_stats[mealType].monthly_wastage_grams += grams;
  if (date === dailyDate) {
    summary.daily_wastage_cost += cost;
    summary.daily_wastage_grams += grams;
    summary.meal_stats[mealType].daily_wastage_cost += cost;
    summary.meal_stats[mealType].daily_wastage_grams += grams;
  }
}

function roundBudgetPlanningStats(summary) {
  const roundedMeals = Object.fromEntries(Object.entries(summary.meal_stats || {}).map(([mealType, stats]) => [mealType, {
    monthly_food_cost: Number(numericMatch(stats.monthly_food_cost, 0).toFixed(2)),
    daily_food_cost: Number(numericMatch(stats.daily_food_cost, 0).toFixed(2)),
    monthly_wastage_cost: Number(numericMatch(stats.monthly_wastage_cost, 0).toFixed(2)),
    daily_wastage_cost: Number(numericMatch(stats.daily_wastage_cost, 0).toFixed(2)),
    monthly_wastage_grams: Number(numericMatch(stats.monthly_wastage_grams, 0).toFixed(2)),
    daily_wastage_grams: Number(numericMatch(stats.daily_wastage_grams, 0).toFixed(2))
  }]));
  return {
    ...summary,
    monthly_food_cost: Number(numericMatch(summary.monthly_food_cost, 0).toFixed(2)),
    daily_food_cost: Number(numericMatch(summary.daily_food_cost, 0).toFixed(2)),
    monthly_wastage_cost: Number(numericMatch(summary.monthly_wastage_cost, 0).toFixed(2)),
    daily_wastage_cost: Number(numericMatch(summary.daily_wastage_cost, 0).toFixed(2)),
    monthly_wastage_grams: Number(numericMatch(summary.monthly_wastage_grams, 0).toFixed(2)),
    daily_wastage_grams: Number(numericMatch(summary.daily_wastage_grams, 0).toFixed(2)),
    meal_stats: roundedMeals
  };
}

async function buildBudgetPlanningContext(user, filters = {}) {
  const month = normalizeBudgetPlanningMonth(filters.month);
  const bounds = budgetPlanningMonthBounds(month);
  const dailyDate = normalizeBudgetPlanningDate(filters.date, new Date().toISOString().slice(0, 10), bounds);
  const scope = await getLocationScope(user);
  const accessibleSites = filterRecordsByLocation(user, 'Site', scope.sites, scope)
    .filter((site) => site.is_active !== false);
  const sitesById = new Map(scope.sites.map((site) => [String(site.id), site]));

  const [budgetRecords, productionRecords, foodWasteRecords] = await Promise.all([
    listDocuments('Budget', { sort: '-start_date', limit: 10000 }),
    listDocuments('Production', { sort: '-production_date', limit: 10000 }),
    listDocuments('FoodWaste', { sort: '-waste_date', limit: 10000 })
  ]);

  const [budgets, productions, foodWaste] = await Promise.all([
    scopeEntityRecords(user, 'Budget', budgetRecords, scope),
    scopeEntityRecords(user, 'Production', productionRecords, scope),
    scopeEntityRecords(user, 'FoodWaste', foodWasteRecords, scope)
  ]);

  const projectSites = accessibleSites.filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT);
  const siteSummaries = new Map(projectSites.map((site) => [String(site.id), createBudgetPlanningSiteSummary(site)]));

  productions.forEach((production) => {
    const productionDate = budgetPlanningDateFromRecord(production, ['production_date', 'completed_date', 'created_at']);
    if (!productionDate || productionDate < bounds.startDate || productionDate > bounds.endDate) return;
    const projectId = budgetPlanningOperationalProjectId(production.site_id || production.fulfillment_store_id, sitesById);
    if (!projectId) return;
    if (!siteSummaries.has(projectId)) {
      siteSummaries.set(projectId, createBudgetPlanningSiteSummary(sitesById.get(projectId) || {
        id: projectId,
        name: production.site_name || production.fulfillment_store_name || 'Unknown site'
      }));
    }
    addBudgetPlanningProduction(siteSummaries.get(projectId), production, productionDate, dailyDate);
  });

  foodWaste.forEach((waste) => {
    const wasteDate = budgetPlanningDateFromRecord(waste, ['waste_date', 'date', 'created_at']);
    if (!wasteDate || wasteDate < bounds.startDate || wasteDate > bounds.endDate) return;
    const projectId = budgetPlanningOperationalProjectId(waste.site_id || waste.location_id, sitesById);
    if (!projectId) return;
    if (!siteSummaries.has(projectId)) {
      siteSummaries.set(projectId, createBudgetPlanningSiteSummary(sitesById.get(projectId) || {
        id: projectId,
        name: waste.site_name || waste.location_name || 'Unknown site'
      }));
    }
    addBudgetPlanningWaste(siteSummaries.get(projectId), waste, wasteDate, dailyDate);
  });

  return {
    month,
    start_date: bounds.startDate,
    end_date: bounds.endDate,
    days_in_month: bounds.daysInMonth,
    daily_date: dailyDate,
    sites: accessibleSites,
    budgets,
    site_summaries: [...siteSummaries.values()]
      .map(roundBudgetPlanningStats)
      .sort((left, right) => String(left.site_name || '').localeCompare(String(right.site_name || '')))
  };
}

async function calculateSpecialEventPlanning(user, record) {
  const scope = await getLocationScope(user);
  const validatedFulfillmentStore = record.fulfillment_store_id
    ? resolveProductionFulfillmentStore(record, scope.sites)
    : null;
  const inventorySiteId = validatedFulfillmentStore?.id || record.site_id;
  if (
    inventorySiteId
    && !scope.unrestricted
    && !scope.accessibleSiteIds.has(String(inventorySiteId))
  ) {
    const error = new Error('The event fulfillment Store is outside your assigned location scope.');
    error.status = 403;
    throw error;
  }
  const [recipes, ingredients, inventoryRows] = await Promise.all([
    listDocuments('Recipe', { limit: 5000 }),
    listDocuments('Ingredient', { limit: 5000 }),
    listDocuments('Inventory', { filters: { site_id: inventorySiteId }, limit: 5000 })
  ]);
  const scopedRecipes = filterRecordsByLocation(user, 'Recipe', recipes, scope)
    .filter((recipe) => recipe.is_active !== false)
    .filter((recipe) => recipe.site_scope !== 'specific'
      || !record.site_id
      || (Array.isArray(recipe.site_ids) && recipe.site_ids.includes(record.site_id)));
  const costSnapshots = await getIngredientCostSnapshots({
    ingredientIds: ingredients.map((ingredient) => ingredient.id),
    siteIds: inventorySiteId ? [inventorySiteId] : null
  });
  const costingIngredients = ingredients.map((ingredient) => ({
    ...ingredient,
    last_cost: costSnapshots[ingredient.id]?.last_cost ?? ingredient.last_cost ?? ingredient.cost_per_unit,
    average_cost: costSnapshots[ingredient.id]?.average_cost ?? ingredient.average_cost ?? ingredient.cost_per_unit,
    standard_cost: ingredient.standard_cost ?? ingredient.cost_per_unit
  }));
  const scopedInventory = await scopeEntityRecords(user, 'Inventory', inventoryRows);
  return calculateEventPlanningSnapshot(record, scopedRecipes, costingIngredients, scopedInventory);
}

function mergeSpecialEventSnapshot(record, snapshot) {
  const automaticCost = snapshot.total_event_cost;
  return {
    ...record,
    linked_recipes: snapshot.linked_recipes,
    ingredient_requirements: snapshot.ingredient_requirements,
    estimated_cost: automaticCost ?? 0,
    total_planned_cost: automaticCost ?? 0,
    cost_per_guest: snapshot.cost_per_guest,
    average_item_cost: snapshot.average_item_cost,
    budget_remaining: snapshot.budget_remaining,
    food_cost_percent: snapshot.food_cost_percent,
    margin_per_guest: snapshot.margin_per_guest,
    estimated_procurement_spend: snapshot.estimated_procurement_spend,
    shortage_items: snapshot.shortage_items,
    missing_recipe_ids: snapshot.missing_recipe_ids,
    approval_checklist: snapshot.checklist,
    ready_to_submit: snapshot.ready_to_submit
  };
}

function canEditSpecialEvent(record) {
  return ['draft', 'rejected'].includes(String(record?.status || '').toLowerCase());
}

async function buildSpecialEventResponse(user, record) {
  const initialBudgetContext = await getSpecialEventBudgetContext(user, record);
  const pricedRecord = {
    ...record,
    event_budget: numericMatch(initialBudgetContext.linked_budget?.budget_amount ?? record.event_budget, 0)
  };
  const snapshot = await calculateSpecialEventPlanning(user, pricedRecord);
  const hydratedRecord = mergeSpecialEventSnapshot(pricedRecord, snapshot);
  const budgetContext = await getSpecialEventBudgetContext(user, hydratedRecord);
  const productionScope = await getLocationScope(user);
  const [purchaseRequestCandidate, productionPlans] = await Promise.all([
    hydratedRecord.procurement_pr_id ? getPurchaseRequestById(hydratedRecord.procurement_pr_id) : null,
    listDocuments('Production', {
      filters: { source_event_id: hydratedRecord.id },
      limit: 500,
      location: productionScope
    })
  ]);
  const expectedProcurementSiteId = String(
    hydratedRecord.fulfillment_store_id || hydratedRecord.site_id || ''
  );
  const purchaseRequest = purchaseRequestCandidate
    && String(purchaseRequestCandidate.source_type || '').toLowerCase() === 'special_event'
    && String(purchaseRequestCandidate.source_event_id || '') === String(hydratedRecord.id)
    && String(purchaseRequestCandidate.site_id || '') === expectedProcurementSiteId
    && filterRowsByAccessibleSites([purchaseRequestCandidate], productionScope).length
    ? purchaseRequestCandidate
    : null;
  const productionByRecipe = new Map(productionPlans.map((plan) => [String(plan.source_event_recipe_id), plan]));
  const linkedRecipes = hydratedRecord.linked_recipes.map((link) => ({
    ...link,
    production_status: productionByRecipe.get(String(link.recipe_id))?.status || link.production_status
  }));
  const productionStatuses = productionPlans.map((plan) => String(plan.status || 'planned'));
  const productionPlanStatus = productionStatuses.length === 0
    ? 'not_generated'
    : productionStatuses.every((status) => status === 'completed')
      ? 'completed'
      : productionStatuses.some((status) => ['rejected', 'cancelled'].includes(status))
        ? 'action_required'
        : productionStatuses.some((status) => ['in_progress', 'completed'].includes(status))
          ? 'in_progress'
          : 'generated';
  return {
    ...hydratedRecord,
    linked_recipes: linkedRecipes,
    procurement_pr_id: purchaseRequest?.id || null,
    procurement_pr_number: purchaseRequest?.request_number || null,
    procurement_pr_status: purchaseRequest?.status
      || (snapshot.shortage_items.length === 0 ? 'not_required' : 'not_created'),
    procurement_request: purchaseRequest,
    production_plan_ids: productionPlans.map((plan) => plan.id),
    production_plan_status: productionPlanStatus,
    approval_checklist: {
      ...(hydratedRecord.approval_checklist || {}),
      procurement_plan: Boolean(purchaseRequest) || snapshot.shortage_items.length === 0,
      production_plan: productionPlans.length > 0
    },
    linked_budget: budgetContext.linked_budget,
    budget_candidates: budgetContext.budget_candidates,
    budget_comparison: {
      ...budgetContext.budget_comparison,
      planned_cost: numericMatch(snapshot.total_event_cost, 0),
      remaining_budget: Math.max(0, numericMatch(hydratedRecord.event_budget, 0) - numericMatch(snapshot.total_event_cost, 0)),
      exceeded_amount: Math.max(0, numericMatch(snapshot.total_event_cost, 0) - numericMatch(hydratedRecord.event_budget, 0)),
      is_over_budget: numericMatch(hydratedRecord.event_budget, 0) > 0
        && numericMatch(snapshot.total_event_cost, 0) > numericMatch(hydratedRecord.event_budget, 0)
    }
  };
}

function buildMenuPlanWritePayload(body = {}, existing = null) {
  const meals = Array.isArray(body.meals)
    ? body.meals
      .filter((meal) => meal && meal.meal_type)
      .map((meal) => ({
        ...meal,
        expected_servings: numericMatch(meal.expected_servings, 0),
        cost_per_serving: numericMatch(meal.cost_per_serving, 0),
        total_cost: numericMatch(meal.total_cost, 0),
        calories_per_serving: numericMatch(meal.calories_per_serving, 0),
        protein_per_serving: numericMatch(meal.protein_per_serving, 0),
        carbs_per_serving: numericMatch(meal.carbs_per_serving, 0),
        fat_per_serving: numericMatch(meal.fat_per_serving, 0),
        sodium_per_serving: numericMatch(meal.sodium_per_serving, 0),
        sugar_per_serving: numericMatch(meal.sugar_per_serving, 0),
        allergens: Array.isArray(meal.allergens) ? meal.allergens : []
      }))
    : (Array.isArray(existing?.meals) ? existing.meals : []);

  const summary = summarizeMenuPlanMeals(meals);

  return {
    ...body,
    meals,
    cuisine_type: normalizeMenuCuisine(body.cuisine_type ?? existing?.cuisine_type, 'general'),
    menu_category: normalizeMenuCategory(body.menu_category ?? existing?.menu_category, 'senior'),
    status: body.status || existing?.status || 'draft',
    total_expected_servings: summary.total_expected_servings,
    total_calories: summary.total_calories,
    total_planned_cost: summary.total_planned_cost,
    budget_source: body.budget_source ?? existing?.budget_source ?? 'linked',
    budget_id: body.budget_id ?? existing?.budget_id ?? null,
    budget_name: body.budget_name ?? existing?.budget_name ?? null,
    manual_budget_name: body.manual_budget_name ?? existing?.manual_budget_name ?? null,
    budget_amount: numericMatch(body.budget_amount ?? existing?.budget_amount, 0),
    meal_budget_limits: body.meal_budget_limits ?? existing?.meal_budget_limits ?? null,
    remaining_budget: numericMatch(body.remaining_budget ?? existing?.remaining_budget, 0),
    exceeded_budget_by: numericMatch(body.exceeded_budget_by ?? existing?.exceeded_budget_by, 0)
  };
}

async function validateMenuPlanBudgetSelection(user, payload) {
  if (!payload?.budget_id) {
    return null;
  }

  const budgetRecords = await listDocuments('Budget', {
    filters: { id: payload.budget_id },
    limit: 1
  });
  const scopedBudget = (await scopeEntityRecords(user, 'Budget', budgetRecords))[0];

  if (!scopedBudget) {
    const error = new Error('Selected budget is not available for this project.');
    error.statusCode = 400;
    throw error;
  }

  if (payload.site_id && scopedBudget.site_id && scopedBudget.site_id !== payload.site_id) {
    const error = new Error('Selected budget does not belong to the chosen project.');
    error.statusCode = 400;
    throw error;
  }

  if (!budgetMatchesDate(scopedBudget, payload.plan_date)) {
    const error = new Error('Selected budget does not apply to the chosen date.');
    error.statusCode = 400;
    throw error;
  }

  return scopedBudget;
}

async function getScopedProduction(request, productionId) {
  const scope = await getLocationScope(request.user);
  const production = await findDocument('Production', productionId);
  if (!production) {
    return { scope, production: null };
  }

  const scopedProduction = filterRowsByAccessibleSites(
    [production],
    scope,
    ['site_id', 'fulfillment_store_id']
  ).length ? production : null;
  return { scope, production: scopedProduction };
}

async function listBatchOverproductionBatches(user, {
  siteId,
  wasteDate,
  mealType,
  executor = null,
  lock = false,
  existingScope = null
} = {}) {
  if (!siteId || !wasteDate || !mealType) return [];
  const rows = await listDocuments('ProducedItemBatch', {
    filters: {
      site_id: siteId,
      production_date: wasteDate,
      meal_type: mealType
    },
    sort: 'completed_at',
    limit: 10000,
    lock
  }, executor || undefined);
  return scopeEntityRecords(user, 'ProducedItemBatch', rows, existingScope);
}

async function buildFoodWasteContext(user, { siteId, wasteDate, mealType, now = new Date() }) {
  const normalizedMealType = normalizeMealType(mealType);
  const siteIdValue = String(siteId || '').trim();
  const wasteDateValue = normalizeDateOnly(wasteDate);

  const menuPlan = siteIdValue && wasteDateValue
    ? await findScopedOperationalMenuPlan(user, siteIdValue, wasteDateValue)
    : null;

  const menuPlanSummary = buildFoodWasteMenuPlanSummary(menuPlan, normalizedMealType);

  const productionRows = siteIdValue && wasteDateValue
    ? await scopeEntityRecords(
      user,
      'Production',
      await listDocuments('Production', {
        filters: { site_id: siteIdValue, production_date: wasteDateValue },
        limit: 500
      })
    )
    : [];

  const producedItemBatches = siteIdValue && wasteDateValue
    ? await listBatchOverproductionBatches(user, {
      siteId: siteIdValue,
      wasteDate: wasteDateValue,
      mealType: normalizedMealType
    })
    : [];
  const batchOverproductionDishes = buildBatchOverproductionDishSummary(producedItemBatches, productionRows);
  const latestProductionCompletedAt = getLatestSuccessfulProductionCompletedAt({
    productions: productionRows,
    producedItemBatches,
    mealType: normalizedMealType
  });
  const timeWindow = getFoodWasteRecordingWindow({
    wasteDate: wasteDateValue,
    mealType: normalizedMealType,
    now,
    isAdmin: hasAdminAccess(user),
    productionCompletedAt: latestProductionCompletedAt
  });

  const productionOptions = productionRows
    .filter((item) => normalizeMealType(item.meal_type) === normalizedMealType)
    .map((item) => ({
      id: item.id,
      recipe_id: item.recipe_id || null,
      recipe_name: item.recipe_name || 'Unnamed recipe',
      production_date: item.production_date,
      site_id: item.site_id || null,
      site_name: item.site_name || '',
      meal_type: normalizeMealType(item.meal_type),
      target_servings: numericMatch(item.target_servings, 0),
      actual_servings: numericMatch(item.actual_servings || item.target_servings, 0),
      total_cost: numericMatch(item.total_cost, 0),
      estimated_total_cost: numericMatch(item.estimated_total_cost, 0),
      status: item.status || 'planned'
    }));

  return {
    site_id: siteIdValue || null,
    waste_date: wasteDateValue || null,
    meal_type: normalizedMealType || null,
    ...timeWindow,
    menu_plan: menuPlanSummary.id ? {
      id: menuPlanSummary.id,
      name: `${menuPlanSummary.site_name || 'Project'} menu for ${menuPlanSummary.plan_date}`,
      ...menuPlanSummary
    } : null,
    planned_menu_items: menuPlanSummary.recipes,
    production_options: productionOptions,
    batch_overproduction_dishes: batchOverproductionDishes,
    produced_dishes: batchOverproductionDishes
  };
}

async function findAccessibleSite(user, siteId) {
  const site = await findDocument('Site', siteId);
  if (!site) {
    return null;
  }

  return (await scopeEntityRecords(user, 'Site', [site]))[0] || null;
}

function filterFoodWasteRows(rows, filters = {}) {
  const startDate = normalizeDateOnly(filters.start_date);
  const endDate = normalizeDateOnly(filters.end_date);
  const mealType = normalizeMealType(filters.meal_type);
  return rows.filter((row) => {
    if (filters.site_id && row.site_id !== filters.site_id) return false;
    if (filters.waste_category && row.waste_category !== filters.waste_category) return false;
    if (filters.reason_code && row.reason_code !== filters.reason_code) return false;
    if (filters.scope && row.waste_scope !== filters.scope) return false;
    if (mealType && normalizeMealType(row.meal_type) !== mealType) return false;
    if (startDate && String(row.waste_date || '') < startDate) return false;
    if (endDate && String(row.waste_date || '') > endDate) return false;
    return true;
  });
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isPubliclyUsableBaseUrl(value) {
  return value && !/localhost|127\.0\.0\.1/i.test(value);
}

function resolvePublicBaseUrl(request) {
  const configured = normalizeBaseUrl(process.env.PUBLIC_APP_URL);
  if (isPubliclyUsableBaseUrl(configured)) {
    return configured;
  }

  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = String(request.headers.host || '').trim();
  const protocol = forwardedProto || request.protocol || 'http';
  const hostValue = forwardedHost || requestHost;

  if (hostValue) {
    return `${protocol}://${hostValue}`;
  }

  return configured || `http://localhost:${port}`;
}

function parseAvailableIngredients(prompt = '') {
  const section = prompt.split('Available Ingredients')[1] || '';
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .slice(0, 8)
    .map((line, index) => {
      const match = line.match(/-\s*(.+?)\s+\(([\d.]+)\s*(.*?)\)/);
      if (!match) {
        return { ingredient_name: line.replace(/^-/, '').trim(), quantity: index + 1, unit: 'unit' };
      }
      return {
        ingredient_name: match[1].trim(),
        quantity: Math.max(1, Math.round(numericMatch(match[2], index + 1) / 4)),
        unit: match[3] || 'unit'
      };
    });
}

function inferRecipeCategory(prompt = '') {
  const match = prompt.match(/Meal Category:\s*(.+)/i);
  return match?.[1]?.trim() || 'main_course';
}

function inferCuisine(prompt = '') {
  const match = prompt.match(/Cuisine Type:\s*(.+)/i);
  return match?.[1]?.trim() || 'continental';
}

function invokeFallbackLLM(prompt, schema) {
  const properties = schema?.properties || {};

  if (properties.name && properties.ingredients && properties.instructions) {
    const cuisine = inferCuisine(prompt);
    const category = inferRecipeCategory(prompt);
    const ingredients = parseAvailableIngredients(prompt);

    return {
      name: `${cuisine[0].toUpperCase()}${cuisine.slice(1)} ${category.replace(/_/g, ' ')}`.trim(),
      description: `A practical ${cuisine} ${category.replace(/_/g, ' ')} recipe generated from current inventory.`,
      ingredients,
      instructions: [
        'Prepare and portion all ingredients before starting production.',
        'Cook aromatics and core ingredients until fragrant and evenly combined.',
        'Add the remaining ingredients in stages and monitor texture carefully.',
        'Adjust seasoning, simmer until cooked through, and verify internal temperature.',
        'Portion for service and garnish before dispatch.'
      ].join('\n'),
      prep_time_minutes: 20,
      cook_time_minutes: 35,
      calories_per_serving: 420,
      protein_per_serving: 24,
      carbs_per_serving: 38,
      fat_per_serving: 16
    };
  }

  if (properties.substitutions && properties.quantity_adjustments) {
    return {
      substitutions: [
        {
          original_ingredient: 'Premium cream',
          substitute: 'Evaporated milk',
          cost_savings: 4.5,
          impact_on_quality: 'Slightly lighter texture with similar richness.',
          flavor_profile_notes: 'Keeps the savory profile balanced and clean.'
        },
        {
          original_ingredient: 'Imported herbs',
          substitute: 'Local fresh herbs',
          cost_savings: 2.25,
          impact_on_quality: 'Freshness remains strong with lower procurement cost.',
          flavor_profile_notes: 'Use the same finishing quantity for aroma.'
        }
      ],
      quantity_adjustments: [
        {
          ingredient: 'Oil',
          current_quantity: 1,
          suggested_quantity: 0.8,
          reasoning: 'A modest reduction controls cost without affecting cooking performance.'
        }
      ],
      price_fluctuation_forecast: {
        increase_10_percent: 55,
        increase_20_percent: 60,
        decrease_10_percent: 45,
        decrease_20_percent: 40
      },
      optimization_summary: 'Prioritize locally sourced substitutes, tighten high-cost fat usage, and review garnish standards.'
    };
  }

  if (properties.tomorrow_estimate && properties.suggestions) {
    return {
      tomorrow_estimate: {
        labor_kg: 72,
        junior_kg: 38,
        senior_kg: 24,
        total_kg: 134,
        expected_attendance: 340
      },
      adjustment_percent: -8,
      adjustment_direction: 'reduce',
      suggestions: [
        'Reduce production slightly for low-demand categories and keep a fast replenishment buffer.',
        'Shift surplus side dishes into next-meal reusable preparations where safe.',
        'Track no-show rates by weekday and pre-cut fewer garnishes on low-demand days.'
      ],
      pattern_observation: 'Mid-week demand remains strongest while weekend attendance softens, increasing overproduction risk late in the week.',
      category_insights: [
        'Labor meals show the most stable demand.',
        'Junior demand varies more and benefits from conservative prep.',
        'Senior meals justify a smaller premium buffer because counts are lower.'
      ],
      waste_risk: 'medium'
    };
  }

  if (properties.detected_food_types && properties.waste_percentage) {
    return {
      detected_food_types: ['rice', 'chicken', 'vegetables'],
      waste_percentage: 34,
      estimated_waste_grams: 180,
      waste_category: 'plate_waste',
      confidence_score: 72,
      suggestions: [
        'Reduce rice portioning by 10% during low-demand periods.',
        'Offer smaller default portions with optional top-ups.',
        'Review menu acceptance for the protein item served in this meal.'
      ],
      cost_estimate: 1.8,
      observation: 'The remaining food suggests moderate plate waste from oversized portions.'
    };
  }

  return Object.fromEntries(
    Object.keys(properties).map((key) => [key, null])
  );
}

async function invokeOpenAI(payload, publicBaseUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return invokeFallbackLLM(payload.prompt, payload.response_json_schema);
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: payload.prompt || 'Return a valid JSON object.' },
            ...((payload.file_urls || []).map((url) => ({
              type: 'input_image',
              image_url: url.startsWith('http') ? url : `${publicBaseUrl}${url}`
            })))
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'foodpro_response',
          schema: payload.response_json_schema || { type: 'object', properties: {} }
        }
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`LLM request failed: ${message}`);
  }

  const result = await response.json();
  const textChunk = result.output?.[0]?.content?.find((item) => item.type === 'output_text')?.text;
  return textChunk ? JSON.parse(textChunk) : invokeFallbackLLM(payload.prompt, payload.response_json_schema);
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',').map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((item) => item.trim());
    return Object.fromEntries(headers.map((header, index) => {
      const rawValue = values[index] ?? '';
      const numeric = Number(rawValue);
      return [header, Number.isFinite(numeric) && rawValue !== '' ? numeric : rawValue];
    }));
  });
}

function projectToSchema(rows, schema) {
  if (!schema?.properties?.data?.items?.properties) {
    return rows;
  }

  const targetShape = schema.properties.data.items.properties;
  return rows.map((row) => {
    const projected = {};
    for (const [key, rules] of Object.entries(targetShape)) {
      const sourceKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      const value = sourceKey ? row[sourceKey] : null;
      projected[key] = rules.type === 'number' ? numericMatch(value, 0) : value;
    }
    return projected;
  });
}

app.post('/api/auth/login', async (request, response) => {
  const { email, password } = request.body || {};
  const session = await loginUser(email || '', password || '');

  if (!session) {
    await auditAction({
      action: 'LOGIN_FAILED',
      entity: 'Auth',
      entityId: email || 'unknown',
      details: { email: email || null, reason: 'invalid_credentials' }
    });
    return response.status(401).json({ message: 'Invalid email or password' });
  }

  await auditAction({
    user: session.user,
    action: 'LOGIN_SUCCESS',
    entity: 'Auth',
    entityId: session.user.id,
    details: { email: session.user.email, role: session.user.role }
  });

  return response.json(session);
});

app.get('/api/auth/me', requireAuth, async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json({
      ...request.user,
      accessible_site_ids: [...scope.accessibleSiteIds]
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/budgets/planning-context', requireAuth, requireAnyPermission(['view_budget', 'manage_budget']), async (request, response, next) => {
  try {
    response.set('Cache-Control', 'private, no-store');
    response.json(await buildBudgetPlanningContext(request.user, {
      month: request.query.month,
      date: request.query.date
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/dashboard/management', requireAuth, requirePermission('view_dashboard'), async (request, response, next) => {
  try {
    response.set('Cache-Control', 'private, no-store');
    response.json(await getManagementDashboardSnapshot(request.user, {
      view: request.query.view,
      date: request.query.date,
      start_date: request.query.start_date,
      end_date: request.query.end_date,
      site_id: request.query.site_id
    }));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/auth/me', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'User', 'update', request.body || {}, request.user);
    const updated = await updateDocument('User', request.user.id, request.body || {});
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (request, response) => {
  await auditAction({
    user: request.user,
    action: 'LOGOUT',
    entity: 'Auth',
    entityId: request.user.id,
    details: { email: request.user.email, role: request.user.role }
  });
  await revokeToken(request.token);
  response.status(204).send();
});

app.post('/api/users/invite', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'User', 'create');
    const invited = await inviteUser(request.body?.email, request.body?.role);
    response.json(invited);
  } catch (error) {
    next(error);
  }
});

app.post('/api/users/:id/deactivate', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const result = await deactivateUserAccount({
      actor: request.user,
      targetId: request.params.id,
      confirmation: request.body?.confirmation,
      reason: request.body?.reason
    });
    recordChanged('User');
    return response.json({
      success: true,
      message: 'User account deactivated. Existing sessions have been revoked.',
      ...result
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/user-groups/bulk-members', requireAuth, requireBulkUploadAdministrator, async (request, response, next) => {
  try {
    const groupId = String(request.body?.group_id || '').trim();
    const name = String(request.body?.name || '').trim();
    const description = String(request.body?.description || '').trim();
    const submittedMembers = request.body?.members;

    if (!name) {
      return response.status(400).json({ message: 'Group name is required before importing members.' });
    }
    if (!Array.isArray(submittedMembers) || submittedMembers.length === 0) {
      return response.status(400).json({ message: 'Select at least one valid member to import.' });
    }
    if (submittedMembers.length > 5000) {
      return response.status(413).json({ message: 'A single user-group upload cannot exceed 5,000 members.' });
    }

    const invalidMemberIndex = submittedMembers.findIndex((member) => !String(member?.name || '').trim());
    if (invalidMemberIndex >= 0) {
      return response.status(400).json({ message: `Member ${invalidMemberIndex + 1} requires a name.` });
    }

    const members = submittedMembers.map((member, index) => ({
      user_id: String(member.user_id || `usr_bulk_${Date.now()}_${index}`).trim(),
      name: String(member.name || '').trim(),
      email: String(member.email || '').trim(),
      phone: String(member.phone || '').trim(),
      category: ['labor', 'junior', 'senior'].includes(String(member.category || '').trim().toLowerCase())
        ? String(member.category).trim().toLowerCase()
        : 'labor'
    }));
    if (new Set(members.map((member) => member.user_id)).size !== members.length) {
      return response.status(400).json({ message: 'Every imported group member must have a unique user ID.' });
    }

    const counts = members.reduce((summary, member) => {
      summary[member.category] = (summary[member.category] || 0) + 1;
      return summary;
    }, {});
    const payload = {
      name,
      description,
      members,
      total_members: members.length,
      labor_count: counts.labor || 0,
      junior_count: counts.junior || 0,
      senior_count: counts.senior || 0
    };

    const existing = groupId ? await findDocument('UserGroup', groupId) : null;
    if (groupId && !existing) {
      return response.status(404).json({ message: 'User group not found.' });
    }
    const action = existing ? 'update' : 'create';
    authorizeEntityAction(request.user, 'UserGroup', action, payload, existing);
    const preparedPayload = await prepareEntityPayload(request.user, 'UserGroup', payload, existing);
    const saved = existing
      ? await updateDocument('UserGroup', existing.id, preparedPayload)
      : await createDocument('UserGroup', preparedPayload);

    invalidateEntityAccessCaches('UserGroup');
    recordChanged('UserGroup');
    await auditAction({
      user: request.user,
      action: 'USERGROUP_BULK_MEMBERS_IMPORT',
      entity: 'UserGroup',
      entityId: saved.id,
      details: {
        group_name: saved.name,
        imported_members: Math.min(
          Math.max(Number(request.body?.imported_member_count) || submittedMembers.length, 0),
          submittedMembers.length
        ),
        total_members: saved.total_members,
        operation: action
      }
    });

    const decorated = (await decorateEntityRecords('UserGroup', [saved]))[0];
    return response.status(existing ? 200 : 201).json(decorated);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/menu-plans/by-date', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const planDate = String(request.query.plan_date || '').trim();
    const cuisineType = normalizeMenuCuisine(request.query.cuisine_type, 'general');
    const menuCategory = normalizeMenuCategory(request.query.menu_category, 'senior');

    const errors = validateSiteAndDateInput({ siteId, planDate });
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const plan = await findScopedOperationalMenuPlan(request.user, siteId, planDate, {
      cuisine_type: cuisineType,
      menu_category: menuCategory
    });
    const budgetContext = await getMenuPlanBudgetContext(request.user, {
      ...(plan || {}),
      site_id: siteId,
      plan_date: planDate,
      total_planned_cost: numericMatch(plan?.total_planned_cost, 0),
      budget_id: plan?.budget_id || null
    });
    return response.json(buildApiObjectResponse({
      plan: plan || null,
      ...budgetContext
    }, { site_id: siteId, plan_date: planDate, cuisine_type: cuisineType, menu_category: menuCategory }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/menu-plans/week', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const weekStart = String(request.query.week_start || '').trim();
    const cuisineType = normalizeMenuCuisine(request.query.cuisine_type, 'general');
    const menuCategory = normalizeMenuCategory(request.query.menu_category, 'senior');
    const errors = validateSiteAndDateInput({ siteId, planDate: weekStart });
    if (errors.length) {
      const normalizedErrors = errors.map((error) => error.replace('plan_date', 'week_start'));
      return response.status(400).json({ message: normalizedErrors[0], errors: normalizedErrors });
    }

    const result = await listScopedOperationalMenuPlansForWeek(request.user, siteId, weekStart, {
      cuisine_type: cuisineType,
      menu_category: menuCategory
    });
    return response.json(buildApiObjectResponse(result, {
      site_id: siteId,
      week_start: weekStart,
      cuisine_type: cuisineType,
      menu_category: menuCategory
    }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/menu-plans/budgets', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const planDate = String(request.query.plan_date || '').trim();

    const errors = validateSiteAndDateInput({ siteId, planDate });
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const budgetContext = await getMenuPlanBudgetContext(request.user, {
      site_id: siteId,
      plan_date: planDate,
      budget_id: String(request.query.budget_id || '').trim() || null,
      total_planned_cost: numericMatch(request.query.total_planned_cost, 0)
    });

    return response.json(buildApiObjectResponse(budgetContext, { site_id: siteId, plan_date: planDate }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/menu-plans/cost-preview', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const payload = buildMenuPlanWritePayload(request.body || {});
    const errors = validateMenuPlanPayload(payload);
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const [recipes, ingredients] = await Promise.all([
      listDocuments('Recipe', { limit: 4000 }),
      listDocuments('Ingredient', { limit: 4000 })
    ]);

    const costSummary = summarizeMenuPlanCostPreview(payload.meals, recipes, ingredients);
    const budgetContext = await getMenuPlanBudgetContext(request.user, {
      site_id: payload.site_id,
      plan_date: payload.plan_date,
      budget_id: payload.budget_id || null,
      total_planned_cost: numericMatch(costSummary.total_cost, 0)
    });

    return response.json(buildApiObjectResponse({
      meals: payload.meals,
      cost_summary: costSummary,
      budget_context: budgetContext
    }, {
      site_id: payload.site_id,
      plan_date: payload.plan_date
    }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/menu-plans/pr-generation', requireAuth, requireAnyPermission(['manage_menu_planning', 'generate_menu_plan_pr']), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const referenceDate = String(request.query.reference_date || '').trim();

    const errors = validatePRGenerationPayload({ site_id: siteId, site_name: 'placeholder', reference_date: referenceDate })
      .filter((error) => error !== 'site_name is required');
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const context = await getMenuPlanPRContext(request.user, siteId, referenceDate);
    return response.json(buildApiObjectResponse(context, { site_id: siteId, reference_date: referenceDate || null }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/menu-plans/pr-generation/config', requireAuth, requirePermission('generate_menu_plan_pr'), async (request, response, next) => {
  try {
    const payload = request.body || {};
    const errors = validatePRGenerationPayload(payload);
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const config = await saveMenuPlanPRScheduleConfig(request.user, payload);
    return response.json(buildApiObjectResponse(config, { site_id: payload.site_id }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/menu-plans/pr-generation/run', requireAuth, requirePermission('generate_menu_plan_pr'), async (request, response, next) => {
  try {
    const payload = request.body || {};
    const errors = validatePRGenerationPayload(payload);
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const result = await generatePurchaseRequestFromMenuPlans(request.user, {
      ...payload,
      trigger_type: payload.trigger_type || 'manual'
    });

    return response.status(result.duplicate_prevented ? 200 : 201).json(
      buildApiObjectResponse(result, { site_id: payload.site_id, trigger_type: payload.trigger_type || 'manual' })
    );
  } catch (error) {
    return next(error);
  }
});

app.post('/api/menu-plans', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const payload = buildMenuPlanWritePayload(request.body || {});
    const errors = validateMenuPlanPayload(payload);
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const existing = await findScopedOperationalMenuPlan(request.user, payload.site_id, payload.plan_date, {
      cuisine_type: payload.cuisine_type,
      menu_category: payload.menu_category
    });
    if (existing) {
      return response.status(409).json({ message: 'A menu plan already exists for this project and date' });
    }

    const selectedBudget = await validateMenuPlanBudgetSelection(request.user, payload);
    if (selectedBudget) {
      payload.budget_name = selectedBudget.name;
      payload.budget_amount = numericMatch(selectedBudget.budget_amount, 0);
      payload.remaining_budget = Math.max(0, payload.budget_amount - numericMatch(payload.total_planned_cost, 0));
      payload.exceeded_budget_by = Math.max(0, numericMatch(payload.total_planned_cost, 0) - payload.budget_amount);
    }

    authorizeEntityAction(request.user, 'MenuPlan', 'create', payload);
    const preparedPayload = await prepareEntityPayload(request.user, 'MenuPlan', payload);
    const created = await createDocument('MenuPlan', preparedPayload);
    return response.status(201).json(buildApiObjectResponse(created, { action: 'create' }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/menu-plans/:id', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const existing = await findDocument('MenuPlan', request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Menu plan not found' });
    }

    if (!isOperationalMenuPlan(existing)) {
      return response.status(400).json({ message: 'Event plans must be edited from the event planning module' });
    }

    const scopedExisting = (await scopeEntityRecords(request.user, 'MenuPlan', [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this menu plan' });
    }

    const payload = buildMenuPlanWritePayload(request.body || {}, existing);
    const errors = validateMenuPlanPayload(payload);
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }
    const selectedBudget = await validateMenuPlanBudgetSelection(request.user, payload);
    if (selectedBudget) {
      payload.budget_name = selectedBudget.name;
      payload.budget_amount = numericMatch(selectedBudget.budget_amount, 0);
      payload.remaining_budget = Math.max(0, payload.budget_amount - numericMatch(payload.total_planned_cost, 0));
      payload.exceeded_budget_by = Math.max(0, numericMatch(payload.total_planned_cost, 0) - payload.budget_amount);
    } else if (!payload.budget_id) {
      payload.budget_name = null;
      payload.budget_amount = 0;
      payload.remaining_budget = 0;
      payload.exceeded_budget_by = 0;
    }
    authorizeEntityAction(request.user, 'MenuPlan', 'update', payload, existing);
    const preparedPayload = await prepareEntityPayload(request.user, 'MenuPlan', payload, existing);
    const updated = await updateDocument('MenuPlan', request.params.id, preparedPayload);
    return response.json(buildApiObjectResponse(updated, { action: 'update' }));
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/menu-plans/:id', requireAuth, requirePermission('manage_menu_planning'), async (request, response, next) => {
  try {
    const existing = await findDocument('MenuPlan', request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Menu plan not found' });
    }

    if (!isOperationalMenuPlan(existing)) {
      return response.status(400).json({ message: 'Event plans must be deleted from the event planning module' });
    }

    const scopedExisting = (await scopeEntityRecords(request.user, 'MenuPlan', [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this menu plan' });
    }

    authorizeEntityAction(request.user, 'MenuPlan', 'delete', null, existing);

    const remainingMeals = (Array.isArray(existing.meals) ? existing.meals : [])
      .filter((meal) => !CORE_MENU_MEAL_TYPES.has(String(meal.meal_type || '').toLowerCase()));

    if (remainingMeals.length > 0) {
      const summary = summarizeMenuPlanMeals(remainingMeals);
      const updated = await updateDocument('MenuPlan', request.params.id, {
        meals: remainingMeals,
        total_expected_servings: summary.total_expected_servings,
        total_calories: summary.total_calories,
        status: 'draft'
      });
      return response.json(buildApiObjectResponse({ success: true, preserved_event_meals: true, plan: updated }, { action: 'delete' }));
    }

    await deleteDocument('MenuPlan', request.params.id);
    return response.json(buildApiObjectResponse({ success: true }, { action: 'delete' }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/special-events', requireAuth, requireAnyPermission([
  'manage_menu_planning',
  'create_special_event',
  'edit_special_event',
  'submit_special_event',
  'review_special_event',
  'approve_special_event',
  'reject_special_event'
]), async (request, response, next) => {
  try {
    const events = await listScopedSpecialEvents(request.user, Number(request.query.limit || 300));
    if (String(request.query.details || 'true').toLowerCase() === 'false') {
      return response.json(events);
    }
    const payload = await Promise.all(events.map((event) => buildSpecialEventResponse(request.user, event)));
    return response.json(payload);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/special-events/budgets', requireAuth, requireAnyPermission([
  'manage_menu_planning',
  'create_special_event',
  'edit_special_event',
  'submit_special_event',
  'review_special_event',
  'approve_special_event',
  'reject_special_event'
]), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const eventDate = String(request.query.event_date || request.query.plan_date || '').trim();
    const eventName = String(request.query.event_name || '').trim();

    if (!siteId || !eventDate) {
      return response.status(400).json({ message: 'site_id and event_date are required' });
    }

    const budgetContext = await getSpecialEventBudgetContext(request.user, {
      site_id: siteId,
      plan_date: eventDate,
      event_date: eventDate,
      event_name: eventName,
      budget_id: String(request.query.budget_id || '').trim() || null,
      estimated_cost: numericMatch(request.query.estimated_cost, 0)
    });

    return response.json(budgetContext);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/special-events/recipes', requireAuth, requireAnyPermission([
  'manage_menu_planning',
  'create_special_event',
  'edit_special_event',
  'submit_special_event',
  'review_special_event',
  'approve_special_event',
  'reject_special_event'
]), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const scope = await getLocationScope(request.user);
    const recipes = await listDocuments('Recipe', { sort: 'name', limit: 5000 });
    const scopedRecipes = filterRecordsByLocation(request.user, 'Recipe', recipes, scope)
      .filter((recipe) => recipe.is_active !== false)
      .filter((recipe) => recipe.site_scope !== 'specific'
        || !siteId
        || (Array.isArray(recipe.site_ids) && recipe.site_ids.includes(siteId)));
    return response.json(await decorateRecipesWithServingWeights(scopedRecipes));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/special-events/:id', requireAuth, requireAnyPermission([
  'manage_menu_planning',
  'create_special_event',
  'edit_special_event',
  'submit_special_event',
  'review_special_event',
  'approve_special_event',
  'reject_special_event'
]), async (request, response, next) => {
  try {
    const event = await findScopedSpecialEventById(request.user, request.params.id);
    if (!event) {
      return response.status(404).json({ message: 'Special event not found' });
    }
    return response.json(buildApiObjectResponse(await buildSpecialEventResponse(request.user, event), { id: event.id }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/special-events/:id/history', requireAuth, requireAnyPermission([
  'manage_menu_planning',
  'create_special_event',
  'edit_special_event',
  'submit_special_event',
  'review_special_event',
  'approve_special_event',
  'reject_special_event'
]), async (request, response, next) => {
  try {
    const event = await findScopedSpecialEventById(request.user, request.params.id);
    if (!event) {
      return response.status(404).json({ message: 'Special event not found' });
    }
    return response.json(buildApiObjectResponse({
      id: event.id,
      status: event.status,
      approval_history: Array.isArray(event.approval_history) ? event.approval_history : []
    }, { id: event.id }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/special-events', requireAuth, requirePermission('create_special_event'), async (request, response, next) => {
  try {
    const payload = buildSpecialEventWritePayload(request.body || {});
    if (!payload.site_id || !payload.event_name || !payload.plan_date) {
      return response.status(400).json({ message: 'Event name, project, and event date are required' });
    }
    payload.status = SPECIAL_EVENT_STATUSES.draft;

    const initialSnapshot = await calculateSpecialEventPlanning(request.user, payload);
    Object.assign(payload, mergeSpecialEventSnapshot(payload, initialSnapshot));

    let budgetContext = await getSpecialEventBudgetContext(request.user, payload);
    if (!payload.budget_id && budgetContext.linked_budget) {
      payload.budget_id = budgetContext.linked_budget.id;
      payload.budget_name = budgetContext.linked_budget.name;
      payload.budget_amount = numericMatch(budgetContext.linked_budget.budget_amount, 0);
      payload.remaining_budget = numericMatch(budgetContext.budget_comparison.remaining_budget, 0);
      payload.exceeded_budget_by = numericMatch(budgetContext.budget_comparison.exceeded_amount, 0);
    } else if (payload.budget_id) {
      const selectedBudget = await validateMenuPlanBudgetSelection(request.user, payload);
      payload.budget_name = selectedBudget?.name || payload.budget_name || null;
      budgetContext = await getSpecialEventBudgetContext(request.user, payload);
      payload.budget_amount = numericMatch(budgetContext.linked_budget?.budget_amount, 0);
      payload.remaining_budget = numericMatch(budgetContext.budget_comparison.remaining_budget, 0);
      payload.exceeded_budget_by = numericMatch(budgetContext.budget_comparison.exceeded_amount, 0);
    }
    if (budgetContext.linked_budget) {
      payload.event_budget = numericMatch(budgetContext.linked_budget.budget_amount, 0);
    }

    authorizeEntityAction(request.user, 'MenuPlan', 'create', payload);
    const preparedPayload = await prepareEntityPayload(request.user, 'MenuPlan', payload);
    const created = await createDocument('MenuPlan', preparedPayload);
    return response.status(201).json(buildApiObjectResponse(await buildSpecialEventResponse(request.user, created), { action: 'create' }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/special-events/:id', requireAuth, requirePermission('edit_special_event'), async (request, response, next) => {
  try {
    const existing = await findScopedSpecialEventById(request.user, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Special event not found' });
    }

    if (!canEditSpecialEvent(existing)) {
      return response.status(400).json({ message: 'Only draft or rejected special events can be edited.' });
    }

    const payload = buildSpecialEventWritePayload(request.body || {}, existing);
    payload.status = existing.status;
    const initialSnapshot = await calculateSpecialEventPlanning(request.user, payload);
    Object.assign(payload, mergeSpecialEventSnapshot(payload, initialSnapshot));
    let budgetContext = await getSpecialEventBudgetContext(request.user, payload);
    if (!payload.budget_id && budgetContext.linked_budget) {
      payload.budget_id = budgetContext.linked_budget.id;
      payload.budget_name = budgetContext.linked_budget.name;
    } else if (payload.budget_id) {
      const selectedBudget = await validateMenuPlanBudgetSelection(request.user, payload);
      payload.budget_name = selectedBudget?.name || payload.budget_name || null;
      budgetContext = await getSpecialEventBudgetContext(request.user, payload);
    } else {
      payload.budget_name = null;
    }

    payload.budget_amount = numericMatch(budgetContext.linked_budget?.budget_amount, 0);
    payload.remaining_budget = numericMatch(budgetContext.budget_comparison.remaining_budget, 0);
    payload.exceeded_budget_by = numericMatch(budgetContext.budget_comparison.exceeded_amount, 0);
    if (budgetContext.linked_budget) {
      payload.event_budget = numericMatch(budgetContext.linked_budget.budget_amount, 0);
    }

    authorizeEntityAction(request.user, 'MenuPlan', 'update', payload, existing);
    const preparedPayload = await prepareEntityPayload(request.user, 'MenuPlan', payload, existing);
    const updated = await updateDocument('MenuPlan', request.params.id, preparedPayload);
    return response.json(buildApiObjectResponse(await buildSpecialEventResponse(request.user, updated), { action: 'update' }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/special-events/:id/generate-production', requireAuth, requirePermission('create_production_request'), async (request, response, next) => {
  try {
    const existing = await findScopedSpecialEventById(request.user, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Special event not found' });
    }

    const [recipes, ingredients] = await Promise.all([
      listDocuments('Recipe', { limit: 5000 }),
      listDocuments('Ingredient', { limit: 10000 })
    ]);
    const preparationScope = await getLocationScope(request.user);
    const requestedFulfillmentStoreId = String(
      request.body?.fulfillment_store_id || existing.fulfillment_store_id || ''
    ).trim();
    const fulfillmentStore = resolveProductionFulfillmentStore({
      site_id: existing.site_id,
      fulfillment_store_id: requestedFulfillmentStoreId
    }, preparationScope.sites);
    if (
      !preparationScope.unrestricted
      && !preparationScope.accessibleSiteIds.has(String(fulfillmentStore.id))
    ) {
      const error = new Error('You do not have access to the selected fulfillment Store');
      error.status = 403;
      throw error;
    }
    const eventForGeneration = {
      ...existing,
      fulfillment_store_id: fulfillmentStore.id,
      fulfillment_store_name: fulfillmentStore.name || null
    };
    const snapshot = await calculateSpecialEventPlanning(request.user, eventForGeneration);
    assertEventReadyForSubmission(eventForGeneration, snapshot);
    const currentPlans = await listDocuments('Production', {
      filters: { source_event_id: existing.id },
      limit: 500,
      location: preparationScope
    });
    const productionIds = [];
    let duplicateCount = 0;
    let reopenedCount = 0;
    const productionPayloads = buildEventProductionPlanPayloads(
      eventForGeneration,
      snapshot,
      recipes,
      ingredients
    );

    for (const eventProductionPayload of productionPayloads) {
      const productionPayload = {
        ...eventProductionPayload,
        fulfillment_store_id: fulfillmentStore.id,
        fulfillment_store_name: fulfillmentStore.name || null
      };
      const duplicate = currentPlans.find((plan) => (
        String(plan.source_event_recipe_id) === String(productionPayload.recipe_id)
        && String(plan.source_type || '').toLowerCase() === 'special_event'
        && String(plan.site_id || '') === String(existing.site_id || '')
      ));
      authorizeEntityAction(request.user, 'Production', 'create', productionPayload);
      const prepared = await prepareEntityPayload(
        request.user,
        'Production',
        productionPayload,
        null,
        {
          scope: preparationScope,
          recipeCatalog: recipes,
          ingredientCatalog: ingredients,
          trustedProductionSource: true
        }
      );
      const workflowPrepared = applyProductionWorkflowMetadata(request.user, {
        ...prepared,
        fulfillment_store_id: fulfillmentStore.id,
        fulfillment_store_name: fulfillmentStore.name || null
      });

      if (duplicate) {
        const reopened = await withTransaction(async (client) => {
          const lockedDuplicate = await findDocument('Production', duplicate.id, client, true);
          const lockedStatus = normalizeProductionStatus(lockedDuplicate?.status);
          if (
            !lockedDuplicate
            || !['rejected', 'cancelled'].includes(lockedStatus)
            || lockedDuplicate.consumption_report_id
          ) {
            return { record: lockedDuplicate || duplicate, mutated: false };
          }

          await cancelMaterialRequestsForProduction(
            lockedDuplicate.id,
            'Superseded while regenerating the linked special-event production plan.',
            client
          );
          let record = await updateDocument('Production', lockedDuplicate.id, {
            ...workflowPrepared,
            status: 'planned',
            linked_material_request_id: null,
            linked_material_request_number: null,
            material_request_status: null,
            pm_approval_status: null,
            pm_approved_by: null,
            pm_approved_by_name: null,
            pm_approved_at: null,
            pm_reviewed_by: null,
            pm_reviewed_by_name: null,
            pm_reviewed_at: null,
            area_approval_status: null,
            area_approved_by: null,
            area_approved_by_name: null,
            area_approved_at: null,
            area_reviewed_by: null,
            area_reviewed_by_name: null,
            area_reviewed_at: null,
            submitted_by: null,
            submitted_by_name: null,
            submitted_at: null,
            reviewed_at: null,
            review_notes: null,
            started_by: null,
            started_by_name: null,
            started_at: null
          }, client);
          await syncMaterialRequestForProduction(request.user, record, 'draft', client);
          record = await findDocument('Production', record.id, client);
          return { record, mutated: true };
        });
        productionIds.push(reopened.record.id);
        if (reopened.mutated) {
          reopenedCount += 1;
          await auditAction({
            user: request.user,
            action: 'PRODUCTION_REOPENED_FROM_SPECIAL_EVENT',
            entity: 'Production',
            entityId: reopened.record.id,
            details: { source_event_id: existing.id, saved_record: reopened.record }
          });
        } else {
          duplicateCount += 1;
        }
        continue;
      }

      const created = await withTransaction(async (client) => {
        let record = await createDocument('Production', workflowPrepared, client);
        await syncMaterialRequestForProduction(request.user, record, 'draft', client);
        record = await findDocument('Production', record.id, client);
        return record;
      });
      productionIds.push(created.id);
      await auditAction({
        user: request.user,
        action: 'PRODUCTION_CREATE_FROM_SPECIAL_EVENT',
        entity: 'Production',
        entityId: created.id,
        details: { source_event_id: existing.id, created_record: created }
      });
    }

    if (productionIds.length > duplicateCount) {
      recordChanged('Production');
      recordChanged('MaterialRequest');
    }

    const linkedRecipes = snapshot.linked_recipes.map((link) => ({ ...link, production_status: 'planned' }));
    const updated = await updateDocument('MenuPlan', existing.id, {
      production_plan_status: 'generated',
      production_plan_ids: productionIds,
      linked_recipes: linkedRecipes,
      fulfillment_store_id: fulfillmentStore.id,
      fulfillment_store_name: fulfillmentStore.name || null,
      prep_start_date: request.body?.prep_start_date || existing.prep_start_date || existing.event_date || existing.plan_date,
      production_generated_at: new Date().toISOString(),
      production_generated_by: request.user.email || null
    });
    return response.status(201).json(buildApiObjectResponse({
      event: await buildSpecialEventResponse(request.user, updated),
      production_plan_ids: productionIds,
      duplicate_count: duplicateCount,
      reopened_count: reopenedCount
    }, { action: 'generate_production' }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/special-events/:id/create-pr', requireAuth, requireAnyPermission([
  'edit_special_event',
  'manage_procurement',
  'create_material_request'
]), async (request, response, next) => {
  try {
    const existing = await findScopedSpecialEventById(request.user, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Special event not found' });
    }
    const scope = await getLocationScope(request.user);
    const requestedFulfillmentStoreId = String(
      request.body?.fulfillment_store_id || existing.fulfillment_store_id || ''
    ).trim();
    const fulfillmentStore = resolveProductionFulfillmentStore({
      site_id: existing.site_id,
      fulfillment_store_id: requestedFulfillmentStoreId
    }, scope.sites);
    if (!scope.unrestricted && !scope.accessibleSiteIds.has(String(fulfillmentStore.id))) {
      const error = new Error('You do not have access to the selected fulfillment Store');
      error.status = 403;
      throw error;
    }
    const eventForProcurement = {
      ...existing,
      fulfillment_store_id: fulfillmentStore.id,
      fulfillment_store_name: fulfillmentStore.name || null
    };
    const snapshot = await calculateSpecialEventPlanning(request.user, eventForProcurement);
    assertEventReadyForSubmission(eventForProcurement, snapshot);

    const result = await withTransaction(async (client) => {
      const lockedEvent = await findDocument('MenuPlan', existing.id, client, true);
      if (!lockedEvent || !isSpecialEventPlan(lockedEvent)) {
        const error = new Error('Special event not found');
        error.status = 404;
        throw error;
      }
      if (!filterRowsByAccessibleSites([lockedEvent], scope).length) {
        const error = new Error('Special event is outside your assigned Project scope');
        error.status = 403;
        throw error;
      }

      const linkedRequest = await getPurchaseRequestBySourceEventId(existing.id, client);
      if (linkedRequest) {
        const lockedStore = resolveProductionFulfillmentStore({
          ...lockedEvent,
          fulfillment_store_id: lockedEvent.fulfillment_store_id || fulfillmentStore.id
        }, scope.sites);
        if (!scope.unrestricted && !scope.accessibleSiteIds.has(String(lockedStore.id))) {
          const error = new Error('The existing event purchase request is outside your assigned Store scope.');
          error.status = 403;
          throw error;
        }
        if (String(linkedRequest.site_id || '') !== String(lockedStore.id)) {
          const error = new Error('The existing event purchase request is routed to a different Store. Reconcile it before continuing.');
          error.status = 409;
          throw error;
        }
        const updated = await updateDocument('MenuPlan', lockedEvent.id, {
          procurement_pr_status: linkedRequest.status || 'pending',
          procurement_pr_id: linkedRequest.id,
          procurement_pr_number: linkedRequest.request_number,
          fulfillment_store_id: lockedStore.id,
          fulfillment_store_name: lockedStore.name || null
        }, client);
        return { updated, requestRecord: linkedRequest, duplicatePrevented: true, noShortage: false };
      }

      if (
        existing.updated_date
        && lockedEvent.updated_date
        && String(existing.updated_date) !== String(lockedEvent.updated_date)
      ) {
        const error = new Error('The event changed while procurement was being prepared. Refresh and try again.');
        error.status = 409;
        throw error;
      }

      if (!snapshot.shortage_items.length) {
        const updated = await updateDocument('MenuPlan', lockedEvent.id, {
          procurement_pr_status: 'not_required',
          procurement_pr_id: null,
          procurement_pr_number: null,
          estimated_procurement_spend: 0,
          fulfillment_store_id: fulfillmentStore.id,
          fulfillment_store_name: fulfillmentStore.name || null
        }, client);
        return { updated, requestRecord: null, duplicatePrevented: false, noShortage: true };
      }

      const requestRecord = await createPurchaseRequest({
        request_number: `PR-EVT-${Date.now()}`,
        site_id: fulfillmentStore.id,
        site_name: fulfillmentStore.name || null,
        request_date: new Date().toISOString().slice(0, 10),
        needed_by: existing.prep_start_date || existing.event_date || existing.plan_date,
        priority: 'high',
        status: 'pending',
        approval_role: 'manager',
        auto_generated: true,
        source_type: 'special_event',
        source_event_id: existing.id,
        notes: `Auto-generated for event ${existing.event_name}`,
        items: buildEventPurchaseRequestItems(snapshot, existing.event_name)
      }, request.user, client);

      const updated = await updateDocument('MenuPlan', lockedEvent.id, {
        procurement_pr_status: requestRecord.status || 'pending',
        procurement_pr_id: requestRecord.id,
        procurement_pr_number: requestRecord.request_number,
        estimated_procurement_spend: snapshot.estimated_procurement_spend,
        procurement_generated_at: new Date().toISOString(),
        procurement_generated_by: request.user.email || null,
        procurement_generated_by_name: request.user.full_name || request.user.email || null,
        fulfillment_store_id: fulfillmentStore.id,
        fulfillment_store_name: fulfillmentStore.name || null
      }, client);
      return { updated, requestRecord, duplicatePrevented: false, noShortage: false };
    });

    if (result.requestRecord && !result.duplicatePrevented) {
      await auditAction({
        user: request.user,
        action: 'SPECIAL_EVENT_PURCHASE_REQUEST_CREATED',
        entity: 'MenuPlan',
        entityId: existing.id,
        details: {
          purchase_request_id: result.requestRecord.id,
          fulfillment_store_id: fulfillmentStore.id
        }
      });
    }
    return response.status(result.requestRecord && !result.duplicatePrevented ? 201 : 200).json(buildApiObjectResponse({
      event: await buildSpecialEventResponse(request.user, result.updated),
      duplicate_prevented: result.duplicatePrevented,
      no_shortage: result.noShortage,
      purchase_request_id: result.requestRecord?.id || null,
      purchase_request: result.requestRecord
    }, { action: 'create_pr' }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/special-events/:id/submit', requireAuth, requirePermission('submit_special_event'), async (request, response, next) => {
  try {
    const existing = await findScopedSpecialEventById(request.user, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Special event not found' });
    }

    if (!canEditSpecialEvent(existing)) {
      return response.status(400).json({ message: 'Only draft or rejected special events can be submitted.' });
    }

    const payload = buildSpecialEventWritePayload(existing, existing);
    const snapshot = await calculateSpecialEventPlanning(request.user, payload);
    assertEventReadyForSubmission(payload, snapshot);
    Object.assign(payload, mergeSpecialEventSnapshot(payload, snapshot));
    const budgetContext = await getSpecialEventBudgetContext(request.user, payload);
    const linkedBudget = budgetContext.linked_budget;
    if (!linkedBudget) {
      return response.status(400).json({ message: 'A valid linked budget is required before submitting a special event.' });
    }

    const historyEntry = createApprovalHistoryEntry({
      action: 'submitted',
      fromStatus: existing.status,
      toStatus: SPECIAL_EVENT_STATUSES.pendingApproval,
      actor: request.user,
      note: request.body?.note
    });

    const updated = await updateDocument('MenuPlan', existing.id, {
      status: SPECIAL_EVENT_STATUSES.pendingApproval,
      budget_id: linkedBudget.id,
      budget_name: linkedBudget.name,
      budget_amount: numericMatch(linkedBudget.budget_amount, 0),
      remaining_budget: numericMatch(budgetContext.budget_comparison.remaining_budget, 0),
      exceeded_budget_by: numericMatch(budgetContext.budget_comparison.exceeded_amount, 0),
      estimated_cost: numericMatch(snapshot.total_event_cost, 0),
      total_planned_cost: numericMatch(snapshot.total_event_cost, 0),
      linked_recipes: snapshot.linked_recipes,
      ingredient_requirements: snapshot.ingredient_requirements,
      estimated_procurement_spend: snapshot.estimated_procurement_spend,
      approval_checklist: snapshot.checklist,
      submitted_by: request.user.email || null,
      submitted_by_name: request.user.full_name || request.user.email || null,
      submitted_at: new Date().toISOString(),
      approval_history: appendApprovalHistory(existing.approval_history, historyEntry)
    });

    return response.json(buildApiObjectResponse(await buildSpecialEventResponse(request.user, updated), { action: 'submit' }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/special-events/:id/approve', requireAuth, requirePermission('approve_special_event'), async (request, response, next) => {
  try {
    const existing = await findScopedSpecialEventById(request.user, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Special event not found' });
    }

    if (String(existing.status) !== SPECIAL_EVENT_STATUSES.pendingApproval) {
      return response.status(400).json({ message: 'Only submitted special events can be approved.' });
    }

    const snapshot = await calculateSpecialEventPlanning(request.user, existing);
    assertEventReadyForSubmission(existing, snapshot);
    const pricedEvent = mergeSpecialEventSnapshot(existing, snapshot);
    const budgetContext = await getSpecialEventBudgetContext(request.user, pricedEvent);
    assertSpecialEventBudgetApproval(pricedEvent, budgetContext);

    const historyEntry = createApprovalHistoryEntry({
      action: 'approved',
      fromStatus: existing.status,
      toStatus: SPECIAL_EVENT_STATUSES.approved,
      actor: request.user,
      note: request.body?.note
    });

    const updated = await updateDocument('MenuPlan', existing.id, {
      status: SPECIAL_EVENT_STATUSES.approved,
      budget_id: budgetContext.linked_budget.id,
      budget_name: budgetContext.linked_budget.name,
      budget_amount: numericMatch(budgetContext.linked_budget.budget_amount, 0),
      remaining_budget: numericMatch(budgetContext.budget_comparison.remaining_budget, 0),
      exceeded_budget_by: numericMatch(budgetContext.budget_comparison.exceeded_amount, 0),
      estimated_cost: numericMatch(snapshot.total_event_cost, 0),
      total_planned_cost: numericMatch(snapshot.total_event_cost, 0),
      linked_recipes: snapshot.linked_recipes,
      ingredient_requirements: snapshot.ingredient_requirements,
      approval_checklist: snapshot.checklist,
      approved_by: request.user.email || null,
      approved_by_name: request.user.full_name || request.user.email || null,
      approved_at: new Date().toISOString(),
      approval_notes: String(request.body?.note || '').trim() || existing.approval_notes || null,
      approval_history: appendApprovalHistory(existing.approval_history, historyEntry)
    });

    return response.json(buildApiObjectResponse(await buildSpecialEventResponse(request.user, updated), { action: 'approve' }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/special-events/:id/reject', requireAuth, requirePermission('reject_special_event'), async (request, response, next) => {
  try {
    const existing = await findScopedSpecialEventById(request.user, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Special event not found' });
    }

    if (String(existing.status) !== SPECIAL_EVENT_STATUSES.pendingApproval) {
      return response.status(400).json({ message: 'Only submitted special events can be rejected.' });
    }

    const reason = String(request.body?.reason || request.body?.note || '').trim();
    if (!reason) {
      return response.status(400).json({ message: 'A rejection reason is required.' });
    }

    const historyEntry = createApprovalHistoryEntry({
      action: 'rejected',
      fromStatus: existing.status,
      toStatus: SPECIAL_EVENT_STATUSES.rejected,
      actor: request.user,
      note: reason
    });

    const updated = await updateDocument('MenuPlan', existing.id, {
      status: SPECIAL_EVENT_STATUSES.rejected,
      rejected_by: request.user.email || null,
      rejected_by_name: request.user.full_name || request.user.email || null,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
      approval_history: appendApprovalHistory(existing.approval_history, historyEntry)
    });

    return response.json(buildApiObjectResponse(await buildSpecialEventResponse(request.user, updated), { action: 'reject' }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/food-waste/context', requireAuth, requirePermission('manage_waste'), async (request, response, next) => {
  try {
    const siteId = String(request.query.site_id || '').trim();
    const wasteDate = String(request.query.waste_date || '').trim();
    const mealType = String(request.query.meal_type || '').trim();

    const errors = validateFoodWasteContextInput({ siteId, wasteDate, mealType });
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }

    const context = await buildFoodWasteContext(request.user, {
      siteId,
      wasteDate,
      mealType
    });

    return response.json(buildApiObjectResponse(context, { site_id: siteId, waste_date: wasteDate, meal_type: mealType }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/food-waste', requireAuth, requirePermission('manage_waste'), async (request, response, next) => {
  try {
    const records = await listDocuments('FoodWaste', {
      sort: request.query.sort || '-waste_date',
      limit: request.query.limit ? Number(request.query.limit) : 1000
    });
    const scopedRecords = await scopeEntityRecords(request.user, 'FoodWaste', records);
    const filteredRecords = filterFoodWasteRows(scopedRecords, {
      start_date: request.query.start_date,
      end_date: request.query.end_date,
      site_id: String(request.query.site_id || '').trim(),
      waste_category: String(request.query.waste_category || '').trim(),
      reason_code: String(request.query.reason_code || '').trim(),
      scope: String(request.query.scope || '').trim(),
      meal_type: String(request.query.meal_type || '').trim()
    });

    const isAdministrator = hasAdminAccess(request.user);
    return response.json(filteredRecords.map((record) => decorateFoodWasteRecord(record, new Date(), {
      isAdmin: isAdministrator
    })));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/food-waste', requireAuth, requirePermission('manage_waste'), async (request, response, next) => {
  try {
    const payload = { ...(request.body || {}) };
    const siteId = String(payload.site_id || '').trim();
    const wasteDate = normalizeDateOnly(payload.waste_date);
    const mealType = normalizeMealType(payload.meal_type);
    const evidenceImageUrl = String(payload.evidence_image_url || payload.image_url || '').trim();

    const errors = validateFoodWasteContextInput({ siteId, wasteDate, mealType });
    if (errors.length) {
      return response.status(400).json({ message: errors[0], errors });
    }
    if (!evidenceImageUrl) {
      return response.status(400).json({ message: 'Add a waste picture before saving this record.' });
    }
    if (String(payload.waste_scope || '').toLowerCase() === 'ingredient' && !String(payload.ingredient_id || '').trim()) {
      return response.status(400).json({ message: 'Select the location and ingredient to remove from inventory.' });
    }

    const context = await buildFoodWasteContext(request.user, {
      siteId,
      wasteDate,
      mealType
    });

    if (!context.is_within_recording_window) {
      return response.status(400).json({ message: context.message || 'Food waste recording is closed for this meal.' });
    }

    const matchingProduction = payload.production_id
      ? context.production_options.find((item) => item.id === payload.production_id) || null
      : null;
    const isBatchOverproductionWaste = String(payload.waste_category || '').toLowerCase() === 'batch_overproduction'
      && String(payload.waste_scope || '').toLowerCase() === 'batch';

    const preparedPayload = {
      ...payload,
      waste_date: wasteDate,
      meal_type: mealType,
      served_at: context.served_at,
      production_completed_at: context.production_completed_at,
      recording_window_basis: context.recording_window_basis,
      recording_window_open_at: context.recording_window_open_at,
      recording_deadline_at: context.recording_deadline_at,
      menu_plan_id: context.menu_plan?.id || null,
      menu_plan_name: context.menu_plan?.name || null,
      production_id: matchingProduction?.id || null,
      production_name: matchingProduction
        ? `${matchingProduction.recipe_name} - ${matchingProduction.production_date}`
        : payload.production_name || null,
      evidence_image_url: evidenceImageUrl,
      image_url: evidenceImageUrl,
      status: payload.status || 'logged'
    };

    authorizeEntityAction(request.user, 'FoodWaste', 'create', preparedPayload);
    const finalPayload = await prepareEntityPayload(request.user, 'FoodWaste', preparedPayload);
    const created = await withTransaction(async (client) => {
      let batchWasteAllocation = null;
      let payloadForCreate = finalPayload;
      if (isBatchOverproductionWaste) {
        const wasteWeightGrams = normalizeFoodWasteWeightGrams(
          finalPayload.wasted_weight_grams ?? finalPayload.quantity,
          finalPayload.unit
        );
        const scopedBatches = await listBatchOverproductionBatches(request.user, {
          siteId,
          wasteDate,
          mealType,
          executor: client,
          lock: true
        });
        batchWasteAllocation = allocateBatchOverproductionWaste({
          recipeId: finalPayload.recipe_id,
          wasteWeightGrams,
          batches: scopedBatches
        });
        const firstAllocation = batchWasteAllocation.allocations[0] || null;
        payloadForCreate = {
          ...finalPayload,
          source_type: 'batch_overproduction',
          waste_scope: 'batch',
          unit: 'g',
          quantity: batchWasteAllocation.wasted_weight_grams,
          wasted_weight_grams: batchWasteAllocation.wasted_weight_grams,
          wasted_production_equivalent_servings: batchWasteAllocation.wasted_production_equivalent_servings,
          output_allocations: batchWasteAllocation.allocations,
          production_id: finalPayload.production_id || firstAllocation?.production_id || null,
          batch_reference: finalPayload.batch_reference
            || batchWasteAllocation.allocations.map((allocation) => allocation.batch_number).filter(Boolean).join(', ')
            || null
        };
      }

      const wasteRecord = await createDocument('FoodWaste', payloadForCreate, client);
      if (batchWasteAllocation) {
        await Promise.all(batchWasteAllocation.batches.map((batch) => updateDocument('ProducedItemBatch', batch.id, {
          served_servings: batch.served_servings,
          served_weight_grams: batch.served_weight_grams,
          wasted_servings: batch.wasted_servings,
          wasted_weight_grams: batch.wasted_weight_grams,
          remaining_servings: batch.remaining_servings,
          remaining_weight_grams: batch.remaining_weight_grams,
          status: batch.status
        }, client)));
        return wasteRecord;
      }
      if (String(finalPayload.waste_scope || '').toLowerCase() !== 'ingredient' || !finalPayload.ingredient_id) {
        return wasteRecord;
      }
      const deduction = await deductStock({
        site_id: finalPayload.site_id,
        site_name: finalPayload.site_name,
        ingredient_id: finalPayload.ingredient_id,
        ingredient_name: finalPayload.ingredient_name,
        quantity: finalPayload.quantity,
        unit: finalPayload.unit,
        transaction_type: 'waste',
        transaction_date: finalPayload.waste_date,
        reference_id: wasteRecord.id,
        reference_type: 'FoodWaste',
        notes: finalPayload.notes || `Food waste recorded for ${finalPayload.ingredient_name || 'ingredient'}`,
        performed_by: request.user?.email || 'food-waste',
        reason_code: finalPayload.reason_code || 'food_waste',
        allow_shortage: false,
        source: 'food_waste',
        source_type: 'food_waste',
        idempotency_key: `${wasteRecord.id}:food-waste-deduction`,
        metadata: {
          waste_category: finalPayload.waste_category || null,
          meal_type: finalPayload.meal_type || null,
          evidence_image_url: finalPayload.evidence_image_url || null
        }
      }, client);
      return updateDocument('FoodWaste', wasteRecord.id, {
        inventory_transaction_id: deduction.transaction_id,
        inventory_deduction_quantity: deduction.issued_quantity,
        inventory_shortage_quantity: deduction.shortage_quantity,
        inventory_movement_layers: deduction.movement_layers,
        estimated_cost: deduction.total_cost || finalPayload.estimated_cost || 0
      }, client);
    });
    if (created.source_type === 'batch_overproduction') {
      recordChanged('ProducedItemBatch');
    }
    return response.status(201).json(buildApiObjectResponse(decorateFoodWasteRecord(created), { action: 'create' }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/food-waste/:id', requireAuth, async (request, response, next) => {
  try {
    const existing = await findDocument('FoodWaste', request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Food waste record not found' });
    }

    const scopedExisting = (await scopeEntityRecords(request.user, 'FoodWaste', [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this food waste record' });
    }

    const payload = request.body || {};
    const approvalOnly = isApprovalOnlyWastePatch(payload);

    if (approvalOnly) {
      if (!hasPermission(request.user, 'approve_waste')) {
        return response.status(403).json({ message: 'You do not have permission to approve food waste.' });
      }
    } else if (!hasPermission(request.user, 'manage_waste')) {
      return response.status(403).json({ message: 'You do not have permission to edit food waste.' });
    }

    if (!approvalOnly && !String(payload.evidence_image_url || payload.image_url || existing.evidence_image_url || existing.image_url || '').trim()) {
      return response.status(400).json({ message: 'Add a waste picture before saving this record.' });
    }

    const merged = {
      ...existing,
      ...payload,
      meal_type: normalizeMealType(payload.meal_type ?? existing.meal_type),
      waste_date: normalizeDateOnly(payload.waste_date ?? existing.waste_date),
      site_id: String(payload.site_id ?? existing.site_id ?? '').trim()
    };

    if (!approvalOnly) {
      const context = await buildFoodWasteContext(request.user, {
        siteId: merged.site_id,
        wasteDate: merged.waste_date,
        mealType: merged.meal_type
      });

      if (!context.can_edit) {
        return response.status(400).json({ message: context.message || 'Food waste editing is closed for this meal.' });
      }

      merged.served_at = context.served_at;
      merged.production_completed_at = context.production_completed_at;
      merged.recording_window_basis = context.recording_window_basis;
      merged.recording_window_open_at = context.recording_window_open_at;
      merged.recording_deadline_at = context.recording_deadline_at;
      merged.menu_plan_id = context.menu_plan?.id || null;
      merged.menu_plan_name = context.menu_plan?.name || null;

      const matchingProduction = merged.production_id
        ? context.production_options.find((item) => item.id === merged.production_id) || null
        : null;
      merged.production_id = matchingProduction?.id || null;
      merged.production_name = matchingProduction
        ? `${matchingProduction.recipe_name} - ${matchingProduction.production_date}`
        : merged.production_name || null;
    }

    authorizeEntityAction(request.user, 'FoodWaste', 'update', payload, existing);
    const preparedPayload = await prepareEntityPayload(request.user, 'FoodWaste', merged, existing);
    const updated = await updateDocument('FoodWaste', request.params.id, preparedPayload);
    return response.json(buildApiObjectResponse(decorateFoodWasteRecord(updated), { action: approvalOnly ? 'approval' : 'update' }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/ingredients/search', requireAuth, async (request, response, next) => {
  try {
    authorizeEntityAction(request.user, 'Ingredient', 'list');
    const scope = await getLocationScope(request.user);
    const requestedSiteId = request.query.site_id ? String(request.query.site_id) : '';
    if (requestedSiteId && !scope.unrestricted && !scope.accessibleSiteIds.has(requestedSiteId)) {
      return response.status(403).json({ message: 'You do not have access to this site' });
    }

    const siteIds = requestedSiteId
      ? [requestedSiteId]
      : scope.unrestricted
        ? null
        : [...scope.accessibleSiteIds];
    const result = await searchIngredients({
      query: request.query.q || '',
      page: request.query.page,
      limit: request.query.limit,
      siteIds,
      stockOnly: ['1', 'true'].includes(String(request.query.stock_only || '').toLowerCase())
    });
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/entities/:entity', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'list');
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    const { scope, location } = await getEntityLocationContext(request.user, entity);
    const shouldScopeUsersBeforeLimit = entity === 'User' && Boolean(scope && !scope.unrestricted);
    const records = await listDocuments(entity, {
      sort: request.query.sort,
      limit: shouldScopeUsersBeforeLimit ? undefined : limit,
      location
    });
    const scopedRecords = await scopeEntityRecords(request.user, entity, records, scope);
    const limitedRecords = shouldScopeUsersBeforeLimit && Number.isFinite(limit)
      ? scopedRecords.slice(0, Math.max(0, limit))
      : scopedRecords;
    response.json(await decorateEntityRecords(entity, limitedRecords, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity/filter', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'filter');
    const { scope, location } = await getEntityLocationContext(request.user, entity);
    const requestedLimit = Number(request.body?.limit);
    const shouldScopeUsersBeforeLimit = entity === 'User' && Boolean(scope && !scope.unrestricted);
    const records = await listDocuments(entity, {
      filters: request.body?.filters || {},
      sort: request.body?.sort,
      limit: shouldScopeUsersBeforeLimit ? undefined : request.body?.limit,
      location
    });
    const scopedRecords = await scopeEntityRecords(request.user, entity, records, scope);
    const limitedRecords = shouldScopeUsersBeforeLimit && Number.isFinite(requestedLimit)
      ? scopedRecords.slice(0, Math.max(0, requestedLimit))
      : scopedRecords;
    response.json(await decorateEntityRecords(entity, limitedRecords, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity/page', requireAuth, async (request, response, next) => {
  try {
    const { entity } = request.params;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'filter');

    const page = Math.max(1, Math.trunc(Number(request.body?.page) || 1));
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(request.body?.limit) || 50)));
    const offset = (page - 1) * limit;
    const filters = request.body?.filters || {};
    const sort = request.body?.sort;
    const { scope, location } = await getEntityLocationContext(request.user, entity);

    let pageResult;
    if (entity === 'User' && scope && !scope.unrestricted) {
      const records = await listDocuments(entity, { filters, sort });
      const scopedRecords = await scopeEntityRecords(request.user, entity, records, scope);
      pageResult = {
        items: scopedRecords.slice(offset, offset + limit),
        total_count: scopedRecords.length,
        limit,
        offset
      };
    } else {
      pageResult = await listDocumentsPage(entity, { filters, sort, limit, offset, location });
      pageResult.items = await scopeEntityRecords(request.user, entity, pageResult.items, scope);
    }

    const items = await decorateEntityRecords(entity, pageResult.items, request.user);
    const totalPages = Math.ceil(pageResult.total_count / limit);
    return response.json({
      items,
      total_count: pageResult.total_count,
      page,
      limit,
      total_pages: totalPages,
      has_more: page < totalPages
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    authorizeEntityAction(request.user, entity, 'read');
    const record = await findDocument(entity, request.params.id);
    if (!record) {
      return response.status(404).json({ message: 'Record not found' });
    }
    const scopedRecord = (await scopeEntityRecords(request.user, entity, [record]))[0];
    if (!scopedRecord) {
      return response.status(403).json({ message: 'You do not have access to this record' });
    }
    response.json((await decorateEntityRecords(entity, [scopedRecord], request.user))[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/entities/:entity', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    if (entity === 'MenuPlan' && isSpecialEventPlan(request.body || {})) {
      return response.status(400).json({ message: 'Special events must be created from the event planning module.' });
    }
    authorizeEntityAction(request.user, entity, 'create', request.body || {});
    let preparedPayload = await prepareEntityPayload(request.user, entity, request.body || {});
    if (entity === 'Production') {
      preparedPayload = applyProductionWorkflowMetadata(request.user, preparedPayload, null, request.body || {});
    }
    let record;
    if (entity === 'Production') {
      record = await withTransaction(async (client) => {
        let created = await createDocument(entity, preparedPayload, client);
        if (['draft', 'planned', 'pending_approval', 'changes_requested'].includes(String(created.status || ''))) {
          await syncMaterialRequestForProduction(request.user, created, 'draft', client);
          created = await findDocument(entity, created.id, client);
        }
        return created;
      });
    } else {
      record = await createDocument(entity, preparedPayload);
    }
    invalidateEntityAccessCaches(entity);
    recordChanged(entity);

    await auditAction({
      user: request.user,
      action: `${entity.toUpperCase()}_CREATE`,
      entity,
      entityId: record.id,
      details: { input: request.body || {}, created_record: record }
    });

    response.status(201).json((await decorateEntityRecords(entity, [record], request.user))[0]);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    const existing = await findDocument(entity, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Record not found' });
    }
    const scopedExisting = (await scopeEntityRecords(request.user, entity, [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this record' });
    }
    if (entity === 'MenuPlan' && isSpecialEventPlan(existing)) {
      return response.status(400).json({ message: 'Special events must be edited from the event planning module.' });
    }
    authorizeEntityAction(request.user, entity, 'update', request.body || {}, existing);
    const preparedPayload = entity === 'Production'
      ? null
      : await prepareEntityPayload(request.user, entity, request.body || {}, existing);
    let updated;
    let productionInventoryMutated = false;
    if (entity === 'Production') {
      updated = await withTransaction(async (client) => {
        const lockedExisting = await findDocument(entity, request.params.id, client, true);
        if (!lockedExisting) {
          const error = new Error('Record not found');
          error.status = 404;
          throw error;
        }
        authorizeEntityAction(request.user, entity, 'update', request.body || {}, lockedExisting);
        const lockedPreparedPayload = await prepareEntityPayload(
          request.user,
          entity,
          request.body || {},
          lockedExisting
        );
        let transactionPayload = applyProductionWorkflowMetadata(
          request.user,
          lockedPreparedPayload,
          lockedExisting,
          request.body || {}
        );
        const isAreaRejectionRollback = (
          ['pending_production', 'approved'].includes(normalizeProductionStatus(lockedExisting.status))
          && normalizeProductionStatus(request.body?.status) === 'pending_procurement'
          && normalizeProductionReviewAction(request.body?.review_action) === 'rejected'
        );
        if (isAreaRejectionRollback && hasProductionInventoryCommitment(lockedExisting)) {
          const sites = await listDocuments('Site', { limit: 5000 }, client);
          const fulfillmentStore = resolveProductionFulfillmentStore(lockedExisting, sites);
          const [ingredients, inventory] = await Promise.all([
            listDocuments('Ingredient', { limit: 10000 }, client),
            listDocuments('Inventory', {
              filters: { site_id: fulfillmentStore.id },
              limit: 10000
            }, client)
          ]);
          const releaseResult = await releaseProductionInventoryCommitment({
            production: lockedExisting,
            actor: request.user,
            reason: String(request.body?.rejection_reason || request.body?.review_notes || '').trim()
              || 'Area Manager rejection released the production inventory reservation.',
            operation: 'area_manager_rejection',
            siteCatalog: sites,
            ingredientCatalog: ingredients,
            inventoryCatalog: inventory,
            fulfillmentStore,
            targetServings: 0
          }, client);
          productionInventoryMutated = productionInventoryMutated || releaseResult.mutated;
          transactionPayload = {
            ...transactionPayload,
            ...releaseResult.production_patch
          };
        }
        if (
          normalizeProductionStatus(request.body?.status) === 'in_progress'
          && normalizeProductionStatus(lockedExisting.status) !== 'in_progress'
        ) {
          const fulfillmentStore = await assertProductionStartPrerequisites(lockedExisting, client, request.user);
          const commitmentResult = await reconcileProductionInventoryForWorkflow({
            production: lockedExisting,
            user: request.user,
            executor: client,
            fulfillmentStore,
            operation: hasProductionInventoryCommitment(lockedExisting)
              ? 'start_validation'
              : 'legacy_start_reservation',
            reason: hasProductionInventoryCommitment(lockedExisting)
              ? 'Validated Area Manager inventory reservation before production start.'
              : 'Reserved inventory for a legacy approved production before start.'
          });
          const reservationReadyProduction = {
            ...lockedExisting,
            ...commitmentResult.production_patch,
            fulfillment_store_id: fulfillmentStore.id,
            fulfillment_store_name: fulfillmentStore.name || null
          };
          if (!hasStartableProductionInventory(reservationReadyProduction)) {
            const error = new Error(
              'Production cannot start until its yield-adjusted inventory requirement is fully reserved.'
            );
            error.status = 409;
            throw error;
          }
          const consumptionResult = await consumeProductionInventoryReservation({
            production: reservationReadyProduction,
            actor: request.user,
            reason: `Reserved inventory consumed when production started: ${lockedExisting.recipe_name || lockedExisting.id}`
          }, client);
          productionInventoryMutated = productionInventoryMutated
            || commitmentResult.mutated
            || consumptionResult.inventory_mutated;
          transactionPayload = {
            ...transactionPayload,
            ...commitmentResult.production_patch,
            ...consumptionResult.production_patch,
            fulfillment_store_id: fulfillmentStore.id,
            fulfillment_store_name: fulfillmentStore.name || null
          };
        }
        let saved = await updateDocument(entity, request.params.id, transactionPayload, client);
        const status = String(saved?.status || '');
        if (['draft', 'planned', 'pending_approval', 'changes_requested'].includes(status)) {
          await syncMaterialRequestForProduction(request.user, saved, 'draft', client);
          saved = await findDocument(entity, request.params.id, client);
        } else if (status === 'pending_procurement') {
          await syncMaterialRequestForProduction(
            request.user,
            saved,
            'activate',
            client,
            isAreaRejectionRollback
          );
          saved = await findDocument(entity, request.params.id, client);
        }
        return saved;
      });
    } else {
      updated = await updateDocument(entity, request.params.id, preparedPayload);
    }
    invalidateEntityAccessCaches(entity);
    recordChanged(entity);
    if (productionInventoryMutated) {
      recordChanged('Inventory');
      recordChanged('InventoryLot');
      recordChanged('InventoryTransaction');
    }

    await auditAction({
      user: request.user,
      action: entity === 'Production'
        ? getProductionWorkflowAuditAction(updated)
        : `${entity.toUpperCase()}_UPDATE`,
      entity,
      entityId: updated.id,
      details: { before: existing, input: request.body || {}, after: updated }
    });

    return response.json((await decorateEntityRecords(entity, [updated], request.user))[0]);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/entities/:entity/:id', requireAuth, async (request, response, next) => {
  try {
    const entity = request.params.entity;
    ensureKnownEntity(entity);
    const existing = await findDocument(entity, request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Record not found' });
    }
    const scopedExisting = (await scopeEntityRecords(request.user, entity, [existing]))[0];
    if (!scopedExisting) {
      return response.status(403).json({ message: 'You do not have access to this record' });
    }
    if (entity === 'MenuPlan' && isSpecialEventPlan(existing)) {
      return response.status(400).json({ message: 'Special events must be deleted from the event planning module.' });
    }
    let relatedInventoryLots = [];
    let relatedInventoryTransactions = [];
    if (entity === 'Inventory') {
      const inventoryIdentityFilters = {
        site_id: existing.site_id,
        ingredient_id: existing.ingredient_id
      };
      [relatedInventoryLots, relatedInventoryTransactions] = await Promise.all([
        listDocuments('InventoryLot', {
          filters: inventoryIdentityFilters,
          limit: 1
        }),
        listDocuments('InventoryTransaction', {
          filters: inventoryIdentityFilters,
          limit: 1
        })
      ]);
    }
    assertInventoryLedgerDeleteAllowed(
      entity,
      existing,
      relatedInventoryLots,
      relatedInventoryTransactions
    );
    if (entity === 'Recipe') {
      const recipes = await listDocuments('Recipe', { limit: 5000 });
      const referencingRecipe = recipes.find((recipe) => (
        recipe.id !== existing.id
        && (Array.isArray(recipe.sub_recipes) ? recipe.sub_recipes : [])
          .some((line) => line?.recipe_id === existing.id)
      ));
      if (referencingRecipe) {
        return response.status(409).json({
          message: `Recipe cannot be deleted because it is used by ${referencingRecipe.name || 'another recipe'}.`
        });
      }
    }
    authorizeEntityAction(request.user, entity, 'delete', null, existing);
    const includeDescendants = ['1', 'true'].includes(
      String(request.query.include_descendants || '').trim().toLowerCase()
    );
    if (entity === 'Site' && includeDescendants) {
      const deletion = await deleteSiteSubtree(existing.id);
      invalidateEntityAccessCaches(entity);
      recordChanged(entity);
      await auditAction({
        user: request.user,
        action: 'SITE_SUBTREE_DELETE',
        entity,
        entityId: existing.id,
        details: {
          include_descendants: true,
          root_site_id: deletion.root_site_id,
          deleted_count: deletion.deleted_count,
          deleted_site_ids: deletion.deleted_site_ids,
          deleted_records: deletion.deleted_sites
        }
      });
      return response.json({
        success: true,
        include_descendants: true,
        root_site_id: deletion.root_site_id,
        deleted_count: deletion.deleted_count,
        deleted_site_ids: deletion.deleted_site_ids
      });
    }
    const removed = await deleteDocument(entity, request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'Record not found' });
    }
    invalidateEntityAccessCaches(entity);
    recordChanged(entity);
    await auditAction({
      user: request.user,
      action: `${entity.toUpperCase()}_DELETE`,
      entity,
      entityId: request.params.id,
      details: { deleted_record: existing }
    });
    return response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

function serializeBulkUploadJob(job) {
  if (!job) return null;
  const { file_path: _filePath, actor_snapshot: _actorSnapshot, ...safeJob } = job;
  return safeJob;
}

function normalizeNotificationToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatNotificationActionLabel(value) {
  return String(value || 'Activity')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const notificationRoleAliases = {
  admin: ['admin', 'administrator', 'super_admin'],
  project_manager: ['project_manager', 'pm', 'manager', 'project'],
  procurement: ['procurement', 'procurement_officer', 'storekeeper', 'store', 'store_manager', 'warehouse', 'inventory_manager'],
  area_manager: ['area_manager', 'am', 'area'],
  chef: ['chef', 'production_supervisor', 'production', 'production_user', 'kitchen'],
  user: ['user']
};

function getNotificationRoleTokens(user = {}) {
  const rawValues = [
    user.role,
    user.role_name,
    user.access_level,
    user.dashboard_variant,
    ...(Array.isArray(user.role_permissions) ? user.role_permissions : [])
  ];
  const tokens = new Set(rawValues.map(normalizeNotificationToken).filter(Boolean));
  Object.entries(notificationRoleAliases).forEach(([canonical, aliases]) => {
    if (aliases.some((alias) => tokens.has(alias))) tokens.add(canonical);
  });
  if (tokens.has('acknowledge_material_request') || tokens.has('manage_procurement') || tokens.has('approve_procurement')) {
    tokens.add('procurement');
  }
  if (tokens.has('approve_production_request') || tokens.has('review_production_request')) {
    tokens.add('project_manager');
  }
  if (tokens.has('approve_production') || tokens.has('request_changes_area_production') || tokens.has('reject_area_production')) {
    tokens.add('area_manager');
  }
  if (tokens.has('create_production_request') || tokens.has('submit_production_request') || tokens.has('start_production')) {
    tokens.add('chef');
  }
  if (getUserEffectiveRole(user) === 'admin') tokens.add('admin');
  return tokens;
}

function textIncludesAny(source, needles = []) {
  return needles.some((needle) => source.includes(needle));
}

function getWorkflowNotificationAudience(log = {}) {
  const action = normalizeNotificationToken(log.action);
  const entity = normalizeNotificationToken(log.entity);
  const details = normalizeNotificationToken(JSON.stringify(log.details || {}));
  const text = `${action} ${entity} ${details}`;
  const audience = new Set();

  if (entity === 'production' || action.startsWith('production_')) {
    audience.add('admin');
    audience.add('chef');
    if (textIncludesAny(text, ['submitted_for_pm_approval', 'pending_pm_approval', 'pending_approval'])) {
      audience.add('project_manager');
    }
    if (textIncludesAny(text, ['pm_approved', 'pending_procurement', 'store_procurement', 'procurement', 'material_request'])) {
      audience.add('procurement');
      audience.add('project_manager');
    }
    if (textIncludesAny(text, ['pending_area_manager_approval', 'area_approval_status_pending', 'area_manager'])) {
      audience.add('area_manager');
    }
    if (textIncludesAny(text, ['area_approved', 'area_rejected', 'production_started', 'production_completed', 'cancelled'])) {
      audience.add('project_manager');
      audience.add('procurement');
      audience.add('area_manager');
    }
    return [...audience];
  }

  if (entity === 'materialrequest' || textIncludesAny(text, ['material_request', 'purchase_request'])) {
    return ['admin', 'project_manager', 'procurement', 'area_manager'];
  }

  if (
    entity === 'purchaseorder'
    || entity === 'goodsreceipt'
    || textIncludesAny(text, ['purchase_order', 'goods_receipt', 'supplier_invoice'])
  ) {
    return ['admin', 'procurement', 'project_manager'];
  }

  if (textIncludesAny(text, ['bulk_upload_failed', 'bulk_upload_completed', 'bulk_upload_queued'])) {
    return ['admin'];
  }

  if (textIncludesAny(text, ['approval', 'approved', 'rejected', 'submitted', 'acknowledged', 'workflow'])) {
    return ['admin', 'project_manager', 'procurement', 'area_manager'];
  }

  return [];
}

function isWorkflowNotificationLog(log = {}) {
  return getWorkflowNotificationAudience(log).length > 0;
}

function canReceiveWorkflowNotification(user, log) {
  const userRoles = getNotificationRoleTokens(user);
  const audience = getWorkflowNotificationAudience(log);
  return audience.some((role) => userRoles.has(role));
}

function getNotificationProductionRecord(log = {}) {
  const details = log.details || {};
  return details.after
    || details.saved_record
    || details.created_record
    || details.production
    || details.input
    || {};
}

function getProductionNotificationFields(log = {}) {
  const action = normalizeNotificationToken(log.action);
  const record = getNotificationProductionRecord(log);
  const recipeName = record.recipe_name || record.recipe || record.name || 'Production request';
  const siteName = record.site_name || log.site_name || 'assigned project';
  const actorName = log.actor_name || log.actor_email || 'System';
  const materialRequestNumber = record.linked_material_request_number
    || log.details?.saved_record?.request_number
    || log.details?.saved_record?.material_request_number
    || '';

  if (action === 'production_create' || action === 'production_submitted_for_pm_approval') {
    return {
      title: 'Production created by Chef',
      message: `${recipeName} for ${siteName} is pending Project Manager approval.`,
      workflow_step: 'Pending PM Approval'
    };
  }

  if (action === 'production_pm_approved') {
    return {
      title: 'PM approved and forwarded to Procurement',
      message: `${recipeName} was approved by ${actorName} and sent to Store / Procurement${materialRequestNumber ? ` as ${materialRequestNumber}` : ''}.`,
      workflow_step: 'Pending Store / Procurement'
    };
  }

  if (action === 'production_material_request_activated') {
    return {
      title: 'Material request pending Procurement',
      message: `${recipeName} material request is ready for Store / Procurement acknowledgement.`,
      workflow_step: 'Pending Store / Procurement'
    };
  }

  if (action === 'production_procurement_acknowledged') {
    return {
      title: 'Procurement approved production',
      message: `${recipeName} was acknowledged by ${actorName}, inventory was reserved, and production is ready to start.`,
      workflow_step: 'Production Approved'
    };
  }

  if (action === 'production_area_approved') {
    return {
      title: 'Production approved',
      message: `${recipeName} was approved by Area Manager and is ready for production execution.`,
      workflow_step: 'Production Approved'
    };
  }

  if (action === 'production_started') {
    return {
      title: 'Production started',
      message: `${recipeName} production has started.`,
      workflow_step: 'In Production'
    };
  }

  if (action === 'production_completed') {
    return {
      title: 'Production completed',
      message: `${recipeName} production has been completed.`,
      workflow_step: 'Completed'
    };
  }

  if (action.includes('rejected') || action.includes('changes_requested')) {
    return {
      title: 'Production returned for changes',
      message: `${recipeName} was returned by ${actorName}.`,
      workflow_step: 'Changes Requested'
    };
  }

  return {
    title: formatNotificationActionLabel(log.action),
    message: `${log.entity || 'Workflow'}${siteName ? ` for ${siteName}` : ''}`,
    workflow_step: record.status ? formatNotificationActionLabel(record.status) : 'Workflow Update'
  };
}

function serializeNotificationLog(log, notificationType) {
  const workflowFields = notificationType === 'workflow'
    ? getProductionNotificationFields(log)
    : {};
  return {
    id: log.id,
    notification_type: notificationType,
    ...workflowFields,
    action: log.action,
    entity: log.entity,
    entity_id: log.entity_id,
    actor_name: log.actor_name || 'System',
    actor_email: log.actor_email || '',
    role: log.role || '',
    site_name: log.site_name || '',
    site_id: log.site_id || '',
    created_at: log.created_at
  };
}

async function accessibleSiteIds(user) {
  const scope = await getLocationScope(user);
  return scope.unrestricted ? null : [...scope.accessibleSiteIds];
}

app.get('/api/utilities/modules', requireAuth, requireAnyPermission([
  'manage_bulk_uploads',
  'export_data',
  'view_reports',
  'view_audit_logs'
]), (_request, response) => {
  response.json({ modules: listUtilityModules() });
});

app.get('/api/utilities/templates/:module', requireAuth, requireAnyPermission([
  'manage_bulk_uploads',
  'export_data'
]), async (request, response) => {
  const csv = createTemplateCsv(request.params.module);
  if (!csv) return response.status(404).json({ message: 'Template module not found.' });
  await auditAction({
    user: request.user,
    action: 'BULK_TEMPLATE_DOWNLOAD',
    entity: 'UtilityTemplate',
    entityId: request.params.module,
    details: { module: request.params.module }
  });
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${request.params.module}-template.csv"`);
  return response.send(csv);
});

app.post('/api/utilities/bulk-upload', requireAuth, requireBulkUploadAdministrator, (request, response, next) => {
  bulkUpload.single('file')(request, response, async (uploadError) => {
    let cleanupReference = request.file?.path || null;
    const cleanupUploadedFile = () => cleanupReference
      ? removeStoredReference(cleanupReference).catch(() => {})
      : Promise.resolve();
    if (uploadError) {
      await cleanupUploadedFile();
      const status = uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return response.status(status).json({ message: uploadError.message || 'Bulk upload failed.' });
    }
    try {
      const moduleKey = String(request.body?.module || '');
      const definition = getUtilityModule(moduleKey);
      if (!definition) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select a supported upload module.' });
      }
      const importMode = String(request.body?.import_mode || 'keep_existing');
      if (!['keep_existing', 'update_stock_only', 'replace_existing', 'delete_existing'].includes(importMode)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Invalid import mode.' });
      }
      if (importMode === 'update_stock_only' && !['Ingredient', 'Inventory'].includes(definition.entity)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Update stock only is available for Inventory and Ingredients uploads.' });
      }
      const sourceNameRequired = ['Ingredient', 'Inventory'].includes(definition.entity)
        && importMode !== 'delete_existing';
      const sourceName = normalizeSourceName(request.body?.source_name, '');
      if (sourceNameRequired && !isValidSourceName(sourceName)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select Source Name: D365 or Cash before uploading.' });
      }
      const recipeTypeRequired = definition.entity === 'Recipe';
      const recipeType = String(request.body?.recipe_type || '').trim().toLowerCase();
      if (recipeTypeRequired && !['general', 'filipino'].includes(recipeType)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select Recipe Type: General or Filipino before continuing.' });
      }
      const menuPlanOptionsRequired = definition.entity === 'MenuPlan';
      const menuCuisine = normalizeMenuCuisine(request.body?.menu_cuisine, '');
      const menuCategory = normalizeMenuCategory(request.body?.menu_category, '');
      if (menuPlanOptionsRequired && !['general', 'philippines'].includes(menuCuisine)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select Menu Cuisine: General or Philippines before uploading.' });
      }
      if (menuPlanOptionsRequired && !['senior', 'junior', 'labor', 'management_menu'].includes(menuCategory)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select Menu Category: Senior, Junior, Labor, or Management Menu before uploading.' });
      }
      if (menuPlanOptionsRequired && menuCuisine === 'philippines' && menuCategory === 'management_menu') {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Philippines menus support Senior, Junior, or Labor categories.' });
      }
      if (importMode !== 'delete_existing' && !request.file) {
        return response.status(400).json({ message: 'Select a CSV file to upload.' });
      }
      if (importMode === 'delete_existing' && request.file) {
        await cleanupUploadedFile();
        cleanupReference = null;
        request.file = undefined;
      }
      const scope = await getLocationScope(request.user);
      let requestedProjectId = String(request.body?.project_id || '').trim() || null;
      const requestedSiteId = String(request.body?.site_id || '').trim() || null;
      const requiresStoreScope = definition.entity !== 'Site';
      const scopeSites = Array.isArray(scope.sites) ? scope.sites : [];
      const selectedStore = scopeSites.find((site) => String(site.id) === requestedSiteId);
      if (!requestedProjectId && selectedStore && normalizeSiteType(selectedStore.type) === SITE_HIERARCHY_TYPES.STORE) {
        requestedProjectId = String(selectedStore.parent_site_id || '').trim() || null;
      }
      const selectedProject = scopeSites.find((site) => String(site.id) === requestedProjectId);
      if (requiresStoreScope && (!requestedProjectId || !requestedSiteId)) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select a Project and Store before uploading.' });
      }
      if (requestedProjectId && !scope.unrestricted && !scope.accessibleSiteIds.has(requestedProjectId)) {
        await cleanupUploadedFile();
        return response.status(403).json({ message: 'You do not have access to the selected project.' });
      }
      if (requestedSiteId && !scope.unrestricted && !scope.accessibleSiteIds.has(requestedSiteId)) {
        await cleanupUploadedFile();
        return response.status(403).json({ message: 'You do not have access to the selected store.' });
      }
      if (requiresStoreScope && (
        !selectedProject
        || normalizeSiteType(selectedProject.type) !== SITE_HIERARCHY_TYPES.PROJECT
        || !selectedStore
        || normalizeSiteType(selectedStore.type) !== SITE_HIERARCHY_TYPES.STORE
        || String(selectedStore.parent_site_id || '') !== requestedProjectId
      )) {
        await cleanupUploadedFile();
        return response.status(400).json({ message: 'Select a Store that belongs to the selected Project.' });
      }
      const batchSize = Math.min(
        Math.max(Number(process.env.BULK_UPLOAD_BATCH_SIZE || 500), 50),
        1000
      );
      const persistedUpload = request.file
        ? await persistUploadedFile(request.file, 'bulk-uploads')
        : null;
      cleanupReference = persistedUpload?.reference || cleanupReference;
      const job = await createBulkUploadJob({
        module_key: moduleKey,
        entity_name: definition.entity,
        import_mode: importMode,
        file_name: request.file?.originalname || null,
        file_path: persistedUpload?.reference || null,
        file_size: request.file?.size || 0,
        batch_size: batchSize,
        actor: request.user,
        site_id: requestedSiteId,
        site_name: selectedStore?.name || null,
        source_name: sourceNameRequired ? sourceName : null,
        options: {
          ...(recipeTypeRequired ? { recipe_type: recipeType } : {}),
          ...(menuPlanOptionsRequired ? { menu_cuisine: menuCuisine, menu_category: menuCategory } : {})
        }
      });
      cleanupReference = null;
      await auditAction({
        user: request.user,
        action: 'BULK_UPLOAD_QUEUED',
        entity: definition.entity,
        entityId: job.id,
        siteId: job.site_id,
        siteName: job.site_name,
        details: {
          module: moduleKey,
          file_name: job.file_name,
          file_size: Number(job.file_size),
          import_mode: importMode,
          batch_size: batchSize,
          source_name: sourceNameRequired ? sourceName : null,
          recipe_type: recipeTypeRequired ? recipeType : null,
          menu_cuisine: menuPlanOptionsRequired ? menuCuisine : null,
          menu_category: menuPlanOptionsRequired ? menuCategory : null,
          project_id: requestedProjectId
        }
      });
      enqueueBulkUpload(job.id);
      return response.status(202).json({ job: serializeBulkUploadJob(job) });
    } catch (error) {
      await cleanupUploadedFile();
      return next(error);
    }
  });
});

app.get('/api/activity/bulk-upload-jobs', requireAuth, requireAnyPermission([
  'manage_bulk_uploads',
  'view_bulk_upload_progress'
]), async (request, response, next) => {
  try {
    const siteIds = await accessibleSiteIds(request.user);
    const jobs = await listBulkUploadJobs({
      limit: request.query.limit ? Number(request.query.limit) : 100,
      siteIds,
      actorId: request.user.id
    });
    response.json({ jobs: jobs.map(serializeBulkUploadJob) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/activity/bulk-upload-jobs/:id', requireAuth, requireAnyPermission([
  'manage_bulk_uploads',
  'view_bulk_upload_progress'
]), async (request, response, next) => {
  try {
    const job = await getBulkUploadJob(request.params.id);
    if (!job) return response.status(404).json({ message: 'Bulk upload job not found.' });
    const siteIds = await accessibleSiteIds(request.user);
    const ownsJob = job.actor_id && job.actor_id === request.user.id;
    const canSeeSite = siteIds === null || (job.site_id && siteIds.includes(String(job.site_id)));
    if (!ownsJob && !canSeeSite) return response.status(403).json({ message: 'You cannot access this upload job.' });
    return response.json({ job: serializeBulkUploadJob(job) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/activity/notifications', requireAuth, async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    const siteIds = await accessibleSiteIds(request.user);
    const [scopedLogs, personalLogs] = await Promise.all([
      listAuditLogs({ limit: 250, siteIds }),
      listAuditLogs({ limit: 100, actorId: request.user.id })
    ]);
    const merged = new Map();
    scopedLogs
      .filter((log) => isWorkflowNotificationLog(log) && canReceiveWorkflowNotification(request.user, log))
      .forEach((log) => merged.set(log.id, serializeNotificationLog(log, 'workflow')));
    personalLogs
      .forEach((log) => merged.set(log.id, serializeNotificationLog(
        log,
        isWorkflowNotificationLog(log) ? 'workflow' : 'user_action'
      )));
    const notifications = [...merged.values()]
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
      .slice(0, limit);
    response.json({
      notifications
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/activity/audit-logs', requireAuth, requirePermission('view_audit_logs'), async (request, response, next) => {
  try {
    const siteIds = await accessibleSiteIds(request.user);
    const logs = await listAuditLogs({
      limit: request.query.limit ? Number(request.query.limit) : 200,
      offset: request.query.offset ? Number(request.query.offset) : 0,
      action: request.query.action || '',
      entity: request.query.entity || '',
      search: request.query.search || '',
      siteIds,
      actorId: request.user.id
    });
    response.json({ logs });
  } catch (error) {
    next(error);
  }
});

app.get('/api/utilities/reports/:module', requireAuth, requireAnyPermission([
  'view_reports',
  'export_data'
]), async (request, response, next) => {
  try {
    const definition = getUtilityModule(request.params.module);
    if (!definition) return response.status(404).json({ message: 'Report module not found.' });
    const records = await listDocuments(definition.entity, {
      sort: '-updated_date',
      limit: Math.min(Math.max(Number(request.query.limit) || 500, 1), 5000)
    });
    const scopedRecords = await scopeEntityRecords(request.user, definition.entity, records);
    await auditAction({
      user: request.user,
      action: 'REPORT_PREVIEW',
      entity: definition.entity,
      entityId: request.params.module,
      details: { module: request.params.module, rows: scopedRecords.length }
    });
    response.json({
      module: { key: request.params.module, label: definition.label, entity: definition.entity },
      rows: serializeReportRows(scopedRecords)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/integrations/upload', requireAuth, upload.single('file'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ message: 'Select a file to upload.' });
    const stored = await persistUploadedFile(request.file, 'integration-uploads');
    return response.json({
      file_url: stored.fileUrl,
      public_file_url: absoluteFileUrl(request, stored.publicFileUrl || stored.fileUrl)
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/integrations/recipe-image', requireAuth, (request, response, next) => {
  recipeImageUpload.single('file')(request, response, async (error) => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Recipe pictures must not exceed 1 MB.'
        : (error.message || 'Recipe picture upload failed.');
      return response.status(status).json({ message });
    }
    if (!request.file) {
      return response.status(400).json({ message: 'Select an image to upload.' });
    }
    try {
      const stored = await persistUploadedFile(request.file, 'recipe-images');
      return response.json({
        file_url: stored.fileUrl,
        public_file_url: absoluteFileUrl(request, stored.publicFileUrl || stored.fileUrl)
      });
    } catch (storageError) {
      return next(storageError);
    }
  });
});

app.post('/api/integrations/waste-image', requireAuth, (request, response, next) => {
  recipeImageUpload.single('file')(request, response, async (error) => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Waste pictures must not exceed 1 MB.'
        : (error.message || 'Waste picture upload failed.');
      return response.status(status).json({ message });
    }
    if (!request.file) {
      return response.status(400).json({ message: 'Select a waste picture to upload.' });
    }
    try {
      const stored = await persistUploadedFile(request.file, 'waste-images');
      return response.json({
        file_url: stored.fileUrl,
        public_file_url: absoluteFileUrl(request, stored.publicFileUrl || stored.fileUrl)
      });
    } catch (storageError) {
      return next(storageError);
    }
  });
});

app.post('/api/integrations/send-email', requireAuth, async (request, response) => {
  const payload = request.body || {};

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: payload.to,
      subject: payload.subject || 'FoodPro Notification',
      html: payload.html || payload.body || '<p>No content provided.</p>'
    });
  } else {
    await createEmailLog({
      ...payload,
      status: 'logged_only'
    });
  }

  response.json({ success: true });
});

app.post('/api/integrations/invoke-llm', requireAuth, async (request, response, next) => {
  try {
    const output = await invokeOpenAI(request.body || {}, resolvePublicBaseUrl(request));
    response.json(output);
  } catch (error) {
    next(error);
  }
});

app.post('/api/integrations/extract-file', requireAuth, requireBulkUploadAdministrator, async (request, response, next) => {
  try {
    const { file_url: fileUrl, json_schema: jsonSchema } = request.body || {};
    let content = null;
    if (fileUrl?.startsWith('/uploads/')) {
      const localPath = path.join(uploadsDir, path.basename(fileUrl));
      if (fs.existsSync(localPath)) content = fs.readFileSync(localPath, 'utf8');
    } else if (objectStorageEnabled && fileUrl?.startsWith('/files/')) {
      const key = decodeURIComponent(fileUrl.slice('/files/'.length));
      const object = await getStoredObject(key);
      content = object.buffer.toString('utf8');
    }

    if (content === null) return response.status(404).json({ message: 'Uploaded file not found' });
    const rows = projectToSchema(parseCsv(content), jsonSchema);
    response.json({
      status: 'success',
      output: { data: rows }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/app-logs', requireAuth, (request, response) => {
  createAppLog({
    page_name: request.body?.pageName,
    user_id: request.user.id,
    user_email: request.user.email,
    payload: request.body || {}
  }).then((log) => {
    response.status(201).json(log);
  }).catch((error) => {
    response.status(500).json({ message: error.message || 'Failed to create app log' });
  });
});

app.get('/api/pos/sources', requireAuth, requireRole(['admin']), async (_request, response, next) => {
  try {
    response.json(await getPosSources());
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/sources', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const created = await createPosSource(request.body || {});
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/pos/sources/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await updatePosSource(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'POS source not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pos/sources/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deletePosSource(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'POS source not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/mappings', requireAuth, requireRole(['admin', 'manager']), async (_request, response, next) => {
  try {
    response.json(await getRecipeMappings());
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/mappings', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const created = await createRecipeMapping(request.body || {});
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/pos/mappings/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const updated = await updateRecipeMapping(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'POS mapping not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pos/mappings/:id', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const removed = await deleteRecipeMapping(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'POS mapping not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/sync-logs', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    response.json(await getSyncLogs(limit));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/import/manual', requireAuth, requireBulkUploadAdministrator, async (request, response, next) => {
  try {
    const result = await importPosOrders({
      sourceId: request.body?.source_id || null,
      syncType: 'manual_upload',
      actorEmail: request.user.email,
      orders: request.body?.orders || [],
      requestPayload: {
        source_id: request.body?.source_id || null,
        order_count: Array.isArray(request.body?.orders) ? request.body.orders.length : 0
      }
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/sources/:id/sync', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const result = await syncPosSource(request.params.id, request.user.email);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/sales-summary', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getDailySalesSummary({
      startDate: request.query.start_date,
      endDate: request.query.end_date,
      locationId: request.user.role === 'admin'
        ? request.query.location_id
        : (request.query.location_id || [...scope.accessibleSiteIds][0] || null)
    });
    response.json(filterRowsByAccessibleSites(report, scope, ['site_id']));
  } catch (error) {
    next(error);
  }
});

app.get('/api/pos/variance-report', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const report = await getSalesProductionVariance({
      startDate: request.query.start_date,
      endDate: request.query.end_date,
      locationId: request.user.role === 'admin'
        ? request.query.location_id
        : (request.query.location_id || [...scope.accessibleSiteIds][0] || null)
    });
    response.json(filterRowsByAccessibleSites(report, scope, ['site_id']));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pos/webhooks/:sourceId', requireAuth, requireRole(['admin']), async (request, response, next) => {
  try {
    const payload = Array.isArray(request.body?.orders) ? request.body.orders : (Array.isArray(request.body) ? request.body : []);
    const result = await importPosOrders({
      sourceId: request.params.sourceId,
      syncType: 'webhook',
      actorEmail: request.user.email,
      orders: payload,
      requestPayload: { sourceId: request.params.sourceId, webhook: true }
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/material-requests', requireAuth, requireAnyPermission(['view_material_request', 'create_material_request', 'acknowledge_material_request', 'manage_procurement', 'approve_procurement']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const limit = Math.min(5000, Math.max(1, Number(request.query?.limit) || 1000));
    const records = await listDocuments('MaterialRequest', {
      sort: '-request_date',
      limit,
      location: scope
    });
    response.json(await enrichRecordsWithIngredientItemCodes(records));
  } catch (error) {
    next(error);
  }
});

app.post('/api/material-requests/from-production/:id', requireAuth, requirePermission('create_material_request'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const result = await withTransaction(async (client) => {
      const production = await findDocument('Production', request.params.id, client, true);
      if (!production) {
        const error = new Error('Production record not found');
        error.status = 404;
        throw error;
      }
      if (!filterRowsByAccessibleSites(
        [production],
        scope,
        ['site_id', 'fulfillment_store_id']
      ).length) {
        const error = new Error('Production record is outside your assigned Project or Store scope');
        error.status = 403;
        throw error;
      }
      if (normalizeProductionStatus(production.status) !== 'pending_procurement') {
        const error = new Error('A production material request can only be activated after Project Manager approval.');
        error.status = 409;
        throw error;
      }

      const materialRequest = await syncMaterialRequestForProduction(
        request.user,
        production,
        'activate',
        client
      );
      const updatedProduction = await findDocument('Production', production.id, client);
      return { materialRequest, production: updatedProduction };
    });

    recordChanged('MaterialRequest');
    recordChanged('Production');
    await auditAction({
      user: request.user,
      action: result.materialRequest
        ? 'PRODUCTION_MATERIAL_REQUEST_ACTIVATED'
        : 'PRODUCTION_MATERIAL_REQUEST_NOT_REQUIRED',
      entity: 'Production',
      entityId: result.production.id,
      details: {
        saved_record: result.production,
        material_request_id: result.materialRequest?.id || null
      }
    });

    if (!result.materialRequest) {
      return response.status(200).json({
        material_request: null,
        production: result.production,
        message: 'No stock-managed ingredients are required. The request is approved and ready to start.'
      });
    }
    return response.status(201).json(result.materialRequest);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/material-requests/:id/acknowledge', requireAuth, requirePermission('acknowledge_material_request'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const scopedRequest = await findDocument('MaterialRequest', request.params.id);
    if (!scopedRequest || !filterRowsByAccessibleSites([scopedRequest], scope).length) {
      return response.status(404).json({ message: 'Material request not found' });
    }
    const sourceProductionId = String(scopedRequest.source_production_id || '').trim();
    const updated = await withTransaction(async (client) => {
      // Keep the same Production -> MaterialRequest lock order used by Area approval.
      const production = sourceProductionId
        ? await findDocument('Production', sourceProductionId, client, true)
        : null;
      const materialRequest = await findDocument('MaterialRequest', request.params.id, client, true);
      if (!materialRequest || !filterRowsByAccessibleSites([materialRequest], scope).length) {
        const error = new Error('Material request is outside your assigned Store scope');
        error.status = 403;
        throw error;
      }
      if (String(materialRequest.source_production_id || '').trim() !== sourceProductionId) {
        const error = new Error('Material request source changed while it was being reviewed. Refresh and try again.');
        error.status = 409;
        throw error;
      }
      if (String(materialRequest?.status || '').toLowerCase() !== 'pending_procurement_ack') {
        const error = new Error('Only a material request awaiting Store / Procurement acknowledgement can be approved');
        error.status = 409;
        throw error;
      }
      const isLegacyApprovedWithoutArea = Boolean(
        production
        && normalizeProductionStatus(production.status) === 'approved'
        && requiresAreaProductionApproval(production)
      );
      if (materialRequest.source_type === 'production' && !materialRequest.source_production_id) {
        const error = new Error('Production material request is missing its source production link');
        error.status = 409;
        throw error;
      }
      if (materialRequest.source_production_id && String(materialRequest.source_type || '').toLowerCase() !== 'production') {
        const error = new Error('Linked production material request has an invalid source type');
        error.status = 409;
        throw error;
      }
      if (
        materialRequest.source_production_id
        && (!production || (
          normalizeProductionStatus(production.status) !== 'pending_procurement'
          && !isLegacyApprovedWithoutArea
        ))
      ) {
        const error = new Error('The linked production request is not awaiting Store / Procurement action');
        error.status = 409;
        throw error;
      }
      let fulfillmentStore = null;
      if (production) {
        fulfillmentStore = resolveProductionFulfillmentStore(production, scope.sites);
        if (
          production.linked_material_request_id
          && String(production.linked_material_request_id) !== String(materialRequest.id)
        ) {
          const error = new Error('Material request does not match the Production linked request');
          error.status = 409;
          throw error;
        }
        if (String(materialRequest.site_id || '') !== String(fulfillmentStore.id)) {
          const error = new Error('Material request is not routed to the Production fulfillment Store');
          error.status = 409;
          throw error;
        }
        if (
          materialRequest.requesting_site_id
          && String(materialRequest.requesting_site_id) !== String(production.site_id)
        ) {
          const error = new Error('Material request Project does not match the linked Production Project');
          error.status = 409;
          throw error;
        }
        if (
          materialRequest.fulfillment_store_id
          && String(materialRequest.fulfillment_store_id) !== String(fulfillmentStore.id)
        ) {
          const error = new Error('Material request fulfillment Store does not match the linked Production');
          error.status = 409;
          throw error;
        }
      }
      const acknowledgedAt = new Date().toISOString();
      const acknowledged = await updateDocument('MaterialRequest', request.params.id, {
        status: 'acknowledged',
        acknowledged_by: request.user.email,
        acknowledged_by_name: request.user.full_name || request.user.email,
        acknowledged_at: acknowledgedAt,
        procurement_notes: request.body?.notes || materialRequest.procurement_notes || null
      }, client);
      let productionRecord = null;
      let inventoryMutated = false;
      if (production) {
        const productionForReservation = {
          ...production,
          status: 'approved',
          material_request_status: 'acknowledged',
          linked_material_request_id: materialRequest.id,
          linked_material_request_number: materialRequest.request_number || null,
          fulfillment_store_id: fulfillmentStore.id,
          fulfillment_store_name: fulfillmentStore.name || null
        };
        const commitmentResult = await reconcileProductionInventoryForWorkflow({
          production: productionForReservation,
          user: request.user,
          executor: client,
          fulfillmentStore,
          operation: 'store_procurement_approval',
          reason: String(request.body?.notes || '').trim()
            || 'Yield-adjusted inventory reserved when Store / Procurement approved production.'
        });
        inventoryMutated = commitmentResult.mutated;
        productionRecord = await updateDocument('Production', production.id, {
          ...commitmentResult.production_patch,
          status: 'approved',
          material_request_status: 'acknowledged',
          procurement_approved_by: request.user.email,
          procurement_approved_by_name: request.user.full_name || request.user.email,
          procurement_approved_at: acknowledgedAt,
          area_approval_status: null,
          area_approved_by: null,
          area_approved_by_name: null,
          area_approved_at: null,
          linked_material_request_id: materialRequest.id,
          linked_material_request_number: materialRequest.request_number || null,
          fulfillment_store_id: fulfillmentStore.id,
          fulfillment_store_name: fulfillmentStore.name || null,
          last_review_action: 'procurement_acknowledged',
          approval_history: appendProductionApprovalHistory(production, {
            action: 'procurement_acknowledged',
            stage: 'store_procurement',
            from_status: normalizeProductionStatus(production.status),
            to_status: 'approved',
            actor_id: request.user.id || null,
            actor_email: request.user.email || null,
            actor_name: request.user.full_name || request.user.email || null,
            reason: String(request.body?.notes || '').trim() || null,
            note: String(request.body?.notes || '').trim() || null,
            timestamp: acknowledgedAt
          })
        }, client);
      }
      return { acknowledged, production: productionRecord, inventoryMutated };
    });
    recordChanged('MaterialRequest');
    recordChanged('Production');
    if (updated.inventoryMutated) {
      recordChanged('Inventory');
      recordChanged('InventoryLot');
      recordChanged('InventoryTransaction');
    }
    await auditAction({
      user: request.user,
      action: 'PRODUCTION_PROCUREMENT_ACKNOWLEDGED',
      entity: 'MaterialRequest',
      entityId: updated.acknowledged.id,
      details: {
        saved_record: updated.acknowledged,
        production_record: updated.production,
        notes: request.body?.notes || null
      }
    });
    response.json(updated.acknowledged);
  } catch (error) {
    next(error);
  }
});

app.post('/api/productions/:id/area-approve', requireAuth, requirePermission('approve_production'), async (request, response, next) => {
  try {
    const { production, scope } = await getScopedProduction(request, request.params.id);
    if (!production) {
      return response.status(404).json({ message: 'Production record not found' });
    }

    const result = await withTransaction(async (client) => {
      const lockedProduction = await findDocument('Production', request.params.id, client, true);
      const currentStatus = normalizeProductionStatus(lockedProduction?.status);
      const isApprovedRecord = currentStatus === 'approved';
      const areaApprovalWasAlreadyRecorded = isApprovedRecord && !requiresAreaProductionApproval(lockedProduction);

      if (currentStatus !== 'pending_production' && !isApprovedRecord) {
        const error = new Error('Only a legacy Pending Production request can receive final production approval');
        error.status = 409;
        throw error;
      }

      const requestedFulfillmentStoreId = String(request.body?.fulfillment_store_id || '').trim();
      if (
        lockedProduction.fulfillment_store_id
        && requestedFulfillmentStoreId
        && String(lockedProduction.fulfillment_store_id) !== requestedFulfillmentStoreId
      ) {
        const error = new Error('The fulfillment Store cannot be changed after procurement routing');
        error.status = 409;
        throw error;
      }
      const siteCatalog = await listDocuments('Site', { limit: 5000 }, client);
      const fulfillmentStore = resolveProductionFulfillmentStore({
        ...lockedProduction,
        fulfillment_store_id: lockedProduction.fulfillment_store_id || requestedFulfillmentStoreId
      }, siteCatalog);
      if (!scope.unrestricted && !scope.accessibleSiteIds.has(String(fulfillmentStore.id))) {
        const error = new Error('You do not have access to the selected fulfillment Store');
        error.status = 403;
        throw error;
      }
      let currentProduction = lockedProduction;
      let repairedApprovedRecord = false;
      if (
        String(lockedProduction.fulfillment_store_id || '') !== String(fulfillmentStore.id)
        || String(lockedProduction.fulfillment_store_name || '') !== String(fulfillmentStore.name || '')
      ) {
        currentProduction = await updateDocument('Production', lockedProduction.id, {
          fulfillment_store_id: fulfillmentStore.id,
          fulfillment_store_name: fulfillmentStore.name || null
        }, client);
        repairedApprovedRecord = areaApprovalWasAlreadyRecorded;
      }

      let materialStatus = String(currentProduction.material_request_status || '').toLowerCase();
      let materialRequest = currentProduction.linked_material_request_id
        ? await findDocument('MaterialRequest', currentProduction.linked_material_request_id, client, true)
        : null;

      const linkedAcknowledgementIsValid = Boolean(
        materialRequest
        && String(materialRequest.status || '').toLowerCase() === 'acknowledged'
        && String(materialRequest.source_type || '').toLowerCase() === 'production'
        && String(materialRequest.source_production_id || '') === String(currentProduction.id)
        && String(materialRequest.site_id || '') === String(fulfillmentStore.id)
      );
      const hasStaleLegacyAcknowledgement = isApprovedRecord
        && (
          materialStatus === 'acknowledged'
          || String(materialRequest?.status || '').toLowerCase() === 'acknowledged'
        )
        && !linkedAcknowledgementIsValid;

      if (hasStaleLegacyAcknowledgement) {
        const requestBelongsToProduction = materialRequest
          && String(materialRequest.source_production_id || '') === String(currentProduction.id);
        if (requestBelongsToProduction) {
          await updateDocument('MaterialRequest', materialRequest.id, {
            status: 'pending_procurement_ack',
            source_type: 'production',
            site_id: fulfillmentStore.id,
            site_name: fulfillmentStore.name || null,
            requesting_site_id: currentProduction.site_id || null,
            requesting_site_name: currentProduction.site_name || null,
            fulfillment_store_id: fulfillmentStore.id,
            fulfillment_store_name: fulfillmentStore.name || null,
            acknowledged_by: null,
            acknowledged_by_name: null,
            acknowledged_at: null,
            procurement_notes: 'Legacy acknowledgement was reset because a fresh Store-level acknowledgement is required.'
          }, client);
        }
        currentProduction = await updateDocument('Production', currentProduction.id, {
          status: 'pending_procurement',
          material_request_status: 'pending_procurement_ack',
          area_approval_status: 'pending',
          ...(!requestBelongsToProduction ? {
            linked_material_request_id: null,
            linked_material_request_number: null
          } : {})
        }, client);
        await syncMaterialRequestForProduction(request.user, currentProduction, 'activate', client, true);
        currentProduction = await findDocument('Production', currentProduction.id, client);
        materialStatus = String(currentProduction.material_request_status || '').toLowerCase();
        materialRequest = currentProduction.linked_material_request_id
          ? await findDocument('MaterialRequest', currentProduction.linked_material_request_id, client, true)
          : null;
        if (!(materialStatus === 'not_required' && normalizeProductionStatus(currentProduction.status) === 'pending_production')) {
          return {
            record: currentProduction,
            mutated: true,
            action: 'reconciled_to_procurement'
          };
        }
      }

      const hasAuthoritativeEmptyIngredients = hasAuthoritativeNoMaterialRequirement(currentProduction);

      if (
        isApprovedRecord
        && materialRequest
        && String(materialRequest.status || '').toLowerCase() === 'acknowledged'
      ) {
        currentProduction = await updateDocument('Production', lockedProduction.id, {
          material_request_status: 'acknowledged'
        }, client);
        materialStatus = 'acknowledged';
        repairedApprovedRecord = areaApprovalWasAlreadyRecorded;
      } else if (
        isApprovedRecord
        && !(
          materialStatus === 'acknowledged'
          || (materialStatus === 'not_required' && hasAuthoritativeEmptyIngredients)
        )
      ) {
        currentProduction = await updateDocument('Production', lockedProduction.id, {
          status: 'pending_procurement',
          area_approval_status: 'pending'
        }, client);
        await syncMaterialRequestForProduction(request.user, currentProduction, 'activate', client);
        currentProduction = await findDocument('Production', lockedProduction.id, client);
        materialStatus = String(currentProduction.material_request_status || '').toLowerCase();
        if (!(materialStatus === 'not_required' && normalizeProductionStatus(currentProduction.status) === 'pending_production')) {
          return {
            record: currentProduction,
            mutated: true,
            action: 'reconciled_to_procurement'
          };
        }
      }

      const currentHasAuthoritativeEmptyIngredients = hasAuthoritativeNoMaterialRequirement(currentProduction);
      if (
        materialStatus !== 'acknowledged'
        && !(materialStatus === 'not_required' && currentHasAuthoritativeEmptyIngredients)
      ) {
        const error = new Error('Store / Procurement must acknowledge the material request before final production approval');
        error.status = 409;
        throw error;
      }
      if (materialStatus === 'acknowledged') {
        materialRequest = currentProduction.linked_material_request_id
          ? await findDocument('MaterialRequest', currentProduction.linked_material_request_id, client, true)
          : materialRequest;
        if (!materialRequest || String(materialRequest.status || '').toLowerCase() !== 'acknowledged') {
          const error = new Error('The linked material request has not been acknowledged by Store / Procurement');
          error.status = 409;
          throw error;
        }
        if (String(materialRequest.source_production_id || '') !== String(currentProduction.id)) {
          const error = new Error('The acknowledged material request belongs to a different Production request');
          error.status = 409;
          throw error;
        }
      }

      if (
        materialStatus === 'acknowledged'
        && String(materialRequest.site_id || '') !== String(fulfillmentStore.id)
      ) {
        const error = new Error('The acknowledged material request is not assigned to the current fulfillment Store');
        error.status = 409;
        throw error;
      }

      const approvalNote = String(request.body?.notes || '').trim() || null;
      const commitmentResult = await reconcileProductionInventoryForWorkflow({
        production: currentProduction,
        user: request.user,
        executor: client,
        fulfillmentStore,
        siteCatalog,
        operation: areaApprovalWasAlreadyRecorded
          ? 'approved_record_reservation_repair'
          : 'area_manager_approval',
        reason: approvalNote || 'Yield-adjusted inventory reserved when the Area Manager approved production.'
      });

      if (areaApprovalWasAlreadyRecorded) {
        const record = commitmentResult.mutated
          ? await updateDocument('Production', currentProduction.id, commitmentResult.production_patch, client)
          : currentProduction;
        return {
          record,
          mutated: repairedApprovedRecord || commitmentResult.mutated,
          inventoryMutated: commitmentResult.mutated,
          action: commitmentResult.mutated
            ? 'approved_inventory_reconciled'
            : repairedApprovedRecord
              ? 'approved_record_repaired'
              : 'already_approved'
        };
      }

      const approvedAt = new Date().toISOString();
      const record = await updateDocument('Production', lockedProduction.id, {
        ...commitmentResult.production_patch,
        status: 'approved',
        area_approval_status: 'approved',
        area_approved_by: request.user.email,
        area_approved_by_name: request.user.full_name || request.user.email,
        area_approved_at: approvedAt,
        fulfillment_store_id: fulfillmentStore.id,
        fulfillment_store_name: fulfillmentStore.name || null,
        reviewed_at: approvedAt,
        review_notes: approvalNote || currentProduction.review_notes || null,
        rejection_reason: null,
        rejection_stage: null,
        rejection_return_status: null,
        last_review_action: 'area_approved',
        approval_history: appendProductionApprovalHistory(currentProduction, {
          action: 'area_approved',
          stage: 'area_manager',
          from_status: normalizeProductionStatus(currentProduction.status),
          to_status: 'approved',
          actor_id: request.user.id || null,
          actor_email: request.user.email || null,
          actor_name: request.user.full_name || request.user.email || null,
          reason: approvalNote,
          note: approvalNote,
          timestamp: approvedAt
        })
      }, client);
      return {
        record,
        mutated: true,
        inventoryMutated: commitmentResult.mutated,
        action: 'area_approved'
      };
    });

    if (result.mutated) {
      recordChanged('Production');
      if (result.action === 'reconciled_to_procurement') recordChanged('MaterialRequest');
      if (result.inventoryMutated) {
        recordChanged('Inventory');
        recordChanged('InventoryLot');
        recordChanged('InventoryTransaction');
      }
      await auditAction({
        user: request.user,
        action: result.action === 'area_approved'
          ? 'PRODUCTION_AREA_APPROVED'
          : result.action === 'approved_inventory_reconciled'
            ? 'PRODUCTION_APPROVED_INVENTORY_RECONCILED'
          : result.action === 'approved_record_repaired'
            ? 'PRODUCTION_APPROVED_WORKFLOW_REPAIRED'
            : 'PRODUCTION_LEGACY_WORKFLOW_RECONCILED',
        entity: 'Production',
        entityId: result.record.id,
        details: {
          saved_record: result.record,
          workflow_action: result.action,
          notes: request.body?.notes || null
        }
      });
    }
    response.json((await decorateEntityRecords('Production', [result.record]))[0]);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/productions/:id/approved-quantity', requireAuth, requireAnyPermission([
  'adjust_approved_production',
  'approve_production'
]), async (request, response, next) => {
  try {
    const reason = String(request.body?.reason || '').trim();
    const targetServings = Number(request.body?.target_servings);
    const expectedRevision = Number(request.body?.expected_revision);
    if (!reason) return response.status(400).json({ message: 'A reason is required for an approved quantity change.' });
    if (!Number.isFinite(targetServings) || targetServings <= 0) {
      return response.status(400).json({ message: 'Revised production servings must be greater than zero.' });
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return response.status(400).json({ message: 'The current inventory commitment revision is required. Reload the production request and retry.' });
    }

    const { production, scope } = await getScopedProduction(request, request.params.id);
    if (!production) return response.status(404).json({ message: 'Production record not found' });

    const result = await withTransaction(async (client) => {
      const lockedProduction = await findDocument('Production', request.params.id, client, true);
      if (!lockedProduction || !filterRowsByAccessibleSites(
        [lockedProduction],
        scope,
        ['site_id', 'fulfillment_store_id']
      ).length) {
        const error = new Error('You do not have access to this production record');
        error.status = 403;
        throw error;
      }
      if (normalizeProductionStatus(lockedProduction.status) !== 'approved') {
        const error = new Error('Only an approved production that has not started can be quantity-adjusted');
        error.status = 409;
        throw error;
      }
      if (Math.abs(Number(lockedProduction.target_servings || 0) - targetServings) < 0.000001) {
        const error = new Error('The revised production quantity is unchanged');
        error.status = 409;
        throw error;
      }

      const approvedSnapshot = scaleApprovedProductionSnapshot(lockedProduction, targetServings);
      const siteCatalog = await listDocuments('Site', { limit: 5000 }, client);
      const fulfillmentStore = resolveProductionFulfillmentStore(lockedProduction, siteCatalog);
      // Keep the acknowledged procurement snapshot aligned with the revised,
      // yield-adjusted demand. A quantity adjustment does not silently reopen
      // approval, but it must never leave an old Material Request behind.
      await syncMaterialRequestForProduction(request.user, {
        ...lockedProduction,
        ...approvedSnapshot,
        status: 'pending_procurement',
        fulfillment_store_id: fulfillmentStore.id,
        fulfillment_store_name: fulfillmentStore.name || null
      }, 'activate', client, false, true);
      const synchronizedProduction = await findDocument('Production', lockedProduction.id, client, true);
      const commitmentResult = await reconcileProductionInventoryForWorkflow({
        production: synchronizedProduction || lockedProduction,
        user: request.user,
        executor: client,
        fulfillmentStore,
        siteCatalog,
        desiredIngredients: approvedSnapshot.ingredients_used,
        operation: 'approved_quantity_adjustment',
        reason,
        expectedRevision,
        targetServings
      });
      const adjustedAt = new Date().toISOString();
      const direction = targetServings > Number(lockedProduction.target_servings || 0)
        ? 'increased'
        : 'reduced';
      const record = await updateDocument('Production', lockedProduction.id, {
        status: 'approved',
        area_approval_status: 'approved',
        target_servings: approvedSnapshot.target_servings,
        recipe_name: approvedSnapshot.recipe_name,
        ingredients_used: approvedSnapshot.ingredients_used,
        estimated_batch_cost: approvedSnapshot.estimated_batch_cost,
        estimated_cost_per_serving: approvedSnapshot.estimated_cost_per_serving,
        yield_adjustment_applied: approvedSnapshot.yield_adjustment_applied,
        yield_adjustment_version: approvedSnapshot.yield_adjustment_version,
        yield_adjustment_updated_at: approvedSnapshot.yield_adjustment_updated_at,
        yield_snapshot_source: approvedSnapshot.yield_snapshot_source,
        production_warnings: approvedSnapshot.production_warnings,
        inventory_approved_snapshot: approvedSnapshot.inventory_approved_snapshot,
        quantity_semantics: approvedSnapshot.quantity_semantics,
        recipe_raw_weight_grams: approvedSnapshot.recipe_raw_weight_grams,
        expected_finished_weight_grams: approvedSnapshot.expected_finished_weight_grams,
        portion_size_grams: approvedSnapshot.portion_size_grams,
        portion_size_source: approvedSnapshot.portion_size_source,
        expected_yield_servings: approvedSnapshot.expected_yield_servings,
        actual_finished_weight_grams: null,
        produced_servings: null,
        produced_item_batch_id: null,
        produced_item_batch_number: null,
        ...commitmentResult.production_patch,
        last_review_action: 'production_quantity_adjusted',
        approval_history: appendProductionApprovalHistory(lockedProduction, {
          action: `production_quantity_${direction}`,
          stage: 'area_manager_inventory_reconciliation',
          from_status: 'approved',
          to_status: 'approved',
          actor_id: request.user.id || null,
          actor_email: request.user.email || null,
          actor_name: request.user.full_name || request.user.email || null,
          reason,
          note: `${lockedProduction.target_servings || 0} → ${targetServings} servings`,
          timestamp: adjustedAt
        })
      }, client);
      return {
        record,
        inventoryMutated: commitmentResult.mutated,
        materialRequestMutated: true,
        direction
      };
    });

    recordChanged('Production');
    if (result.materialRequestMutated) recordChanged('MaterialRequest');
    if (result.inventoryMutated) {
      recordChanged('Inventory');
      recordChanged('InventoryLot');
      recordChanged('InventoryTransaction');
    }
    await auditAction({
      user: request.user,
      action: 'PRODUCTION_APPROVED_QUANTITY_RECONCILED',
      entity: 'Production',
      entityId: result.record.id,
      details: {
        direction: result.direction,
        previous_target_servings: production.target_servings,
        target_servings: result.record.target_servings,
        commitment_revision: result.record.inventory_commitment_revision,
        reason,
        saved_record: result.record
      }
    });
    response.json((await decorateEntityRecords('Production', [result.record]))[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/productions/:id/cancel', requireAuth, requirePermission('cancel_production'), async (request, response, next) => {
  try {
    const reason = String(request.body?.reason || '').trim();
    if (!reason) return response.status(400).json({ message: 'A cancellation reason is required.' });
    const { production, scope } = await getScopedProduction(request, request.params.id);
    if (!production) return response.status(404).json({ message: 'Production record not found' });

    const result = await withTransaction(async (client) => {
      const lockedProduction = await findDocument('Production', request.params.id, client, true);
      if (!lockedProduction || !filterRowsByAccessibleSites(
        [lockedProduction],
        scope,
        ['site_id', 'fulfillment_store_id']
      ).length) {
        const error = new Error('You do not have access to this production record');
        error.status = 403;
        throw error;
      }
      const status = normalizeProductionStatus(lockedProduction.status);
      if (status === 'cancelled') {
        return { record: lockedProduction, mutated: false, inventoryMutated: false, materialRequestMutated: false };
      }
      if (!canCancelProduction(status)) {
        const error = new Error('Production cannot be cancelled from its current workflow status');
        error.status = 409;
        throw error;
      }

      let commitmentResult = {
        mutated: false,
        production_patch: {}
      };
      if (hasProductionInventoryCommitment(lockedProduction)) {
        const sites = await listDocuments('Site', { limit: 5000 }, client);
        const fulfillmentStore = resolveProductionFulfillmentStore(lockedProduction, sites);
        const [ingredients, inventory] = await Promise.all([
          listDocuments('Ingredient', { limit: 10000 }, client),
          listDocuments('Inventory', {
            filters: { site_id: fulfillmentStore.id },
            limit: 10000
          }, client)
        ]);
        commitmentResult = await releaseProductionInventoryCommitment({
          production: lockedProduction,
          actor: request.user,
          reason,
          operation: 'cancellation',
          siteCatalog: sites,
          ingredientCatalog: ingredients,
          inventoryCatalog: inventory,
          fulfillmentStore,
          targetServings: 0
        }, client);
      }

      let materialRequestMutated = false;
      if (lockedProduction.linked_material_request_id) {
        const materialRequest = await findDocument(
          'MaterialRequest',
          lockedProduction.linked_material_request_id,
          client,
          true
        );
        if (materialRequest && String(materialRequest.status || '').toLowerCase() !== 'cancelled') {
          await updateDocument('MaterialRequest', materialRequest.id, {
            status: 'cancelled',
            cancellation_reason: reason,
            cancelled_by: request.user.email,
            cancelled_by_name: request.user.full_name || request.user.email,
            cancelled_at: new Date().toISOString()
          }, client);
          materialRequestMutated = true;
        }
      }

      const cancelledAt = new Date().toISOString();
      const record = await updateDocument('Production', lockedProduction.id, {
        ...commitmentResult.production_patch,
        status: 'cancelled',
        cancellation_reason: reason,
        cancelled_by: request.user.email,
        cancelled_by_name: request.user.full_name || request.user.email,
        cancelled_at: cancelledAt,
        last_review_action: 'production_cancelled',
        approval_history: appendProductionApprovalHistory(lockedProduction, {
          action: 'production_cancelled',
          stage: status === 'approved' ? 'area_manager_inventory_reconciliation' : 'production_request',
          from_status: status,
          to_status: 'cancelled',
          actor_id: request.user.id || null,
          actor_email: request.user.email || null,
          actor_name: request.user.full_name || request.user.email || null,
          reason,
          note: commitmentResult.mutated
            ? 'Reserved inventory released back to its exact original lots.'
            : null,
          timestamp: cancelledAt
        })
      }, client);
      return {
        record,
        mutated: true,
        inventoryMutated: commitmentResult.mutated,
        materialRequestMutated
      };
    });

    if (result.mutated) {
      recordChanged('Production');
      if (result.materialRequestMutated) recordChanged('MaterialRequest');
      if (result.inventoryMutated) {
        recordChanged('Inventory');
        recordChanged('InventoryLot');
        recordChanged('InventoryTransaction');
      }
      await auditAction({
        user: request.user,
        action: 'PRODUCTION_CANCELLED_AND_INVENTORY_RELEASED',
        entity: 'Production',
        entityId: result.record.id,
        details: {
          reason,
          inventory_reservation_released: result.inventoryMutated,
          saved_record: result.record
        }
      });
    }
    response.json((await decorateEntityRecords('Production', [result.record]))[0]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/suppliers', requireAuth, async (_request, response, next) => {
  try {
    response.json(await listSuppliers());
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/suppliers', requireAuth, requirePermission('manage_suppliers'), async (request, response, next) => {
  try {
    response.status(201).json(await createSupplier(request.body || {}));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/procurement/suppliers/:id', requireAuth, requirePermission('manage_suppliers'), async (request, response, next) => {
  try {
    const updated = await updateSupplier(request.params.id, request.body || {});
    if (!updated) {
      return response.status(404).json({ message: 'Supplier not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/procurement/suppliers/:id', requireAuth, requirePermission('manage_suppliers'), async (request, response, next) => {
  try {
    const removed = await deleteSupplier(request.params.id);
    if (!removed) {
      return response.status(404).json({ message: 'Supplier not found' });
    }
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/requests', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listPurchaseRequests(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests', requireAuth, requirePermission('manage_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertProcurementRecordLocationAccess(request.body || {}, scope, 'Purchase request');
    assertPayloadLocationAccess(request.user, 'MaterialRequest', request.body || {}, scope);
    response.status(201).json(await createPurchaseRequest(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/auto-generate', requireAuth, requirePermission('manage_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertProcurementRecordLocationAccess(request.body || {}, scope, 'Purchase request');
    assertPayloadLocationAccess(request.user, 'MaterialRequest', request.body || {}, scope);
    response.status(201).json(await autoGeneratePurchaseRequestFromLowStock(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/:id/approve', requireAuth, requirePermission('approve_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const existing = await getPurchaseRequestById(request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    assertProcurementRecordLocationAccess(existing, scope, 'Purchase request');
    const updated = await approvePurchaseRequest(request.params.id, { ...(request.body || {}), status: 'approved' }, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/requests/:id/reject', requireAuth, requirePermission('approve_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const existing = await getPurchaseRequestById(request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    assertProcurementRecordLocationAccess(existing, scope, 'Purchase request');
    const updated = await approvePurchaseRequest(request.params.id, { ...(request.body || {}), status: 'rejected' }, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/orders', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listPurchaseOrders(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders', requireAuth, requirePermission('manage_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const linkedRequest = request.body?.request_id
      ? await getPurchaseRequestById(request.body.request_id)
      : null;
    if (request.body?.request_id && !linkedRequest) {
      return response.status(404).json({ message: 'Purchase request not found' });
    }
    assertProcurementRecordLocationAccess(linkedRequest || request.body || {}, scope, 'Purchase order');
    assertPayloadLocationAccess(
      request.user,
      'PurchaseOrder',
      linkedRequest || request.body || {},
      scope
    );
    response.status(201).json(await createPurchaseOrder(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders/:id/approve', requireAuth, requirePermission('approve_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const existing = await getPurchaseOrderById(request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    assertProcurementRecordLocationAccess(existing, scope, 'Purchase order');
    const updated = await approvePurchaseOrder(
      request.params.id,
      { ...(request.body || {}), status: 'approved' },
      request.user
    );
    if (!updated) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/orders/:id/cancel', requireAuth, requirePermission('approve_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const existing = await getPurchaseOrderById(request.params.id);
    if (!existing) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    assertProcurementRecordLocationAccess(existing, scope, 'Purchase order');
    const updated = await cancelPurchaseOrder(request.params.id, request.body || {}, request.user);
    if (!updated) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/receipts', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listGoodsReceipts(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/receipts', requireAuth, requirePermission('manage_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const purchaseOrder = request.body?.purchase_order_id
      ? await getPurchaseOrderById(request.body.purchase_order_id)
      : null;
    if (!purchaseOrder) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    assertProcurementRecordLocationAccess(purchaseOrder, scope, 'Purchase order');
    assertPayloadLocationAccess(request.user, 'PurchaseOrder', purchaseOrder, scope);
    response.status(201).json(await createGoodsReceipt(request.body || {}, request.user, scope));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/invoices', requireAuth, async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await listSupplierInvoices(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/procurement/invoices', requireAuth, requirePermission('manage_procurement'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const receipt = request.body?.goods_receipt_id
      ? await getGoodsReceiptById(request.body.goods_receipt_id)
      : null;
    if (request.body?.goods_receipt_id && !receipt) {
      return response.status(404).json({ message: 'Goods receipt not found' });
    }
    const purchaseOrderId = request.body?.purchase_order_id || receipt?.purchase_order_id;
    const purchaseOrder = purchaseOrderId
      ? await getPurchaseOrderById(purchaseOrderId)
      : null;
    if (purchaseOrderId && !purchaseOrder) {
      return response.status(404).json({ message: 'Purchase order not found' });
    }
    if (receipt) {
      assertProcurementRecordLocationAccess(receipt, scope, 'Goods receipt');
    }
    if (purchaseOrder) {
      assertProcurementRecordLocationAccess(purchaseOrder, scope, 'Purchase order');
    }
    if (!receipt && !purchaseOrder && !scope.unrestricted) {
      const error = new Error('A supplier invoice must reference a purchase order or goods receipt in your location scope');
      error.status = 403;
      throw error;
    }
    response.status(201).json(await createSupplierInvoice(request.body || {}, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/price-comparison', requireAuth, async (request, response, next) => {
  try {
    response.json(await listSupplierPriceComparison({
      ingredientId: request.query.ingredient_id,
      supplierId: request.query.supplier_id
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/procurement/performance', requireAuth, requireAnyPermission(['manage_procurement', 'approve_procurement']), async (_request, response, next) => {
  try {
    const scope = await getLocationScope(_request.user);
    response.json(filterRowsByAccessibleSites(await getSupplierPerformanceDashboard(), scope));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/receive', requireAuth, requirePermission('manage_inventory'), async (request, response, next) => {
  try {
    if (isBulkInventoryUpload(request.body || {})) {
      assertBulkUploadAdministrator(request.user);
    }
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'Inventory', request.body || {}, scope);
    response.status(201).json(await receiveStock({
      ...(request.body || {}),
      performed_by: request.user.email
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/adjust', requireAuth, requirePermission('manage_inventory'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const inventoryRecord = request.body?.inventory_id ? await findDocument('Inventory', request.body.inventory_id) : null;
    if (inventoryRecord) {
      assertPayloadLocationAccess(request.user, 'Inventory', inventoryRecord, scope);
    }
    response.json(await adjustStock({
      ...(request.body || {}),
      performed_by: request.user.email
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/inventory/transfer', requireAuth, requirePermission('transfer_inventory'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    assertPayloadLocationAccess(request.user, 'ProductionTransfer', request.body || {}, scope);
    response.json(await transferStock({
      ...(request.body || {}),
      performed_by: request.user.email
    }));
  } catch (error) {
    next(error);
  }
});

const STAFF_MEAL_QR_CATEGORY = 'staff_meal_employee';
const STAFF_MEAL_QR_WINDOWS = Object.freeze({
  breakfast: { label: 'Breakfast', start_time: '05:00', end_time: '07:00' },
  lunch: { label: 'Lunch', start_time: '11:00', end_time: '13:00' },
  dinner: { label: 'Dinner', start_time: '17:00', end_time: '20:00' }
});

function normalizeStaffMealQrText(value) {
  return String(value || '').trim();
}

function normalizeStaffMealQrPhone(value) {
  return normalizeStaffMealQrText(value).replace(/[^\d+]/g, '');
}

function normalizeStaffMealQrTime(value, fallback) {
  const candidate = normalizeStaffMealQrText(value);
  return /^\d{2}:\d{2}$/.test(candidate) ? candidate : fallback;
}

function normalizeStaffMealQrWindows(windows = {}) {
  return Object.fromEntries(Object.entries(STAFF_MEAL_QR_WINDOWS).map(([mealType, defaults]) => ([
    mealType,
    {
      ...defaults,
      start_time: normalizeStaffMealQrTime(windows?.[mealType]?.start_time, defaults.start_time),
      end_time: normalizeStaffMealQrTime(windows?.[mealType]?.end_time, defaults.end_time)
    }
  ])));
}

function currentStaffMealDateTime() {
  const now = new Date();
  const businessParts = toBusinessDateTimeParts(now) || {};
  const date = businessParts.date || now.toISOString().slice(0, 10);
  const time = businessParts.time || now.toISOString().slice(11, 16);
  return { now, date, time };
}

function getActiveStaffMealWindow(qr = {}, requestedMealType = '') {
  const mealType = normalizeStaffMealQrText(requestedMealType).toLowerCase();
  const window = qr.meal_windows?.[mealType];
  if (!window || !STAFF_MEAL_QR_WINDOWS[mealType]) {
    const error = new Error('Select a valid meal period');
    error.status = 400;
    throw error;
  }
  const { date, time } = currentStaffMealDateTime();
  if (time < window.start_time || time > window.end_time) {
    const error = new Error(`${window.label || mealType} QR scanning is allowed only from ${window.start_time} to ${window.end_time}`);
    error.status = 409;
    throw error;
  }
  return { mealType, date, window };
}

function normalizeStaffMealQrScanScope(body = {}, fallbackDate = currentStaffMealDateTime().date) {
  const mealType = normalizeStaffMealQrText(body.meal_type || body.meal_period).toLowerCase();
  if (!STAFF_MEAL_QR_WINDOWS[mealType]) {
    const error = new Error('Select a valid meal period');
    error.status = 400;
    throw error;
  }
  const serviceDate = normalizeStaffMealQrText(body.service_date || body.date) || fallbackDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    const error = new Error('Select a valid service date');
    error.status = 400;
    throw error;
  }
  const siteId = normalizeStaffMealQrText(body.site_id);
  if (!siteId) {
    const error = new Error('Select a project before scanning');
    error.status = 400;
    throw error;
  }
  return {
    serviceDate,
    siteId,
    menuType: normalizeStaffMealQrText(body.menu_type) || 'general',
    menuCategory: normalizeStaffMealQrText(body.menu_category) || 'senior',
    mealType
  };
}

function assertStaffMealQrIsScannable(qr = {}, mealType) {
  if (String(qr.status || '').toLowerCase() !== 'active') {
    const error = new Error('This employee QR code is inactive');
    error.status = 409;
    throw error;
  }
  const window = qr.meal_windows?.[mealType] || STAFF_MEAL_QR_WINDOWS[mealType];
  if (!window || !STAFF_MEAL_QR_WINDOWS[mealType]) {
    const error = new Error('Select a valid meal period');
    error.status = 400;
    throw error;
  }
  const { time } = currentStaffMealDateTime();
  if (time < window.start_time || time > window.end_time) {
    const error = new Error(`${window.label || mealType} QR scanning is allowed only from ${window.start_time} to ${window.end_time}`);
    error.status = 409;
    throw error;
  }
  return window;
}

async function recordStaffMealQrScan(qr, scanScope, { user = null } = {}) {
  const { serviceDate, siteId, menuType, menuCategory, mealType } = scanScope;
  const window = assertStaffMealQrIsScannable(qr, mealType);
  const scanKey = `${serviceDate}:${mealType}`;
  const scanHistory = Array.isArray(qr.scan_history) ? qr.scan_history : [];
  if (scanHistory.some((scan) => scan.scan_key === scanKey)) {
    const error = new Error(`${window.label || mealType} has already been scanned for ${serviceDate}`);
    error.status = 409;
    throw error;
  }
  const markedAt = new Date().toISOString();
  const attendance = await createDocument('AttendanceRecord', {
    session_id: `STAFF-MEAL-QR-${qr.id}-${siteId}`,
    session_name: `Staff Meal QR - ${qr.employee_name}`,
    session_date: serviceDate,
    service_date: serviceDate,
    site_id: siteId,
    menu_type: menuType,
    menu_category: menuCategory,
    meal_type: mealType,
    attendee_id: qr.company_id_number,
    attendee_name: qr.employee_name,
    attendee_phone: qr.mobile_number,
    category: 'employee',
    marked_at: markedAt,
    scan_method: 'employee_meal_qr',
    qr_code_id: qr.id,
    scanned_by: user?.email || null,
    scanned_by_name: user?.full_name || user?.email || null,
    status: 'checked_in',
    approval_status: 'approved',
    attendance_status: 'present'
  });
  const updatedHistory = [
    {
      scan_key: scanKey,
      attendance_record_id: attendance.id,
      meal_type: mealType,
      session_date: serviceDate,
      site_id: siteId,
      menu_type: menuType,
      menu_category: menuCategory,
      scanned_at: markedAt,
      scanned_by: user?.email || null
    },
    ...scanHistory
  ];
  const updatedQr = await updateDocument('QRCode', qr.id, { scan_history: updatedHistory, last_scanned_at: markedAt });
  recordChanged('QRCode');
  recordChanged('AttendanceRecord');
  return {
    message: `${window.label || mealType} attendance recorded`,
    attendance,
    qr: staffMealQrPublicPayload(updatedQr)
  };
}

function staffMealQrPublicPayload(qr = {}) {
  return {
    id: qr.id,
    employee_name: qr.employee_name,
    company_id_number: qr.company_id_number,
    mobile_number: qr.mobile_number,
    meal_windows: qr.meal_windows || STAFF_MEAL_QR_WINDOWS,
    status: qr.status,
    scan_history: qr.scan_history || []
  };
}

async function findStaffMealQrByToken(token) {
  const normalizedToken = normalizeStaffMealQrText(token);
  if (!normalizedToken) return null;
  const matches = await listDocuments('QRCode', {
    filters: { token: normalizedToken, category: STAFF_MEAL_QR_CATEGORY },
    limit: 1
  });
  return matches[0] || null;
}

app.get('/api/staff-meal-qr', requireAuth, requirePermission('create_employee_meal_qr'), async (_request, response, next) => {
  try {
    const codes = await listDocuments('QRCode', {
      filters: { category: STAFF_MEAL_QR_CATEGORY },
      sort: '-created_date',
      limit: 500
    });
    response.json(codes);
  } catch (error) {
    next(error);
  }
});

app.post('/api/staff-meal-qr', requireAuth, requirePermission('create_employee_meal_qr'), async (request, response, next) => {
  try {
    const employeeName = normalizeStaffMealQrText(request.body?.employee_name || request.body?.name);
    const companyIdNumber = normalizeStaffMealQrText(request.body?.company_id_number);
    const mobileNumber = normalizeStaffMealQrPhone(request.body?.mobile_number);
    if (!employeeName) return response.status(400).json({ message: 'Employee name is required' });
    if (!companyIdNumber) return response.status(400).json({ message: 'Company ID number is required' });
    if (!mobileNumber) return response.status(400).json({ message: 'Active WhatsApp mobile number is required' });
    const token = `staff-meal-${randomUUID()}`;
    const record = await createDocument('QRCode', {
      category: STAFF_MEAL_QR_CATEGORY,
      name: employeeName,
      employee_name: employeeName,
      company_id_number: companyIdNumber,
      mobile_number: mobileNumber,
      active_whatsapp: true,
      token,
      meal_windows: normalizeStaffMealQrWindows(request.body?.meal_windows),
      scan_history: [],
      status: 'active',
      created_by: request.user.email,
      created_by_name: request.user.full_name || request.user.email
    });
    recordChanged('QRCode');
    await auditAction({
      user: request.user,
      action: 'STAFF_MEAL_QR_CREATED',
      entity: 'QRCode',
      entityId: record.id,
      details: { employee_name: employeeName, company_id_number: companyIdNumber }
    });
    response.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/staff-meal-qr/:id', requireAuth, requirePermission('create_employee_meal_qr'), async (request, response, next) => {
  try {
    const existing = await findDocument('QRCode', request.params.id);
    if (!existing || existing.category !== STAFF_MEAL_QR_CATEGORY) {
      return response.status(404).json({ message: 'Employee QR code not found' });
    }
    const employeeName = normalizeStaffMealQrText(request.body?.employee_name || request.body?.name);
    const companyIdNumber = normalizeStaffMealQrText(request.body?.company_id_number);
    const mobileNumber = normalizeStaffMealQrPhone(request.body?.mobile_number);
    if (!employeeName) return response.status(400).json({ message: 'Employee name is required' });
    if (!companyIdNumber) return response.status(400).json({ message: 'Company ID number is required' });
    if (!mobileNumber) return response.status(400).json({ message: 'Active WhatsApp mobile number is required' });
    const record = await updateDocument('QRCode', existing.id, {
      name: employeeName,
      employee_name: employeeName,
      company_id_number: companyIdNumber,
      mobile_number: mobileNumber,
      active_whatsapp: true,
      meal_windows: normalizeStaffMealQrWindows(request.body?.meal_windows),
      updated_by: request.user.email,
      updated_by_name: request.user.full_name || request.user.email
    });
    recordChanged('QRCode');
    await auditAction({
      user: request.user,
      action: 'STAFF_MEAL_QR_UPDATED',
      entity: 'QRCode',
      entityId: record.id,
      details: { employee_name: employeeName, company_id_number: companyIdNumber }
    });
    response.json(record);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/staff-meal-qr/:id', requireAuth, requirePermission('create_employee_meal_qr'), async (request, response, next) => {
  try {
    const existing = await findDocument('QRCode', request.params.id);
    if (!existing || existing.category !== STAFF_MEAL_QR_CATEGORY) {
      return response.status(404).json({ message: 'Employee QR code not found' });
    }
    await deleteDocument('QRCode', existing.id);
    recordChanged('QRCode');
    await auditAction({
      user: request.user,
      action: 'STAFF_MEAL_QR_DELETED',
      entity: 'QRCode',
      entityId: existing.id,
      details: { employee_name: existing.employee_name, company_id_number: existing.company_id_number }
    });
    response.json({ id: existing.id, deleted: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/staff-meal-qr/scan', requireAuth, requireAnyPermission([
  'record_customer_meal_service',
  'generate_staff_meal_qr',
  'create_employee_meal_qr'
]), async (request, response, next) => {
  try {
    const qr = await findStaffMealQrByToken(request.body?.token);
    if (!qr) return response.status(404).json({ message: 'QR code not found' });
    const scanScope = normalizeStaffMealQrScanScope(request.body);
    const scope = await getLocationScope(request.user);
    if (!scope.unrestricted && !scope.accessibleSiteIds.has(scanScope.siteId)) {
      return response.status(403).json({ message: 'You do not have access to this Meal Service location' });
    }
    const result = await recordStaffMealQrScan(qr, scanScope, { user: request.user });
    await auditAction({
      user: request.user,
      action: 'STAFF_MEAL_QR_SCANNED',
      entity: 'AttendanceRecord',
      entityId: result.attendance.id,
      details: {
        employee_name: qr.employee_name,
        company_id_number: qr.company_id_number,
        service_date: scanScope.serviceDate,
        site_id: scanScope.siteId,
        menu_type: scanScope.menuType,
        menu_category: scanScope.menuCategory,
        meal_type: scanScope.mealType
      }
    });
    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/staff-meal-qr/public/:token', async (request, response, next) => {
  try {
    const qr = await findStaffMealQrByToken(request.params.token);
    if (!qr) return response.status(404).json({ message: 'QR code not found' });
    response.json(staffMealQrPublicPayload(qr));
  } catch (error) {
    next(error);
  }
});

app.post('/api/staff-meal-qr/public/:token/scan', async (request, response, next) => {
  try {
    const qr = await findStaffMealQrByToken(request.params.token);
    if (!qr) return response.status(404).json({ message: 'QR code not found' });
    const { mealType, date } = getActiveStaffMealWindow(qr, request.body?.meal_type);
    const result = await recordStaffMealQrScan(qr, {
      serviceDate: date,
      siteId: normalizeStaffMealQrText(request.body?.site_id) || 'self-service',
      menuType: normalizeStaffMealQrText(request.body?.menu_type) || 'general',
      menuCategory: normalizeStaffMealQrText(request.body?.menu_category) || 'senior',
      mealType
    });
    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/meal-service/availability', requireAuth, requireAnyPermission([
  'view_customer_meal_service',
  'record_customer_meal_service',
  'generate_staff_meal_qr'
]), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const siteId = String(request.query.site_id || '').trim();
    if (!siteId) return response.status(400).json({ message: 'Select a location for produced-item availability' });
    if (!scope.unrestricted && !scope.accessibleSiteIds.has(siteId)) {
      return response.status(403).json({ message: 'You do not have access to this Meal Service location' });
    }
    const location = scope.unrestricted
      ? null
      : { unrestricted: false, accessibleSiteIds: [...scope.accessibleSiteIds] };
    return response.json(await getProducedItemAvailability(request.query, { location }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/meal-service/preview', requireAuth, requireAnyPermission([
  'view_customer_meal_service',
  'record_customer_meal_service',
  'generate_staff_meal_qr'
]), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const siteId = String(request.body?.site_id || '').trim();
    if (!siteId || (!scope.unrestricted && !scope.accessibleSiteIds.has(siteId))) {
      return response.status(siteId ? 403 : 400).json({
        message: siteId
          ? 'You do not have access to this Meal Service location'
          : 'Select a location for Meal Service'
      });
    }
    const location = scope.unrestricted
      ? null
      : { unrestricted: false, accessibleSiteIds: [...scope.accessibleSiteIds] };
    return response.json(await previewMealService(request.body || {}, { location }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/meal-service/portion-size', requireAuth, async (request, response, next) => {
  try {
    if (!hasAdminAccess(request.user)) {
      return response.status(403).json({ message: 'Only administrators can change meal-service portion sizes' });
    }
    const scope = await getLocationScope(request.user);
    const siteId = String(request.body?.site_id || '').trim();
    if (!siteId || (!scope.unrestricted && !scope.accessibleSiteIds.has(siteId))) {
      return response.status(siteId ? 403 : 400).json({
        message: siteId ? 'You do not have access to this location' : 'Select a location'
      });
    }
    const location = scope.unrestricted
      ? null
      : { unrestricted: false, accessibleSiteIds: [...scope.accessibleSiteIds] };
    const result = await updateMealServicePortionSize(request.body || {}, request.user, { location });
    recordChanged('ProducedItemBatch');
    await auditAction({
      user: request.user,
      action: 'MEAL_SERVICE_PORTION_SIZE_UPDATED',
      entity: 'ProducedItemBatch',
      entityId: result.updated_batch_ids[0] || null,
      details: result
    });
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/meal-service/attendance', requireAuth, requirePermission('record_customer_meal_service'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const siteId = String(request.body?.site_id || '').trim();
    if (!siteId || (!scope.unrestricted && !scope.accessibleSiteIds.has(siteId))) {
      return response.status(siteId ? 403 : 400).json({
        message: siteId
          ? 'You do not have access to this Meal Service location'
          : 'Select a location for Meal Service'
      });
    }
    const location = scope.unrestricted
      ? null
      : { unrestricted: false, accessibleSiteIds: [...scope.accessibleSiteIds] };
    const result = await recordMealServiceAttendance(request.body || {}, request.user, { location });
    if (!result.replayed) {
      recordChanged('ProducedItemBatch');
      recordChanged('MealServiceAttendance');
      recordChanged('MealServiceConsumption');
      if ((result.waste_records || []).length) recordChanged('FoodWaste');
      await auditAction({
        user: request.user,
        action: 'MEAL_SERVICE_SAVED',
        entity: 'MealServiceAttendance',
        entityId: result.attendance.id,
        details: {
          service_reference: result.attendance.service_reference,
          attendee_count: result.attendance.attendee_count,
          menu_plan_id: result.attendance.menu_plan_id,
          menu_type: result.attendance.menu_type,
          menu_category: result.attendance.menu_category,
          dishes: (result.attendance.items || []).map((item) => ({
            recipe_id: item.recipe_id,
            prepared_meal_name: item.recipe_name,
            service_portion_size_grams: item.portion_size_grams,
            covers: item.covers
          })),
          waste_record_ids: (result.waste_records || []).map((record) => record.id),
          summary: result.summary,
          idempotency_key: result.attendance.idempotency_key
        }
      });
    }
    return response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/meal-service/attendance/:id/reverse', requireAuth, requirePermission('record_customer_meal_service'), async (request, response, next) => {
  try {
    if (!hasAdminAccess(request.user)) {
      return response.status(403).json({ message: 'Only administrators can reverse a saved Meal Service request' });
    }
    const scope = await getLocationScope(request.user);
    const attendance = await findDocument('MealServiceAttendance', request.params.id);
    if (!attendance) return response.status(404).json({ message: 'Meal Service record not found' });
    if (!scope.unrestricted && !scope.accessibleSiteIds.has(String(attendance.site_id || ''))) {
      return response.status(403).json({ message: 'You do not have access to this Meal Service record' });
    }
    const location = scope.unrestricted
      ? null
      : { unrestricted: false, accessibleSiteIds: [...scope.accessibleSiteIds] };
    const result = await reverseMealServiceAttendance(
      request.params.id,
      request.body || {},
      request.user,
      { location }
    );
    if (!result.replayed) {
      recordChanged('ProducedItemBatch');
      recordChanged('MealServiceAttendance');
      recordChanged('MealServiceConsumption');
      recordChanged('FoodWaste');
      await auditAction({
        user: request.user,
        action: 'MEAL_SERVICE_REVERSED',
        entity: 'MealServiceAttendance',
        entityId: result.attendance.id,
        details: {
          service_reference: result.attendance.service_reference,
          reason: result.attendance.reversal_reason,
          reversal_idempotency_key: result.attendance.reversal_idempotency_key
        }
      });
    }
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/meal-service/report', requireAuth, requireAnyPermission([
  'view_customer_meal_service',
  'record_customer_meal_service',
  'generate_staff_meal_qr'
]), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const siteId = String(request.query.site_id || '').trim();
    if (siteId && !scope.unrestricted && !scope.accessibleSiteIds.has(siteId)) {
      return response.status(403).json({ message: 'You do not have access to this Meal Service location' });
    }
    const location = scope.unrestricted
      ? null
      : { unrestricted: false, accessibleSiteIds: [...scope.accessibleSiteIds] };
    return response.json(await getMealServiceReport(request.query, { location }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/inventory/production/:id/repair-menu-classification', requireAuth, async (request, response, next) => {
  try {
    if (!hasAdminAccess(request.user)) {
      return response.status(403).json({ message: 'Only administrators can repair legacy production menu classification' });
    }
    const menuPlanId = String(request.body?.menu_plan_id || '').trim();
    if (!menuPlanId) return response.status(400).json({ message: 'Select the exact menu plan for this legacy production' });
    const repairedAt = new Date().toISOString();
    const result = await withTransaction(async (client) => {
      const production = await findDocument('Production', request.params.id, client, true);
      if (!production) {
        const error = new Error('Production record not found');
        error.status = 404;
        throw error;
      }
      const scope = await getLocationScope(request.user);
      if (!scope.unrestricted && !scope.accessibleSiteIds.has(String(production.site_id || ''))) {
        const error = new Error('You do not have access to this production record');
        error.status = 403;
        throw error;
      }
      const plan = await findDocument('MenuPlan', menuPlanId, client, true);
      if (!plan) {
        const error = new Error('Menu plan not found');
        error.status = 404;
        throw error;
      }
      const classification = resolveLegacyProductionMenuClassification(production, plan);
      return updateDocument('Production', production.id, {
        ...classification,
        legacy_menu_classification_repaired: true,
        legacy_menu_classification_repaired_by: request.user.email || null,
        legacy_menu_classification_repaired_by_name: request.user.full_name || request.user.email || null,
        legacy_menu_classification_repaired_at: repairedAt
      }, client);
    });
    recordChanged('Production');
    await auditAction({
      user: request.user,
      action: 'LEGACY_PRODUCTION_MENU_CLASSIFICATION_REPAIRED',
      entity: 'Production',
      entityId: result.id,
      details: { saved_record: result, menu_plan_id: menuPlanId }
    });
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/inventory/production/:id/complete', requireAuth, requirePermission('complete_production'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const production = await findDocument('Production', request.params.id);
    if (!production || !filterRowsByAccessibleSites(
      [production],
      scope,
      ['site_id', 'fulfillment_store_id']
    ).length) {
      return response.status(403).json({ message: 'You do not have access to this production record' });
    }
    const requestedFulfillmentStoreId = String(request.body?.fulfillment_store_id || '').trim();
    const productionInventorySite = resolveProductionFulfillmentStore({
      ...production,
      fulfillment_store_id: production.fulfillment_store_id || requestedFulfillmentStoreId
    }, scope.sites);
    if (
      !scope.unrestricted
      && !scope.accessibleSiteIds.has(String(productionInventorySite.id))
    ) {
      return response.status(403).json({ message: 'You do not have access to this production site inventory' });
    }
    if (requestedFulfillmentStoreId && requestedFulfillmentStoreId !== String(productionInventorySite.id)) {
      return response.status(409).json({ message: 'The production inventory location cannot be changed at completion' });
    }
    // Resolve inventory from the production location, including legacy records.
    // Raw reconciliation and finished yield are recalculated server-side.
    const result = await completeProduction(request.params.id, request.user, {
      fulfillment_store_id: productionInventorySite.id
    });
    if (result.mutated) {
      recordChanged('Production');
      recordChanged('ProductionConsumptionReport');
      recordChanged('Inventory');
      recordChanged('InventoryLot');
      recordChanged('InventoryTransaction');
      recordChanged('ProducedItemBatch');
      await auditAction({
        user: request.user,
        action: 'PRODUCTION_CONSUMPTION_POSTED',
        entity: 'Production',
        entityId: result.record.id,
        details: {
          saved_record: result.record,
          consumption_report_id: result.record.consumption_report_id,
          consumption_report_number: result.record.consumption_report_number,
          produced_item_batch_id: result.produced_item_batch?.id || result.record.produced_item_batch_id
        }
      });
    }
    response.json({
      ...result.record,
      produced_item_batch: result.produced_item_batch || null
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/lots', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'InventoryLot');
    const lots = await listInventoryLots({
      siteId: request.query.site_id,
      ingredientId: request.query.ingredient_id,
      includeEmpty: request.query.include_empty === 'true',
      location
    });
    response.json(scope ? filterRowsByAccessibleSites(lots, scope) : lots);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/stock-on-hand', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'Inventory');
    const report = await getStockOnHandReport({ location });
    response.json(scope ? filterRowsByAccessibleSites(report, scope) : report);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/movements', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'InventoryTransaction');
    const report = await getStockMovementReport({
      siteId: request.query.site_id,
      ingredientId: request.query.ingredient_id,
      dateFrom: request.query.date_from,
      dateTo: request.query.date_to,
      location
    });
    response.json(scope ? filterRowsByAccessibleSites(report, scope) : report);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/expiry', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'InventoryLot');
    const report = await getExpiryReport({
      thresholdDays: request.query.threshold_days ? Number(request.query.threshold_days) : 30,
      location
    });
    response.json(scope ? filterRowsByAccessibleSites(report, scope) : report);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/velocity', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'InventoryTransaction');
    const report = await getVelocityReports({
      days: request.query.days ? Number(request.query.days) : 30,
      location
    });
    response.json({
      fast_moving: scope
        ? filterRowsByAccessibleSites(report.fast_moving || [], scope)
        : report.fast_moving || [],
      slow_moving: scope
        ? filterRowsByAccessibleSites(report.slow_moving || [], scope)
        : report.slow_moving || []
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/valuation', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'Inventory');
    const report = await getInventoryValuationReport({
      siteId: request.query.site_id,
      ingredientId: request.query.ingredient_id,
      location
    });
    response.json(scope ? filterRowsByAccessibleSites(report, scope) : report);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory/reports/value-history', requireAuth, requireAnyPermission(['view_inventory', 'manage_inventory']), async (request, response, next) => {
  try {
    const { scope, location } = await getEntityLocationContext(request.user, 'Inventory');
    const reportRows = await getInventoryValueHistoryReport({
      siteId: request.query.site_id,
      ingredientId: request.query.ingredient_id,
      dateFrom: request.query.date_from,
      dateTo: request.query.date_to,
      location
    });
    const rows = scope ? filterRowsByAccessibleSites(reportRows, scope) : reportRows;
    response.json({
      rows,
      date_from: request.query.date_from || null,
      date_to: request.query.date_to || null,
      summary: rows.reduce((summary, row) => ({
        opening_value: summary.opening_value + Number(row.opening_value || 0),
        closing_value: summary.closing_value + Number(row.closing_value || 0),
        addition_quantity: summary.addition_quantity + Number(row.addition_quantity || 0),
        addition_value: summary.addition_value + Number(row.addition_value || 0),
        consumption_quantity: summary.consumption_quantity + Number(row.consumption_quantity || 0),
        consumption_value: summary.consumption_value + Number(row.consumption_value || 0),
        return_quantity: summary.return_quantity + Number(row.return_quantity || 0),
        return_value: summary.return_value + Number(row.return_value || 0),
        correction_quantity: summary.correction_quantity + Number(row.correction_quantity || 0),
        correction_value: summary.correction_value + Number(row.correction_value || 0),
        valuation_reallocation_value: summary.valuation_reallocation_value
          + Number(row.valuation_reallocation_value || 0)
      }), {
        opening_value: 0,
        closing_value: 0,
        addition_quantity: 0,
        addition_value: 0,
        consumption_quantity: 0,
        consumption_value: 0,
        return_quantity: 0,
        return_value: 0,
        correction_quantity: 0,
        correction_value: 0,
        valuation_reallocation_value: 0
      })
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/erp/export', requireAuth, requirePermission('manage_erp'), async (request, response, next) => {
  try {
    response.json(await exportToErp({
      user: request.user,
      configId: request.body?.config_id || null,
      moduleKey: request.body?.module_key,
      transport: request.body?.transport || 'csv',
      startDate: request.body?.start_date || '',
      endDate: request.body?.end_date || '',
      locationId: request.body?.location_id || '',
      category: request.body?.category || ''
    }));
  } catch (error) {
    next(error);
  }
});

async function buildD365InventoryImportRequest(request, { dryRun = false } = {}) {
  const body = request.body || {};
  const scope = await getLocationScope(request.user);
  const directRecords = Array.isArray(body.records) ? body.records : [];
  const isBoundPreview = Boolean(body.preview_fingerprint);
  let pulled = null;
  let requestedWarehouseId = String(body.warehouse_id || '').trim();

  if (isBoundPreview && directRecords.length === 0) {
    const error = new Error('Preview-bound inventory import records are required');
    error.status = 409;
    throw error;
  }

  if (directRecords.length === 0) {
    const locationId = String(body.location_id || '').trim();
    const sites = await listDocuments('Site', { limit: 10000 });
    const authorizedStore = resolveAuthorizedD365PullStore(sites, {
      location_id: locationId,
      warehouse_id: requestedWarehouseId,
      scope
    });
    requestedWarehouseId = authorizedStore.warehouse_id;
    pulled = await pullD365InventoryRecords({
      configId: body.config_id || null,
      mode: body.quantity_semantics || body.sync_mode || 'snapshot',
      warehouse_id: requestedWarehouseId,
      start_date: body.start_date || body.stock_date || '',
      end_date: body.end_date || '',
      sync_id: body.sync_id || ''
    });
  }

  const inputRecords = directRecords.length > 0 ? directRecords : pulled?.records || [];
  if (requestedWarehouseId) {
    inputRecords.forEach((record, index) => {
      const rowWarehouseId = extractD365WarehouseId(record);
      if (pulled && (!rowWarehouseId || rowWarehouseId.toLowerCase() !== requestedWarehouseId.toLowerCase())) {
        const error = new Error(
          `D365 inventory pull returned row ${index + 1} outside the selected Store; no rows were imported`
        );
        error.status = 409;
        throw error;
      }
      if (!pulled && rowWarehouseId && rowWarehouseId.toLowerCase() !== requestedWarehouseId.toLowerCase()) {
        const error = new Error(
          `D365 row ${index + 1} warehouse ${rowWarehouseId} does not match selected warehouse ${requestedWarehouseId}`
        );
        error.status = 409;
        throw error;
      }
    });
  }
  const records = isBoundPreview
    ? inputRecords.map((record) => ({ ...(record || {}) }))
    : inputRecords.map((record) => ({
      ...(requestedWarehouseId ? { warehouse_id: requestedWarehouseId } : {}),
      ...(body.batch_number ? { batch_number: body.batch_number } : {}),
      ...(body.stock_date ? { stock_date: body.stock_date } : {}),
      ...(body.expiry_date ? { expiry_date: body.expiry_date } : {}),
      ...(body.unit_cost !== undefined && body.unit_cost !== '' && body.unit_cost !== null
        ? { unit_cost: body.unit_cost }
        : {}),
      ...(record || {})
    }));

  const payload = {
    ...(pulled || {}),
    ...body,
    records,
    sync_id: body.sync_id || pulled?.sync_id || '',
    source_system: body.source_system || pulled?.source_system || 'd365',
    quantity_semantics: body.quantity_semantics
      || body.sync_mode
      || pulled?.quantity_semantics
      || 'snapshot',
    received_at: body.received_at || pulled?.received_at || new Date().toISOString(),
    config_id: body.config_id || pulled?.config_id || null,
    user: request.user,
    scope,
    dry_run: dryRun
  };
  if (isBoundPreview) {
    const actualFingerprint = stableD365Hash({
      records: payload.records,
      sync_id: payload.sync_id,
      source_system: payload.source_system,
      quantity_semantics: payload.quantity_semantics,
      received_at: payload.received_at,
      config_id: payload.config_id,
      warehouse_id: requestedWarehouseId,
      notes: String(payload.notes || '').trim()
    });
    if (actualFingerprint !== body.preview_fingerprint) {
      const error = new Error('The D365 inventory preview payload changed. Pull a new preview before applying.');
      error.status = 409;
      throw error;
    }
  }
  return payload;
}

app.post(
  '/api/erp/import/inventory/preview',
  requireAuth,
  requirePermission('manage_erp'),
  requirePermission('manage_inventory'),
  async (request, response, next) => {
    try {
      const payload = await buildD365InventoryImportRequest(request, { dryRun: true });
      const result = await previewD365InventoryImport(payload);
      const importPayload = {
        records: payload.records,
        sync_id: payload.sync_id,
        source_system: payload.source_system,
        quantity_semantics: payload.quantity_semantics,
        received_at: payload.received_at,
        config_id: payload.config_id,
        warehouse_id: String(request.body?.warehouse_id || '').trim(),
        notes: String(payload.notes || '').trim()
      };
      const previewFingerprint = stableD365Hash(importPayload);
      response.json({
        ...result,
        import_payload: {
          ...importPayload,
          preview_fingerprint: previewFingerprint
        },
        preview_fingerprint: previewFingerprint
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/erp/import/inventory',
  requireAuth,
  requirePermission('manage_erp'),
  requirePermission('manage_inventory'),
  async (request, response, next) => {
    try {
      const payload = await buildD365InventoryImportRequest(request);
      const result = await importD365Inventory(payload);
      recordChanged('ERPIntegrationLog');
      if (Number(result.summary?.applied_rows || 0) > 0) {
        recordChanged('Inventory');
        recordChanged('InventoryLot');
        recordChanged('InventoryTransaction');
      }
      await auditAction({
        user: request.user,
        action: 'D365_INVENTORY_IMPORTED',
        entity: 'ERPIntegrationLog',
        entityId: result.log?.id || null,
        details: {
          sync_id: payload.sync_id,
          quantity_semantics: payload.quantity_semantics,
          summary: result.summary
        }
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/erp/import/ingredients',
  requireAuth,
  requirePermission('manage_erp'),
  requirePermission('manage_ingredients'),
  async (request, response, next) => {
    try {
      const scope = await getLocationScope(request.user);
      if (!scope.unrestricted) {
        const error = new Error('D365 ingredient master imports require unrestricted location access');
        error.status = 403;
        throw error;
      }
      const result = await importD365Ingredients({
        ...(request.body || {}),
        user: request.user,
        scope
      });
      recordChanged('ERPIntegrationLog');
      if (Number(result.summary?.applied_rows || 0) > 0) recordChanged('Ingredient');
      await auditAction({
        user: request.user,
        action: 'D365_INGREDIENTS_IMPORTED',
        entity: 'ERPIntegrationLog',
        entityId: result.log?.id || null,
        details: {
          sync_id: request.body?.sync_id || null,
          summary: result.summary
        }
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.get('/api/erp/logs', requireAuth, requirePermission('manage_erp'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(await listErpLogs(scope));
  } catch (error) {
    next(error);
  }
});

app.get('/api/erp/logs/:id/rows', requireAuth, requirePermission('manage_erp'), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(await getD365ImportLogDetails(request.params.id, {
      scope,
      page: request.query.page,
      limit: request.query.limit,
      status: request.query.status || ''
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/erp/logs/:id/retry', requireAuth, requirePermission('manage_erp'), async (request, response, next) => {
  try {
    response.json(await retryErpSync(request.params.id, request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/forecasting/summary', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    const requestedLocation = request.query.location_id || null;
    const locationId = request.user.role === 'admin'
      ? requestedLocation
      : (requestedLocation
        ? (scope.accessibleSiteIds.has(String(requestedLocation)) ? requestedLocation : ([...scope.accessibleSiteIds][0] || null))
        : null);

    response.json(await buildForecastSummary({
      startDate: request.query.start_date || '',
      endDate: request.query.end_date || '',
      locationId,
      accessibleSiteIds: request.user.role === 'admin' ? null : scope.accessibleSiteIds,
      category: request.query.category || 'all',
      status: request.query.status || 'all',
      horizonDays: request.query.horizon_days ? Number(request.query.horizon_days) : 7,
      safetyBufferPercent: request.query.safety_buffer_percent ? Number(request.query.safety_buffer_percent) : 10
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/forecasting/scenarios/:id/run', requireAuth, requireRole(['admin', 'manager']), async (request, response, next) => {
  try {
    const scope = await getLocationScope(request.user);
    response.json(await runForecastScenario({
      scenarioId: request.params.id,
      user: request.user,
      locationScope: scope
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/health/live', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/health/ready', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    return response.json({ status: 'ready' });
  } catch (error) {
    return response.status(503).json({ status: 'not_ready', message: error.message });
  }
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/') || request.path.startsWith('/uploads/')) {
      return next();
    }
    return response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  const payload = { message: error.message || 'Internal server error' };
  if (error.code) payload.code = error.code;
  if (typeof error.details !== 'undefined') payload.details = error.details;
  response.status(Number(error.status) || 500).json(payload);
});

await initDatabaseWithRetry();
const stopCacheInvalidationListener = await subscribeToEntityEvents((event) => {
  if (!event?.entity) return;
  invalidateEntityDataCaches(event.entity);
  invalidateEntityAccessCaches(event.entity);
});
await resumeBulkUploadQueue();

const httpServer = app.listen(port, host, () => {
  console.log(`FoodPro server listening on ${host}:${port}`);
});

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`${signal} received; stopping FoodPro gracefully.`);
  const forceExit = setTimeout(() => process.exit(1), 30000);
  forceExit.unref?.();
  const serverClosed = new Promise((resolve) => httpServer.close(resolve));
  activeEventResponses.forEach((response) => response.end());
  activeEventResponses.clear();
  await serverClosed;
  await stopBulkUploadQueue();
  stopCacheInvalidationListener();
  await closeRealtime();
  await pool.end();
  clearTimeout(forceExit);
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
