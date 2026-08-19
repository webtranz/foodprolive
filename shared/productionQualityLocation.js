function normalizeId(value) {
  return value === null || typeof value === 'undefined'
    ? ''
    : String(value).trim();
}

function locationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Copies the authoritative site from a linked production record or production
 * batch. A caller-supplied site may confirm the link, but it cannot override it.
 */
export function applyLinkedProductionLocation(
  payload = {},
  linkedRecord = {},
  sites = [],
  linkedLabel = 'linked production record'
) {
  const linkedSiteId = normalizeId(linkedRecord.site_id);
  if (!linkedSiteId) {
    throw locationError(`The ${linkedLabel} is not assigned to a site.`);
  }

  const submittedSiteId = normalizeId(payload.site_id);
  if (submittedSiteId && submittedSiteId !== linkedSiteId) {
    throw locationError(`The selected site does not match the ${linkedLabel}.`, 409);
  }

  const site = (Array.isArray(sites) ? sites : [])
    .find((candidate) => normalizeId(candidate?.id) === linkedSiteId);

  return {
    ...payload,
    site_id: linkedSiteId,
    site_name: site?.name || linkedRecord.site_name || payload.site_name || null
  };
}

/**
 * Ensures a standalone operational record is still attributable to one site.
 * The authenticated user's primary assignment is only used when no site was
 * supplied; multi-site/admin callers must choose a site explicitly.
 */
export function applyRequiredOperationalLocation(
  payload = {},
  sites = [],
  fallbackSiteId = '',
  recordLabel = 'operational record'
) {
  const siteId = normalizeId(payload.site_id) || normalizeId(fallbackSiteId);
  if (!siteId) {
    throw locationError(`A site is required for this ${recordLabel}.`);
  }

  const site = (Array.isArray(sites) ? sites : [])
    .find((candidate) => normalizeId(candidate?.id) === siteId);

  return {
    ...payload,
    site_id: siteId,
    site_name: site?.name || payload.site_name || null
  };
}
