import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  assertStandardUserGroupMemberEdit,
  assertBulkUploadAdministrator,
  countUserGroupMemberChanges,
  filterBulkUploadPermissionsForAccessLevel,
  getDisallowedBulkUploadPermissions,
  hasAdministratorAccess,
  isBulkInventoryUpload,
  STANDARD_USER_GROUP_MEMBER_CHANGE_LIMIT
} from '../shared/bulkUploadAccess.js';
import { OPERATIONAL_ROLE_DEFINITIONS } from '../shared/managementDashboardRoles.js';
import { canAccessPage } from '../src/lib/pageAccess.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fakeCan = (permissions = []) => (permission) => permissions.includes(permission);

assert.equal(hasAdministratorAccess({ role: 'admin' }), true);
assert.equal(hasAdministratorAccess({ role: 'super_admin' }), true);
assert.equal(hasAdministratorAccess({ role: 'custom_admin', role_access_level: 'admin' }), true);
assert.equal(hasAdministratorAccess({ role: 'super_admin', role_access_level: 'manager' }), false);
assert.equal(hasAdministratorAccess({ role: 'manager', role_access_level: 'manager' }), false);
assert.equal(hasAdministratorAccess({ role: 'area_manager', role_access_level: 'manager' }), false);

assert.doesNotThrow(() => assertBulkUploadAdministrator({ role_access_level: 'admin' }));
assert.throws(
  () => assertBulkUploadAdministrator({ role: 'manager', role_access_level: 'manager' }),
  (error) => error.status === 403 && /Only administrators/i.test(error.message)
);

assert.equal(
  canAccessPage('BulkUploadCenter', fakeCan(['manage_bulk_uploads']), { isAdmin: false }),
  false,
  'stale upload permissions must not grant a non-admin access to the upload center'
);
assert.equal(
  canAccessPage('BulkUploadCenter', fakeCan(['manage_bulk_uploads']), { isAdmin: true }),
  true
);
assert.equal(
  canAccessPage('BulkUploadTemplates', fakeCan(['export_data']), { isAdmin: false }),
  true,
  'template downloads remain available at their existing export access level'
);
assert.equal(canAccessPage('DataExports', fakeCan(['export_data']), { isAdmin: false }), true);

assert.deepEqual(
  filterBulkUploadPermissionsForAccessLevel([
    'view_reports',
    'access_bulk_upload_center',
    'manage_bulk_uploads',
    'export_data'
  ], 'manager'),
  ['view_reports', 'export_data']
);
assert.deepEqual(
  filterBulkUploadPermissionsForAccessLevel([
    'access_bulk_upload_center',
    'manage_bulk_uploads',
    'export_data'
  ], 'admin'),
  ['access_bulk_upload_center', 'manage_bulk_uploads', 'export_data']
);
assert.deepEqual(getDisallowedBulkUploadPermissions({
  access_level: 'manager',
  permissions: ['export_data', 'manage_bulk_uploads', 'access_bulk_upload_center']
}), ['manage_bulk_uploads', 'access_bulk_upload_center']);

const managerPermissions = OPERATIONAL_ROLE_DEFINITIONS.manager.permissions;
assert.equal(managerPermissions.includes('manage_bulk_uploads'), false);
assert.equal(managerPermissions.includes('access_bulk_upload_center'), false);
assert.equal(managerPermissions.includes('access_bulk_upload_templates'), true);
assert.equal(managerPermissions.includes('export_data'), true);
assert.equal(OPERATIONAL_ROLE_DEFINITIONS.admin.permissions.includes('manage_bulk_uploads'), true);

assert.equal(isBulkInventoryUpload({ reason_code: ' bulk_upload ' }), true);
assert.equal(isBulkInventoryUpload({ reason_code: 'manual_receipt' }), false);

const manager = { role: 'manager', role_access_level: 'manager' };
const administrator = { role: 'admin', role_access_level: 'admin' };
const standardMembers = Array.from(
  { length: STANDARD_USER_GROUP_MEMBER_CHANGE_LIMIT },
  (_, index) => ({ user_id: `member-${index}`, name: `Member ${index}`, category: 'labor' })
);
const oversizedMembers = [
  ...standardMembers,
  { user_id: 'member-over-limit', name: 'Over Limit', category: 'labor' }
];
assert.equal(countUserGroupMemberChanges([], standardMembers), STANDARD_USER_GROUP_MEMBER_CHANGE_LIMIT);
assert.doesNotThrow(() => assertStandardUserGroupMemberEdit(manager, { members: standardMembers }));
assert.throws(
  () => assertStandardUserGroupMemberEdit(manager, { members: oversizedMembers }),
  (error) => error.status === 403 && /Administrator bulk-upload action/i.test(error.message)
);
assert.doesNotThrow(() => assertStandardUserGroupMemberEdit(administrator, { members: oversizedMembers }));
assert.doesNotThrow(() => assertStandardUserGroupMemberEdit(
  manager,
  { members: oversizedMembers },
  { members: oversizedMembers }
), 'ordinary edits preserve an existing large group without treating every member as a new import');
const changedMembers = oversizedMembers.map((member) => ({ ...member, name: `${member.name} updated` }));
assert.throws(
  () => assertStandardUserGroupMemberEdit(manager, { members: changedMembers }, { members: oversizedMembers }),
  (error) => error.status === 403,
  'a manager cannot disguise a bulk member rewrite as an ordinary group edit'
);

