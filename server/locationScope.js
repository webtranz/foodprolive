import { listDocuments } from './db.js';

const LOCATION_SCOPED_ENTITIES = new Set([
  'Inventory',
  'InventoryLot',
  'InventoryTransaction',
  'Production',
  'ProductionBatch',
  'ProductionTransfer',
  'MenuPlan',
  'FoodWaste',
  'MaterialRequest',
  'PurchaseOrder',
  'Supplier',
  'QualityControl',
  'AttendanceSession',
  'AttendanceRecord',
  'DinerScan',
  'BranchOrder',
  'Recipe',
  'AdvancedReportSchedule',
  'User',
  'Site'
]);

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
  return !record.site_scope || record.site_scope === 'global' || normalizeArray(record.site_ids).length === 0;
}

function canAccessLocationRecord(user, record, accessibleSiteIds, accessibleTreeIds) {
  if (user?.role === 'admin') return true;
  if (!record) return true;

  if (record.id && accessibleTreeIds.has(record.id)) {
    return true;
  }

  const siteFields = [
    record.site_id,
    record.from_site_id,
    record.to_site_id
  ].filter(Boolean).map(String);

  if (siteFields.length > 0) {
    return siteFields.every((siteId) => accessibleSiteIds.has(siteId));
  }

  if (Array.isArray(record.site_ids) && record.site_ids.length > 0) {
    return intersects(normalizeArray(record.site_ids), [...accessibleSiteIds]);
  }

  return true;
}

async function getAllSites() {
  return listDocuments('Site', { limit: 5000, sort: 'name' });
}

async function getLocationScope(user) {
  const sites = await getAllSites();
  const graph = createSiteGraph(sites);

  if (user?.role === 'admin') {
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

  const assignedRootIds = getAssignedRootIds(user);
  const scopedIds = user?.visibility_scope === 'assigned_only'
    ? assignedRootIds
    : collectDescendantIds(assignedRootIds, graph);
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

function filterRecordsByLocation(user, entity, records = [], scope) {
  if (user?.role === 'admin' || !LOCATION_SCOPED_ENTITIES.has(entity)) {
    return records;
  }

  return records.filter((record) =>
    canAccessLocationRecord(user, record, scope.accessibleSiteIds, scope.accessibleTreeIds)
  );
}

function assertPayloadLocationAccess(user, entity, payload = {}, scope) {
  if (user?.role === 'admin' || !LOCATION_SCOPED_ENTITIES.has(entity)) {
    return;
  }

  const referencedSiteIds = normalizeArray([
    payload.site_id,
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

  const chain = [];
  let cursor = parent;
  while (cursor) {
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
  const siteMap = new Map((scope?.sites || []).map((site) => [site.id, site]));
  const siteScope = payload.site_scope || 'global';
  const siteIds = siteScope === 'specific' ? normalizeArray(payload.site_ids) : [];
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
  buildSiteHierarchy,
  normalizeUserLocationPayload,
  normalizeRecipeLocationPayload,
  isGlobalRecipe
};
