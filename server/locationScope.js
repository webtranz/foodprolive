import { listDocuments } from './db.js';
import { hasAdminAccess } from './accessControl.js';
import {
  getRoleLocationPolicy,
  hasAllAreaAccess,
  isRolePrimarySiteType,
  normalizeRoleLocationFields
} from '../shared/roleLocationPolicy.js';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../shared/siteHierarchy.js';

const LOCATION_SCOPED_ENTITIES = new Set([
  'Inventory',
  'InventoryLot',
  'InventoryTransaction',
  'Production',
  'ProductionConsumptionReport',
  'ProductionBatch',
  'ProductionTransfer',
  'Budget',
  'MenuPlan',
  'MenuPlanPRSchedule',
  'MenuPlanPRRun',
  'FoodWaste',
  'MaterialRequest',
  'PurchaseOrder',
  'Supplier',
  'QualityControl',
  'AttendanceSession',
  'AttendanceRecord',
  'StaffShift',
  'CustomerMealPlan',
  'DinerScan',
  'ProducedItemBatch',
  'MealServiceAttendance',
  'MealServiceConsumption',
  'BranchOrder',
  'Recipe',
  'AdvancedReportSchedule',
  'ERPIntegrationLog',
  'ForecastScenario',
  'ForecastSnapshot',
  'WasteTarget',
  'User',
  'Site'
]);
const siteScopeCacheTtlMs = Math.max(0, Number(process.env.SITE_SCOPE_CACHE_TTL_MS || 10000));
let siteCatalogCache = null;
let siteCatalogPromise = null;
let siteCatalogGeneration = 0;

function normalizeArray(value) {
  return Array.isArray(value)
    ? value.filter(Boolean).map((item) => String(item))
    : [];
}

function createSiteGraph(sites = []) {
  const byId = new Map(sites.map((site) => [site.id, site]));
  const children = new Map();

  sites.forEach((site) => {
    const parentId = site.parent_site_id || null;
    if (!children.has(parentId)) {
      children.set(parentId, []);
    }
    children.get(parentId).push(site);
  });

  return { byId, children };
}

function collectDescendantIds(rootIds = [], graph) {
  const visited = new Set();
  const queue = [...rootIds.filter(Boolean)];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const children = graph.children.get(currentId) || [];
    children.forEach((child) => queue.push(child.id));
  }

  return [...visited];
}

function collectAncestorIds(rootIds = [], graph) {
  const visited = new Set();

  rootIds.filter(Boolean).forEach((rootId) => {
    let current = graph.byId.get(rootId);
    while (current?.parent_site_id) {
      const parentId = current.parent_site_id;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      current = graph.byId.get(parentId);
    }
  });

  return [...visited];
}

function getAssignedRootIds(user = {}) {
  const rolePolicy = user?.role_is_active === false ? null : getRoleLocationPolicy(user?.role);
  if (rolePolicy?.primary_site_type) {
    return user.site_id ? [String(user.site_id)] : [];
  }
  const explicit = normalizeArray(user.allowed_site_ids);
  if (explicit.length > 0) {
    return explicit;
  }
  return user.site_id ? [String(user.site_id)] : [];
}

function intersects(left = [], right = []) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function isGlobalRecipe(record = {}) {
  return !record.site_scope || record.site_scope === 'global';
}

export function hasUnrestrictedLocationAccess(user = {}) {
  return hasAdminAccess(user);
}

export function hasOrganizationWideLocationAccess(user = {}) {
  return user?.role_is_active !== false && hasAllAreaAccess(user?.role);
}

function canAccessLocationRecord(user, entity, record, accessibleSiteIds, accessibleTreeIds) {
  if (hasUnrestrictedLocationAccess(user)) return true;
  if (!record) return true;

  if (entity === 'Recipe' && isGlobalRecipe(record)) return true;

  if (record.id && accessibleTreeIds.has(record.id)) {
    return true;
  }

  const siteFields = [
    record.site_id,
    record.fulfillment_store_id,
    record.from_site_id,
    record.to_site_id
  ].filter(Boolean).map(String);

  if (siteFields.length > 0) {
    return siteFields.every((siteId) => accessibleSiteIds.has(siteId));
  }

  if (Array.isArray(record.site_ids) && record.site_ids.length > 0) {
    return intersects(normalizeArray(record.site_ids), [...accessibleSiteIds]);
  }

  return false;
}

export function isLocationScopedEntity(entity) {
  return LOCATION_SCOPED_ENTITIES.has(entity);
}

export function invalidateLocationScopeCache() {
  siteCatalogGeneration += 1;
  siteCatalogCache = null;
  siteCatalogPromise = null;
}

