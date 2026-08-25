import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertGoodsReceiptDestinationScope,
  normalizeGoodsReceiptQuantities,
  resolveGoodsReceiptDestinationStore
} from '../server/procurement.js';

assert.deepEqual(
  normalizeGoodsReceiptQuantities({
    received_quantity: 10,
    accepted_quantity: 10,
    rejected_quantity: 0
  }),
  {
    receivedQuantity: 10,
    acceptedQuantity: 10,
    rejectedQuantity: 0,
    status: 'accepted'
  }
);

assert.deepEqual(
  normalizeGoodsReceiptQuantities({
    received_quantity: 10,
    accepted_quantity: 0,
    rejected_quantity: 10
  }),
  {
    receivedQuantity: 10,
    acceptedQuantity: 0,
    rejectedQuantity: 10,
    status: 'rejected'
  },
  'fully rejected deliveries remain valid receipt audit lines'
);

assert.equal(normalizeGoodsReceiptQuantities({
  received_quantity: 10,
  accepted_quantity: 7,
  rejected_quantity: 3
}).status, 'partially_accepted');

assert.throws(
  () => normalizeGoodsReceiptQuantities({
    received_quantity: 10,
    accepted_quantity: 7,
    rejected_quantity: 2
  }),
  /equal accepted plus rejected/i
);

assert.throws(
  () => normalizeGoodsReceiptQuantities({
    received_quantity: 10,
    accepted_quantity: 'invalid',
    rejected_quantity: 0
  }),
  /Accepted quantity must be a valid number/i
);

const sites = [
  { id: 'area-a', name: 'Area A', type: 'area', is_active: true },
  { id: 'project-a', name: 'Project A', type: 'project', parent_site_id: 'area-a', is_active: true },
  { id: 'store-a', name: 'Store A', type: 'store', parent_site_id: 'project-a', is_active: true },
  { id: 'store-a-inactive', name: 'Inactive Store', type: 'store', parent_site_id: 'project-a', is_active: false },
  { id: 'area-b', name: 'Area B', type: 'area', is_active: true },
  { id: 'project-b', name: 'Project B', type: 'project', parent_site_id: 'area-b', is_active: true },
  { id: 'store-b', name: 'Store B', type: 'store', parent_site_id: 'project-b', is_active: true }
];

assert.equal(
  resolveGoodsReceiptDestinationStore({
    order: { site_id: 'store-a' },
    sites
  }).id,
  'store-a',
  'a PO already assigned to an active Store posts there without a second selection'
);

assert.equal(
  resolveGoodsReceiptDestinationStore({
    order: { site_id: 'project-a' },
    destinationStoreId: 'store-a',
    sites
  }).id,
  'store-a',
  'a Project PO can receive into an active descendant Store'
);

assert.equal(
  resolveGoodsReceiptDestinationStore({
    order: { site_id: 'area-a' },
    destinationStoreId: 'store-a',
    sites
  }).id,
  'store-a',
  'an Area PO can receive into a Store below one of its Projects'
);

assert.throws(
  () => resolveGoodsReceiptDestinationStore({
    order: { site_id: 'project-a' },
    sites
  }),
  (error) => error.status === 400 && /Select a destination Store/i.test(error.message)
);

assert.throws(
  () => resolveGoodsReceiptDestinationStore({
    order: { site_id: 'project-a' },
    destinationStoreId: 'store-b',
    sites
  }),
  (error) => error.status === 403 && /must belong to the purchase order/i.test(error.message)
);

assert.throws(
  () => resolveGoodsReceiptDestinationStore({
    order: { site_id: 'project-a' },
    destinationStoreId: 'store-a-inactive',
    sites
  }),
  (error) => error.status === 409 && /active Store/i.test(error.message)
);

assert.throws(
  () => resolveGoodsReceiptDestinationStore({
    order: { site_id: 'store-a' },
    destinationStoreId: 'store-b',
    sites
  }),
  (error) => error.status === 409 && /must match the Store/i.test(error.message)
);

assert.equal(
  assertGoodsReceiptDestinationScope(
    sites.find((site) => site.id === 'store-a'),
    { unrestricted: false, accessibleSiteIds: new Set(['store-a']) }
  ).id,
  'store-a'
);
assert.throws(
  () => assertGoodsReceiptDestinationScope(
    sites.find((site) => site.id === 'store-b'),
    { unrestricted: false, accessibleSiteIds: new Set(['store-a']) }
  ),
  (error) => error.status === 403 && /do not have access/i.test(error.message)
);

const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const procurementSource = fs.readFileSync(new URL('../server/procurement.js', import.meta.url), 'utf8');
const procurementUiSource = fs.readFileSync(new URL('../src/pages/ProcurementModule.jsx', import.meta.url), 'utf8');

assert.match(serverSource, /\/api\/procurement\/requests\/:id\/approve', requireAuth, requirePermission\('approve_procurement'\)/);
assert.match(serverSource, /\/api\/procurement\/requests\/:id\/reject', requireAuth, requirePermission\('approve_procurement'\)/);
assert.match(serverSource, /\/api\/procurement\/orders\/:id\/approve', requireAuth, requirePermission\('approve_procurement'\)/);
assert.match(serverSource, /\/api\/procurement\/orders\/:id\/cancel', requireAuth, requirePermission\('approve_procurement'\)/);
assert.match(serverSource, /\/api\/procurement\/receipts', requireAuth, requirePermission\('manage_procurement'\)/);
assert.match(serverSource, /\/api\/procurement\/invoices', requireAuth, requirePermission\('manage_procurement'\)/);
assert.match(serverSource, /assertProcurementRecordLocationAccess\(existing, scope, 'Purchase request'\)/);
assert.match(serverSource, /assertProcurementRecordLocationAccess\(existing, scope, 'Purchase order'\)/);
assert.match(serverSource, /createGoodsReceipt\(request\.body \|\| \{\}, request\.user, scope\)/);

assert.match(procurementSource, /site_id: destinationStore\.id/);
assert.match(procurementSource, /site_name: destinationStore\.name/);
assert.match(procurementSource, /findDocument\([\s\S]*'Site',[\s\S]*resolvedDestinationStore\.id,[\s\S]*client,[\s\S]*true[\s\S]*\)/);
assert.match(procurementSource, /destinationStore\.id,[\s\S]*destinationStore\.name,[\s\S]*dateOnly\(payload\.receipt_date/);

assert.match(procurementUiSource, /const canManageProcurement = can\('manage_procurement'\)/);
assert.match(procurementUiSource, /const canApproveProcurement = can\('approve_procurement'\)/);
assert.match(procurementUiSource, /\{canManageProcurement \? \([\s\S]*Record GRN/);
assert.match(procurementUiSource, /aria-label="Destination Store"/);
assert.match(procurementUiSource, /destination_store_id: effectiveReceiptDestinationStoreId/);
assert.match(procurementUiSource, /!effectiveReceiptDestinationStoreId \|\| createReceiptMutation\.isPending/);

console.log('Procurement goods receipt quantity tests passed.');