const server = read('server/index.js');
const worker = read('server/bulkUploadWorker.js');
const entityPreparation = read('server/entityPreparation.js');
const apiClient = read('src/api/base44Client.js');
const bulkUploadCenter = read('src/pages/BulkUploadCenter.jsx');
const inventory = read('src/pages/Inventory.jsx');
const ingredientsPage = read('src/pages/Ingredients.jsx');
const ingredientCard = read('src/components/ingredients/IngredientCard.jsx');
const yieldCost = read('src/pages/YieldCost.jsx');
const pos = read('src/pages/POSIntegration.jsx');
const userGroups = read('src/components/attendance/UserGroupManager.jsx');

assert.match(server, /app\.post\('\/api\/utilities\/bulk-upload', requireAuth, requireBulkUploadAdministrator/);
assert.match(server, /app\.post\('\/api\/integrations\/extract-file', requireAuth, requireBulkUploadAdministrator/);
assert.match(server, /app\.post\('\/api\/pos\/import\/manual', requireAuth, requireBulkUploadAdministrator/);
assert.match(server, /app\.post\('\/api\/user-groups\/bulk-members', requireAuth, requireBulkUploadAdministrator/);
assert.match(server, /if \(isBulkInventoryUpload\(request\.body \|\| \{\}\)\) \{\s*assertBulkUploadAdministrator\(request\.user\)/);
assert.doesNotMatch(server, /Inventory uploads are additive receipts\. Replace and delete modes are disabled/);
assert.match(worker, /const user = job\.actor_snapshot \|\| null;\s*assertBulkUploadAdministrator\(user\);/);
assert.match(worker, /async function clearInventoryForBulkUpload/);
assert.match(worker, /DELETE FROM entity_records[\s\S]*WHERE entity_name = \$1[\s\S]*InventoryLot/);
assert.match(worker, /DELETE FROM entity_records[\s\S]*WHERE entity_name = \$1 AND id = \$2/);
assert.match(worker, /Deleted \$\{deleted\} inventory records and their open lot balances/);
assert.match(worker, /job\.entity_name === 'Inventory' \? 'update' : 'delete'/);
assert.doesNotMatch(worker, /Inventory uploads only support additive receipt mode so stock lots and history remain intact/);
assert.match(worker, /if \(job\.entity_name === 'Ingredient' && job\.import_mode === 'keep_existing'\)/);
assert.match(worker, /updateDocument\(job\.entity_name, existingIngredient\.id, preparedPayload, client\)/);
assert.match(worker, /function findBulkRecipeMatch/);
assert.match(worker, /async function findBulkRecipeMatchInDatabase/);
assert.match(worker, /function findRecipeLineIngredientMatch/);
assert.match(worker, /async function ensureRecipeIngredientsExist/);
assert.match(worker, /\['Inventory', 'Ingredient', 'Recipe'\]\.includes\(job\.entity_name\)/);
assert.match(worker, /if \(job\.entity_name === 'Recipe' && job\.import_mode === 'keep_existing'\)/);
assert.match(worker, /updateDocument\(job\.entity_name, existingRecipe\.id, preparedPayload, client\)/);
assert.match(worker, /SAVEPOINT bulk_upload_row_recover/);
assert.match(worker, /recoveredPreparedPayload/);
assert.match(worker, /context\.ingredientCatalog = await listDocuments\('Ingredient'/);
assert.match(worker, /async function clearRecipeMatchesForBulkUpload/);
assert.match(worker, /LOWER\(COALESCE\(data->>'recipe_code', ''\)\) = ANY\(\$1::text\[\]\)/);
const db = read('server/db.js');
assert.match(db, /COALESCE\(data->'site_ids', '\[\]'::jsonb\) \?\| \$2::text\[\]/);
assert.match(entityPreparation, /if \(entity === 'UserGroup'\) \{\s*assertStandardUserGroupMemberEdit\(user, payload, existing\);/);
assert.match(apiClient, /userGroups:\s*\{\s*bulkImport\(data\)/);

assert.match(bulkUploadCenter, /Deletes selected inventory records and open lots/);
assert.match(inventory, /const \{ isAdmin, can \} = usePermissions\(\)/);
assert.match(inventory, /const canManageInventory = can\('manage_inventory'\)/);
assert.match(ingredientsPage, /const stockSummaryByIngredient = inventory\.reduce/);
assert.match(ingredientsPage, /const ingredientsWithStock = ingredients\.map/);
assert.match(ingredientsPage, /item_code: getItemCodeFromRecords\(\[ing, item\]\)/);
assert.match(ingredientsPage, /ingredient_item_code: getItemCode\(ing, ''\)/);
assert.match(ingredientsPage, />On Hand<\/TableHead>/);
assert.match(ingredientsPage, />Available<\/TableHead>/);
assert.match(ingredientCard, /const stock = ingredient\.stock_summary \|\| \{\};/);
assert.match(ingredientCard, /on hand \{stock\.unit \|\| ingredient\.unit \|\| ''\}/);
assert.match(ingredientCard, /available \{stock\.unit \|\| ingredient\.unit \|\| ''\}/);
assert.match(inventory, /Only administrators can perform bulk uploads/);
assert.match(inventory, /Download Template/);
assert.match(inventory, />\s*Export\s*</);
assert.match(yieldCost, /isAdmin \? \(\s*<YieldUpload isAdmin/);
assert.match(yieldCost, /<YieldTemplateDownload \/>/);
assert.match(pos, /isAdmin \? <TabsTrigger value="upload">Manual Upload<\/TabsTrigger> : null/);
assert.match(userGroups, /Only administrators can upload\. Template downloads remain available\./);
assert.match(userGroups, /Download Template/);
assert.match(userGroups, /base44\.userGroups\.bulkImport/);
assert.match(userGroups, /Import and Save/);

console.log('Bulk upload administrator access tests passed.');
