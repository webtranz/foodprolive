export const SITE_HIERARCHY_TYPES = Object.freeze({
  AREA: 'area',
  PROJECT: 'project',
  STORE: 'store'
});

export const CANONICAL_SITE_TYPES = Object.freeze(Object.values(SITE_HIERARCHY_TYPES));

const LEGACY_SITE_TYPE_ALIASES = Object.freeze({
  company: SITE_HIERARCHY_TYPES.AREA,
  region: SITE_HIERARCHY_TYPES.AREA,
  location: SITE_HIERARCHY_TYPES.PROJECT,
  branch: SITE_HIERARCHY_TYPES.PROJECT,
  camp: SITE_HIERARCHY_TYPES.PROJECT,
  kitchen: SITE_HIERARCHY_TYPES.STORE,
  headquarters: SITE_HIERARCHY_TYPES.PROJECT,
  warehouse: SITE_HIERARCHY_TYPES.STORE
});

export const SUPPORTED_SITE_TYPES = Object.freeze([
  ...CANONICAL_SITE_TYPES,
  ...Object.keys(LEGACY_SITE_TYPE_ALIASES)
]);

export function normalizeSiteType(value, fallback = SITE_HIERARCHY_TYPES.AREA) {
  const normalized = String(value || '').trim().toLowerCase();
  if (CANONICAL_SITE_TYPES.includes(normalized)) return normalized;
  if (LEGACY_SITE_TYPE_ALIASES[normalized]) return LEGACY_SITE_TYPE_ALIASES[normalized];
  return fallback;
}

export function isCanonicalSiteType(value) {
  return CANONICAL_SITE_TYPES.includes(String(value || '').trim().toLowerCase());
}

export function isSupportedSiteType(value) {
  return SUPPORTED_SITE_TYPES.includes(String(value || '').trim().toLowerCase());
}

export function getSiteTypeLabel(value) {
  const type = normalizeSiteType(value);
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function getRequiredParentType(value) {
  const type = normalizeSiteType(value);
  if (type === SITE_HIERARCHY_TYPES.PROJECT) return SITE_HIERARCHY_TYPES.AREA;
  if (type === SITE_HIERARCHY_TYPES.STORE) return SITE_HIERARCHY_TYPES.PROJECT;
  return null;
}

export function validateCanonicalSiteParent({ type, parent = null, parentId = null } = {}) {
  const rawType = String(type || '').trim().toLowerCase();
  if (!isSupportedSiteType(rawType)) {
    return `Unsupported site type "${rawType || 'empty'}". Use Area, Project, or Store.`;
  }

  const canonicalType = normalizeSiteType(rawType);
  const normalizedParentId = String(parentId || parent?.id || '').trim();

  if (canonicalType === SITE_HIERARCHY_TYPES.AREA) {
    return normalizedParentId ? 'An Area must be a top-level record and cannot have a parent.' : null;
  }

  const requiredParentType = getRequiredParentType(canonicalType);
  if (!normalizedParentId) {
    return `A ${getSiteTypeLabel(canonicalType)} must be created under a ${getSiteTypeLabel(requiredParentType)}.`;
  }

  if (!parent) {
    return 'Selected parent site does not exist.';
  }

  const parentType = normalizeSiteType(parent.type);
  if (parentType !== requiredParentType) {
    return `A ${getSiteTypeLabel(canonicalType)} must be created under a ${getSiteTypeLabel(requiredParentType)}, not a ${getSiteTypeLabel(parentType)}.`;
  }

  return null;
}

export function getAllowedParentSites(type, sites = [], excludedId = null) {
  const requiredParentType = getRequiredParentType(type);
  if (!requiredParentType) return [];
  return sites.filter((site) => (
    String(site?.id || '') !== String(excludedId || '') &&
    normalizeSiteType(site?.type) === requiredParentType
  ));
}

export function getVisibleHierarchyRoots(sites = []) {
  const visibleIds = new Set(sites.map((site) => String(site?.id || '')).filter(Boolean));
  return sites.filter((site) => {
    const parentId = String(site?.parent_site_id || '').trim();
    return !parentId || !visibleIds.has(parentId);
  });
}

export function validateSiteChildrenForParent(parent, children = []) {
  for (const child of children) {
    const hierarchyError = validateCanonicalSiteParent({
      type: child?.type,
      parent,
      parentId: parent?.id
    });
    if (hierarchyError) {
      return `${child?.name || 'Child site'} cannot remain under ${parent?.name || 'the selected parent'}: ${hierarchyError}`;
    }
  }
  return null;
}

export function buildCanonicalHierarchyFields({ site = {}, ancestors = [] } = {}) {
  const nodes = [...ancestors, site];
  const nearestNodeOfType = (type) => [...nodes]
    .reverse()
    .find((node) => normalizeSiteType(node?.type) === type);
  const area = nearestNodeOfType(SITE_HIERARCHY_TYPES.AREA);
  const project = nearestNodeOfType(SITE_HIERARCHY_TYPES.PROJECT);
  const store = nearestNodeOfType(SITE_HIERARCHY_TYPES.STORE);

  return {
    area_name: area?.name || null,
    project_name: project?.name || null,
    store_name: store?.name || null,
    // Preserve the established denormalized names while new consumers move to
    // the explicit Area -> Project -> Store fields.
    region_name: area?.name || null,
    location_name: project?.name || null,
    storage_name: store?.name || null
  };
}