async function getSiteCatalog() {
  if (siteScopeCacheTtlMs > 0 && siteCatalogCache?.expiresAt > Date.now()) {
    return siteCatalogCache.value;
  }

  if (siteCatalogPromise) {
    return siteCatalogPromise;
  }

  const generation = siteCatalogGeneration;
  const loadingPromise = (async () => {
    const sites = await listDocuments('Site', { limit: 5000, sort: 'name' });
    const value = { sites, graph: createSiteGraph(sites) };
    if (siteScopeCacheTtlMs > 0 && generation === siteCatalogGeneration) {
      siteCatalogCache = {
        value,
        expiresAt: Date.now() + siteScopeCacheTtlMs
      };
    }
    return value;
  })();
  siteCatalogPromise = loadingPromise;

  try {
    return await loadingPromise;
  } finally {
    if (siteCatalogPromise === loadingPromise) siteCatalogPromise = null;
  }
}

export function buildUserLocationScope(user = {}, sites = [], graph = createSiteGraph(sites)) {
  if (hasUnrestrictedLocationAccess(user)) {
    const allIds = new Set(sites.map((site) => String(site.id)));
    return {
      sites,
      graph,
      assignedRootIds: [],
      accessibleSiteIds: allIds,
      accessibleTreeIds: allIds,
      unrestricted: true
    };
  }

  if (hasOrganizationWideLocationAccess(user)) {
    const allIds = new Set(sites.map((site) => String(site.id)));
    return {
      sites,
      graph,
      assignedRootIds: sites
        .filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.AREA)
        .map((site) => String(site.id)),
      accessibleSiteIds: allIds,
      accessibleTreeIds: allIds,
      unrestricted: false,
      organizationWide: true
    };
  }

  const rolePolicy = user?.role_is_active === false ? null : getRoleLocationPolicy(user?.role);
  const assignedRootIds = getAssignedRootIds(user).filter((siteId) => {
    if (!rolePolicy?.primary_site_type) return true;
    const assignedSite = graph.byId.get(String(siteId));
    return Boolean(
      assignedSite
      && assignedSite.is_active !== false
      && isRolePrimarySiteType(user.role, assignedSite.type)
    );
  });
  const explicitAllowedIds = normalizeArray(user?.allowed_site_ids);
  const visibilityScope = String(rolePolicy?.visibility_scope || user?.visibility_scope || '').toLowerCase();
  const rootIds = rolePolicy?.primary_site_type
    ? assignedRootIds
    : (explicitAllowedIds.length ? explicitAllowedIds : assignedRootIds);
  const scopedIds = ['assigned', 'assigned_only', 'custom'].includes(visibilityScope)
    ? rootIds
    : collectDescendantIds(rootIds, graph);
  const accessibleIds = new Set(scopedIds);
  const ancestorIds = new Set(collectAncestorIds(assignedRootIds, graph));
  const accessibleTreeIds = new Set([...accessibleIds, ...ancestorIds]);

  return {
    sites,
    graph,
    assignedRootIds,
    accessibleSiteIds: accessibleIds,
    accessibleTreeIds,
    unrestricted: false
  };
}

async function getLocationScope(user) {
  const { sites, graph } = await getSiteCatalog();
  return buildUserLocationScope(user, sites, graph);
}

function filterRecordsByLocation(user, entity, records = [], scope) {
  if (hasUnrestrictedLocationAccess(user) || !LOCATION_SCOPED_ENTITIES.has(entity)) {
    return records;
  }

  if (entity === 'Site') {
    return records.filter((record) => scope.accessibleSiteIds.has(String(record.id)));
  }

  return records.filter((record) =>
    canAccessLocationRecord(user, entity, record, scope.accessibleSiteIds, scope.accessibleTreeIds)
  );
}

function assertPayloadLocationAccess(user, entity, payload = {}, scope) {
  if (hasUnrestrictedLocationAccess(user) || !LOCATION_SCOPED_ENTITIES.has(entity)) {
    return;
  }

  const referencedSiteIds = normalizeArray([
    payload.site_id,
    payload.fulfillment_store_id,
    payload.from_site_id,
    payload.to_site_id,
    ...normalizeArray(payload.allowed_site_ids),
    ...normalizeArray(payload.site_ids)
  ]);

  const denied = referencedSiteIds.find((siteId) => !scope.accessibleSiteIds.has(siteId));
  if (denied) {
    const error = new Error('You do not have access to one or more selected locations');
    error.status = 403;
    throw error;
  }
}

