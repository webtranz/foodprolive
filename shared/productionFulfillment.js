import { SITE_HIERARCHY_TYPES, normalizeSiteType } from './siteHierarchy.js';

function workflowError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function resolveProductionFulfillmentStore(production = {}, siteCatalog = []) {
  const productionSite = siteCatalog.find(
    (site) => String(site.id) === String(production.site_id || '')
  );
  if (!productionSite) {
    throw workflowError('The selected production project/site no longer exists.');
  }

  const productionSiteType = normalizeSiteType(productionSite.type);
  const requestedStore = production.fulfillment_store_id
    ? siteCatalog.find((site) => String(site.id) === String(production.fulfillment_store_id))
    : null;

  if (production.fulfillment_store_id && !requestedStore) {
    throw workflowError('The selected inventory site no longer exists.');
  }

  if (productionSiteType === SITE_HIERARCHY_TYPES.STORE) {
    if (productionSite.is_active === false) {
      throw workflowError('The selected production Store is inactive.');
    }
    if (requestedStore && String(requestedStore.id) !== String(productionSite.id)) {
      throw workflowError('A store-level production request must be fulfilled by that same store.');
    }
    return productionSite;
  }

  if (productionSiteType !== SITE_HIERARCHY_TYPES.PROJECT) {
    throw workflowError('Production must be assigned to a Project or Store, not an Area.');
  }
  if (productionSite.is_active === false) {
    throw workflowError('The selected production Project is inactive.');
  }

  if (!requestedStore || String(requestedStore.id) === String(productionSite.id)) {
    return productionSite;
  }

  const directStores = siteCatalog.filter((site) => (
    normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
    && String(site.parent_site_id || '') === String(productionSite.id)
    && site.is_active !== false
  ));

  if (requestedStore) {
    const isValidChildStore = directStores.some(
      (store) => String(store.id) === String(requestedStore.id)
    );
    if (!isValidChildStore) {
      throw workflowError('The selected inventory site must be an active Store under the selected Project.');
    }
    return requestedStore;
  }

  return productionSite;
}

// The production location determines its inventory. Existing project requests
// retain their recorded store so reservations and consumption stay together.
export function getProductionInventoryContext(production = {}, siteCatalog = []) {
  if (!production?.site_id) {
    return { site: null, siteId: '', error: 'Select a production site.' };
  }
  try {
    const site = resolveProductionFulfillmentStore(production, siteCatalog);
    return { site, siteId: String(site.id), error: '' };
  } catch (error) {
    return { site: null, siteId: '', error: error.message };
  }
}
