import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProductionInventoryContext, resolveProductionFulfillmentStore } from '../shared/productionFulfillment.js';
import {
  buildProductionIngredientSnapshot,
  getMenuIssueInventoryCheckState,
  recalculateProductionIngredientSnapshot
} from '../src/lib/productionIssue.js';

const sites = [
  { id: 'area', name: 'Area', type: 'area', is_active: true },
  { id: 'project', name: 'Abqaiq Camp', type: 'project', parent_site_id: 'area', is_active: true },
  { id: 'camp-store', name: 'Abqaiq Camp Store', type: 'store', parent_site_id: 'project', is_active: true },
  { id: 'other-project', name: 'Other project', type: 'project', parent_site_id: 'area', is_active: true },
  { id: 'other-store', name: 'Other store', type: 'store', parent_site_id: 'other-project', is_active: true }
];

test('a store supplies its own production without a separate inventory selector', () => {
  const context = getProductionInventoryContext({ site_id: 'camp-store' }, sites);
  assert.equal(context.error, '');
  assert.equal(context.siteId, 'camp-store');
  assert.equal(context.site.name, 'Abqaiq Camp Store');
  assert.equal(resolveProductionFulfillmentStore({ site_id: 'camp-store' }, sites).id, context.siteId);
});

test('the store checks its own stock and retains zeroed ingredient edits', () => {
  const context = getProductionInventoryContext({ site_id: 'camp-store' }, sites);
  const ingredients = [{ id: 'rice', name: 'Rice', unit: 'kg', cost_per_unit: 4 }];
  const inventory = [
    { site_id: 'camp-store', ingredient_id: 'rice', quantity: 2, unit: 'kg' },
    { site_id: 'other-store', ingredient_id: 'rice', quantity: 100, unit: 'kg' }
  ];
  const recipe = { id: 'dish', servings: 1, ingredients: [{ ingredient_id: 'rice', quantity: 3, unit: 'kg' }] };
  const snapshot = buildProductionIngredientSnapshot({ recipe, recipes: [recipe], ingredients, inventory, siteId: context.siteId, targetServings: 1 });
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0].available_stock, 2);
  assert.equal(snapshot.lines[0].shortage, 1);
  const edited = recalculateProductionIngredientSnapshot(snapshot.lines.map(line => ({ ...line, raw_quantity: 0 })), { ingredients, inventory, siteId: context.siteId });
  assert.equal(edited.lines[0].shortage, 0);
  assert.equal(edited.lines[0].production_override_action, 'zeroed');
});

test('projects and stores use their own inventory site while retaining a previously recorded store', () => {
  assert.equal(getProductionInventoryContext({ site_id: 'project' }, sites).siteId, 'project');
  const multipleStores = [...sites, { id: 'second-store', type: 'store', parent_site_id: 'project', is_active: true }];
  assert.equal(getProductionInventoryContext({ site_id: 'project', fulfillment_store_id: 'camp-store' }, multipleStores).siteId, 'camp-store');
  const ambiguous = getProductionInventoryContext({ site_id: 'project' }, multipleStores);
  assert.equal(ambiguous.siteId, 'project');
  assert.equal(ambiguous.error, '');
});

test('missing, inactive, inaccessible, and different stores are not used as fallbacks', () => {
  assert.equal(getProductionInventoryContext({ site_id: 'missing' }, sites).siteId, '');
  assert.equal(getProductionInventoryContext({ site_id: 'camp-store' }, sites.filter(site => site.id !== 'camp-store')).siteId, '');
  assert.equal(getProductionInventoryContext({ site_id: 'camp-store' }, sites.map(site => site.id === 'camp-store' ? { ...site, is_active: false } : site)).siteId, '');
  assert.equal(getProductionInventoryContext({ site_id: 'area' }, sites).siteId, '');
  assert.equal(getProductionInventoryContext({ site_id: 'camp-store', fulfillment_store_id: 'other-store' }, sites).siteId, '');
});

const readyCheck = {
  siteId: 'camp-store',
  snapshotSiteId: 'camp-store',
  items: [{ key: 'breakfast' }],
  snapshotsByItemKey: { breakfast: [{ ingredient_id: 'rice', raw_quantity: 0, sufficient: true }] }
};

test('no-shortages status is unavailable until the right inventory and all dish snapshots are ready', () => {
  assert.equal(getMenuIssueInventoryCheckState().ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, isLoading: true }).ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, error: 'Inventory could not be loaded' }).ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, siteId: '' }).ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, snapshotSiteId: 'other-store' }).ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, snapshotsByItemKey: {} }).ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, snapshotsByItemKey: { breakfast: [] } }).ready, false);
  assert.equal(getMenuIssueInventoryCheckState({ ...readyCheck, items: [...readyCheck.items, { key: 'dinner' }] }).ready, false);
  assert.deepEqual(getMenuIssueInventoryCheckState(readyCheck), { ready: true, message: '' });
});