function buildSiteHierarchy(payload = {}, existing = null, scope) {
  const graph = scope?.graph || createSiteGraph(scope?.sites || []);
  const parentId = payload.parent_site_id ?? existing?.parent_site_id ?? null;
  const parent = parentId ? graph.byId.get(parentId) : null;
  const type = String(payload.type || existing?.type || 'location');
  const currentId = String(existing?.id || payload.id || '');

  if (parentId && !parent) {
    const error = new Error('Selected parent site does not exist');
    error.status = 400;
    throw error;
  }

  if (currentId && String(parentId || '') === currentId) {
    const error = new Error('A site cannot be its own parent');
    error.status = 400;
    throw error;
  }

  const chain = [];
  let cursor = parent;
  const visited = new Set(currentId ? [currentId] : []);
  while (cursor) {
    const cursorId = String(cursor.id || '');
    if (!cursorId || visited.has(cursorId)) {
      const error = new Error('Site hierarchy cannot contain a cycle');
      error.status = 400;
      throw error;
    }
    visited.add(cursorId);
    chain.unshift(cursor);
    cursor = cursor.parent_site_id ? graph.byId.get(cursor.parent_site_id) : null;
  }

  const name = payload.name || existing?.name || '';
  const pathNames = [...chain.map((site) => site.name).filter(Boolean), name].filter(Boolean);

  const hierarchy = {
    parent_site_id: parentId || null,
    parent_site_name: parent?.name || null,
    hierarchy_level: type,
    hierarchy_path: pathNames.join(' / '),
    company_name: null,
    region_name: null,
    location_name: null,
    kitchen_name: null,
    storage_name: null
  };

  [...chain, { name, type }].forEach((node) => {
    if (!node?.type || !node?.name) return;
    if (node.type === 'company') hierarchy.company_name = node.name;
    if (node.type === 'region') hierarchy.region_name = node.name;
    if (['location', 'camp', 'branch', 'headquarters'].includes(node.type)) hierarchy.location_name = node.name;
    if (node.type === 'kitchen') hierarchy.kitchen_name = node.name;
    if (['store', 'warehouse'].includes(node.type)) hierarchy.storage_name = node.name;
  });

  return hierarchy;
}

function normalizeUserLocationPayload(payload = {}, scope) {
  const siteMap = new Map((scope?.sites || []).map((site) => [site.id, site]));
  const role = payload.role || 'user';

  if (role === 'admin') {
    return {
      ...payload,
      site_id: null,
      site_name: null,
      allowed_site_ids: [],
      allowed_site_names: [],
      visibility_scope: 'all_locations'
    };
  }

  const rolePolicy = getRoleLocationPolicy(role);
  if (rolePolicy?.scope === 'all_areas') {
    return normalizeRoleLocationFields(payload);
  }

  if (rolePolicy?.primary_site_type) {
    const primarySiteId = String(payload.site_id || '').trim() || null;
    const submittedAllowedIds = normalizeArray(payload.allowed_site_ids);
    if (submittedAllowedIds.some((siteId) => siteId !== primarySiteId)) {
      const error = new Error(`${rolePolicy.assignment_label} access must use one assigned hierarchy root`);
      error.status = 400;
      throw error;
    }
    return normalizeRoleLocationFields({
      ...payload,
      site_id: primarySiteId,
      site_name: primarySiteId ? siteMap.get(primarySiteId)?.name || payload.site_name || null : null
    });
  }

  const allowedSiteIds = normalizeArray(payload.allowed_site_ids);
  const primarySiteId = payload.site_id || allowedSiteIds[0] || null;
  const mergedAllowedSiteIds = normalizeArray(primarySiteId ? [primarySiteId, ...allowedSiteIds] : allowedSiteIds);
  const allowedSiteNames = mergedAllowedSiteIds
    .map((siteId) => siteMap.get(siteId)?.name)
    .filter(Boolean);

  return {
    ...payload,
    site_id: primarySiteId,
    site_name: primarySiteId ? siteMap.get(primarySiteId)?.name || payload.site_name || null : null,
    allowed_site_ids: mergedAllowedSiteIds,
    allowed_site_names: allowedSiteNames,
    visibility_scope: payload.visibility_scope || 'subtree'
  };
}

function normalizeRecipeLocationPayload(payload = {}, scope) {
  const sites = scope?.sites || [];
  const siteMap = new Map(sites.map((site) => [String(site.id), site]));
  const siteLookup = new Map();
  sites.forEach((site) => {
    [
      site.id,
      site.name,
      site.project_code,
      site.d365_warehouse_id,
      site.warehouse_id,
      site.hierarchy_path
    ].forEach((value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized && !siteLookup.has(normalized)) siteLookup.set(normalized, site);
    });
  });
  const resolveSiteId = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return null;
    return siteLookup.get(normalized)?.id || String(value).trim();
  };
  const siteScope = payload.site_scope || 'global';
  const submittedSiteTokens = siteScope === 'specific'
    ? [...normalizeArray(payload.site_ids), ...normalizeArray(payload.site_names)]
    : [];
  const siteIds = [...new Set(submittedSiteTokens.map(resolveSiteId).filter(Boolean))];
  return {
    ...payload,
    site_scope: siteScope,
    site_ids: siteIds,
    site_names: siteIds.map((siteId) => siteMap.get(siteId)?.name).filter(Boolean)
  };
}

export {
  getLocationScope,
  filterRecordsByLocation,
  assertPayloadLocationAccess,
  createSiteGraph,
  buildSiteHierarchy,
  normalizeUserLocationPayload,
  normalizeRecipeLocationPayload,
  isGlobalRecipe
};
