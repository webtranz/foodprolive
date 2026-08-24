import assert from 'node:assert/strict';
import fs from 'node:fs';

import { authorizeEntityAction, hasPermission } from '../server/entities.js';
import { resolveProductionFulfillmentStore } from '../shared/productionFulfillment.js';
import {
  PRODUCTION_STATUS,
  canStartApprovedProduction,
  getProductionStatusLabel,
  getProductionTransitionPermission,
  hasAcknowledgedMaterialRequest,
  hasAreaProductionApproval,
  hasAuthoritativeNoMaterialRequirement,
  isAllowedProductionTransition,
  isProductionTerminalStatus,
  normalizeProductionStatus,
  requiresAreaProductionApproval
} from '../shared/productionWorkflow.js';

function customUser(role, permissions, accessLevel = 'manager') {
  return {
    id: `${role}-user`,
    email: `${role}@example.test`,
    role,
    role_access_level: accessLevel,
    role_permissions: permissions,
    is_custom_role: true
  };
}

const chef = customUser('chef', [
  'manage_production',
  'create_production_request',
  'edit_production_request',
  'submit_production_request',
  'start_production',
  'complete_production'
], 'user');

const projectManager = customUser('project_manager', [
  'manage_production',
  'review_production_request',
  'approve_production_request',
  'reject_production_request',
  'request_changes_production'
]);

const areaManager = customUser('area_manager', [
  'manage_production',
  'approve_production',
  'request_changes_area_production',
  'reject_area_production'
]);

const productionSupervisor = customUser('production_supervisor', [
  'manage_production',
  'start_production',
  'complete_production'
]);

const procurementOfficer = customUser('procurement_officer', [
  'view_material_request',
  'acknowledge_material_request'
]);

const administrator = {
  id: 'admin-user',
  email: 'admin@example.test',
  role: 'admin',
  role_access_level: 'admin',
  is_custom_role: false
};

const readyProduction = {
  id: 'production-ready',
  status: PRODUCTION_STATUS.READY_TO_START,
  area_approval_status: 'approved',
  area_approved_at: '2026-08-24T08:00:00.000Z',
  material_request_status: 'acknowledged'
};

const cases = [
  {
    name: 'named built-in roles do not inherit the generic Manager permission bundle',
    run() {
      const builtInAreaManager = {
        id: 'area-manager-built-in',
        role: 'area_manager',
        role_access_level: 'manager',
        is_custom_role: false
      };
      const builtInProjectManager = {
        id: 'project-manager-built-in',
        role: 'project_manager',
        role_access_level: 'manager',
        is_custom_role: false
      };
      assert.equal(hasPermission(builtInAreaManager, 'approve_production'), true);
      assert.equal(hasPermission(builtInAreaManager, 'approve_production_request'), false);
      assert.equal(hasPermission(builtInAreaManager, 'start_production'), false);
      assert.equal(hasPermission(builtInProjectManager, 'approve_production_request'), true);
      assert.equal(hasPermission(builtInProjectManager, 'approve_production'), false);
      assert.equal(hasPermission(builtInProjectManager, 'start_production'), false);
    }
  },
  {
    name: 'production fulfillment resolves only an active Store under the selected Project',
    run() {
      const sites = [
        { id: 'area-west', type: 'area', is_active: true },
        { id: 'project-a', type: 'project', parent_site_id: 'area-west', is_active: true },
        { id: 'store-a', type: 'store', parent_site_id: 'project-a', is_active: true },
        { id: 'store-b', type: 'store', parent_site_id: 'project-a', is_active: true },
        { id: 'store-inactive', type: 'store', parent_site_id: 'project-a', is_active: false },
        { id: 'project-b', type: 'project', parent_site_id: 'area-west', is_active: true },
        { id: 'store-c', type: 'store', parent_site_id: 'project-b', is_active: true }
      ];

      assert.equal(
        resolveProductionFulfillmentStore({ site_id: 'project-a', fulfillment_store_id: 'store-b' }, sites).id,
        'store-b'
      );
      assert.equal(
        resolveProductionFulfillmentStore({ site_id: 'store-a' }, sites).id,
        'store-a'
      );
      assert.throws(
        () => resolveProductionFulfillmentStore({ site_id: 'project-a' }, sites),
        /Select the Store/
      );
      assert.throws(
        () => resolveProductionFulfillmentStore({ site_id: 'project-a', fulfillment_store_id: 'store-c' }, sites),
        /must be an active Store under the selected Project/
      );
      assert.throws(
        () => resolveProductionFulfillmentStore({ site_id: 'project-a', fulfillment_store_id: 'store-inactive' }, sites),
        /must be an active Store under the selected Project/
      );
      assert.throws(
        () => resolveProductionFulfillmentStore({ site_id: 'area-west' }, sites),
        /Project or Store, not an Area/
      );
    }
  },
  {
    name: 'Area approval has a dedicated audited endpoint and client action',
    run() {
      const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
      const clientSource = fs.readFileSync(new URL('../src/api/base44Client.js', import.meta.url), 'utf8');
      assert.match(serverSource, /\/api\/productions\/:id\/area-approve/);
      assert.match(serverSource, /PRODUCTION_AREA_APPROVED/);
      assert.match(serverSource, /currentStatus === 'approved'[\s\S]*requiresAreaProductionApproval\(lockedProduction\)/);
      assert.match(clientSource, /approveForArea\(id, data = \{\}\)/);
    }
  },
  {
    name: 'procurement handoff is transactional and uses a consistent lock order',
    run() {
      const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
      const activationStart = serverSource.indexOf("app.post('/api/material-requests/from-production/:id'");
      const acknowledgeStart = serverSource.indexOf("app.post('/api/material-requests/:id/acknowledge'");
      const areaApprovalStart = serverSource.indexOf("app.post('/api/productions/:id/area-approve'");
      const activationBlock = serverSource.slice(activationStart, acknowledgeStart);
      const acknowledgementBlock = serverSource.slice(acknowledgeStart, areaApprovalStart);

      assert.ok(activationStart >= 0 && acknowledgeStart > activationStart);
      assert.match(activationBlock, /withTransaction\(async \(client\)/);
      assert.match(activationBlock, /findDocument\('Production', request\.params\.id, client, true\)/);
      assert.match(activationBlock, /PRODUCTION_MATERIAL_REQUEST_ACTIVATED/);
      assert.match(activationBlock, /PRODUCTION_MATERIAL_REQUEST_NOT_REQUIRED/);
      assert.doesNotMatch(activationBlock, /no ingredients to build a material request/);

      const productionLock = acknowledgementBlock.indexOf("findDocument('Production', sourceProductionId, client, true)");
      const materialRequestLock = acknowledgementBlock.indexOf("findDocument('MaterialRequest', request.params.id, client, true)");
      assert.ok(productionLock >= 0, 'acknowledgement should lock the linked Production');
      assert.ok(materialRequestLock > productionLock, 'acknowledgement must lock Production before MaterialRequest');
      assert.match(acknowledgementBlock, /source changed while it was being reviewed/);
    }
  },
  {
    name: 'declared granular read permissions are authoritative',
    run() {
      const dashboardOnlyUser = customUser('dashboard_viewer', ['view_dashboard'], 'user');
      for (const entity of ['Production', 'Inventory', 'MaterialRequest']) {
        assert.throws(
          () => authorizeEntityAction(dashboardOnlyUser, entity, 'list'),
          (error) => error?.status === 403 && /permission to view/i.test(error.message),
          `${entity} should reject a dashboard-only user`
        );
      }
      assert.doesNotThrow(() => authorizeEntityAction(
        customUser('inventory_viewer', ['view_inventory'], 'user'),
        'Inventory',
        'list'
      ));
      assert.doesNotThrow(() => authorizeEntityAction(
        customUser('material_viewer', ['view_material_request'], 'user'),
        'MaterialRequest',
        'list'
      ));
    }
  },
  {
    name: 'production statuses normalize and expose operational labels',
    run() {
      assert.equal(normalizeProductionStatus(' Pending_Production '), 'pending_production');
      assert.equal(getProductionStatusLabel('draft'), 'Production Created');
      assert.equal(getProductionStatusLabel('planned'), 'Production Created');
      assert.equal(getProductionStatusLabel('pending_approval'), 'Pending PM Approval');
      assert.equal(getProductionStatusLabel('pending_procurement'), 'Pending Store / Procurement');
      assert.equal(getProductionStatusLabel('pending_production'), 'Pending Area Manager Approval');
      assert.equal(getProductionStatusLabel('approved'), 'Approved / Ready to Start');
      assert.equal(getProductionStatusLabel('in_progress'), 'Production In Progress');
      assert.equal(getProductionStatusLabel('completed'), 'Production Completed');
      assert.equal(isProductionTerminalStatus('completed'), true);
      assert.equal(isProductionTerminalStatus('rejected'), true);
      assert.equal(isProductionTerminalStatus('cancelled'), true);
      assert.equal(isProductionTerminalStatus('approved'), false);
    }
  },
  {
    name: 'only declared production workflow transitions are valid',
    run() {
      const validTransitions = [
        ['planned', 'pending_approval'],
        ['draft', 'pending_approval'],
        ['changes_requested', 'pending_approval'],
        ['pending_approval', 'pending_procurement'],
        ['pending_approval', 'changes_requested'],
        ['pending_procurement', 'pending_production'],
        ['pending_production', 'approved'],
        ['pending_production', 'pending_procurement'],
        ['pending_production', 'changes_requested'],
        ['approved', 'pending_procurement'],
        ['approved', 'in_progress'],
        ['in_progress', 'completed']
      ];
      validTransitions.forEach(([from, to]) => {
        assert.equal(isAllowedProductionTransition(from, to), true, `${from} -> ${to} should be valid`);
      });

      const invalidTransitions = [
        ['draft', 'approved'],
        ['pending_approval', 'approved'],
        ['pending_approval', 'rejected'],
        ['pending_procurement', 'in_progress'],
        ['pending_production', 'in_progress'],
        ['pending_production', 'rejected'],
        ['approved', 'completed'],
        ['completed', 'in_progress'],
        ['draft', 'arbitrary_status']
      ];
      invalidTransitions.forEach(([from, to]) => {
        assert.equal(isAllowedProductionTransition(from, to), false, `${from} -> ${to} should be invalid`);
      });

      assert.equal(getProductionTransitionPermission('draft', 'pending_approval'), 'submit_production_request');
      assert.equal(getProductionTransitionPermission('pending_approval', 'pending_procurement'), 'approve_production_request');
      assert.equal(getProductionTransitionPermission('pending_production', 'approved'), 'approve_production');
      assert.equal(getProductionTransitionPermission('pending_production', 'changes_requested'), 'request_changes_area_production');
      assert.equal(
        getProductionTransitionPermission('pending_approval', 'changes_requested', { reviewAction: 'rejected' }),
        'reject_production_request'
      );
      assert.equal(
        getProductionTransitionPermission('pending_production', 'pending_procurement', { reviewAction: 'rejected' }),
        'reject_area_production'
      );
      assert.equal(getProductionTransitionPermission('approved', 'in_progress'), 'start_production');
      assert.equal(getProductionTransitionPermission('in_progress', 'completed'), 'complete_production');
    }
  },
  {
    name: 'production start requires both Area approval and supply acknowledgement',
    run() {
      assert.equal(hasAreaProductionApproval(readyProduction), true);
      assert.equal(hasAcknowledgedMaterialRequest(readyProduction), true);
      assert.equal(canStartApprovedProduction(readyProduction), true);
      assert.equal(canStartApprovedProduction({
        ...readyProduction,
        material_request_status: 'not_required'
      }), true, 'a recipe with no stock-managed materials may start');
      assert.equal(hasAuthoritativeNoMaterialRequirement({
        recipe_id: 'recipe-water',
        target_servings: 10,
        yield_adjustment_applied: true,
        yield_snapshot_source: 'server_recipe_expansion',
        ingredients_used: []
      }), true);
      assert.equal(hasAuthoritativeNoMaterialRequirement({
        recipe_id: 'recipe-water',
        target_servings: 10,
        yield_adjustment_applied: true,
        ingredients_used: []
      }), false, 'a client-spoofable yield flag is not authoritative without the server snapshot marker');
      assert.equal(canStartApprovedProduction({
        ...readyProduction,
        area_approval_status: 'pending'
      }), false);
      assert.equal(canStartApprovedProduction({
        ...readyProduction,
        area_approved_at: null
      }), false);
      assert.equal(canStartApprovedProduction({
        ...readyProduction,
        material_request_status: 'pending_procurement_ack'
      }), false);
      assert.equal(canStartApprovedProduction({
        ...readyProduction,
        status: 'pending_production'
      }), false);
      assert.equal(requiresAreaProductionApproval({
        ...readyProduction,
        area_approval_status: 'pending'
      }), true);
      assert.equal(requiresAreaProductionApproval({
        ...readyProduction,
        area_approved_at: null
      }), true);
      assert.equal(requiresAreaProductionApproval(readyProduction), false);
    }
  },
  {
    name: 'workflow authorization enforces the permission assigned to each approval role',
    run() {
      assert.doesNotThrow(() => authorizeEntityAction(
        chef,
        'Production',
        'update',
        { status: 'pending_approval' },
        { status: 'draft' }
      ));
      assert.doesNotThrow(() => authorizeEntityAction(
        projectManager,
        'Production',
        'update',
        { status: 'pending_procurement' },
        { status: 'pending_approval' }
      ));
      assert.throws(() => authorizeEntityAction(
        productionSupervisor,
        'Production',
        'update',
        { status: 'pending_procurement' },
        { status: 'pending_approval' }
      ), /do not have permission/i);
      assert.throws(() => authorizeEntityAction(
        areaManager,
        'Production',
        'update',
        { status: 'approved' },
        { status: 'pending_production' }
      ), /Area Manager approval action/i);
      assert.throws(() => authorizeEntityAction(
        productionSupervisor,
        'Production',
        'update',
        { status: 'approved' },
        { status: 'pending_production' }
      ), /Area Manager approval action/i);
      assert.throws(() => authorizeEntityAction(
        procurementOfficer,
        'Production',
        'update',
        { status: 'pending_production' },
        { status: 'pending_procurement' }
      ), /set only after Store Keeper \/ Procurement acknowledgement/i);
      assert.throws(() => authorizeEntityAction(
        projectManager,
        'Production',
        'update',
        { status: 'rejected', review_notes: 'Do not proceed.' },
        { status: 'pending_approval' }
      ), /Invalid production workflow transition|must return to an actionable previous stage/i);
      assert.throws(() => authorizeEntityAction(
        projectManager,
        'Production',
        'update',
        { status: 'changes_requested', review_action: 'rejected' },
        { status: 'pending_approval' }
      ), /reason is required/i);
      assert.doesNotThrow(() => authorizeEntityAction(
        projectManager,
        'Production',
        'update',
        {
          status: 'changes_requested',
          review_action: 'rejected',
          rejection_reason: 'Recipe quantities need correction.'
        },
        { status: 'pending_approval' }
      ));
      assert.throws(() => authorizeEntityAction(
        projectManager,
        'Production',
        'update',
        {
          status: 'pending_procurement',
          review_action: 'rejected',
          rejection_reason: 'Not operationally ready.'
        },
        { status: 'pending_production' }
      ), /do not have permission/i);
      assert.doesNotThrow(() => authorizeEntityAction(
        areaManager,
        'Production',
        'update',
        {
          status: 'pending_procurement',
          review_action: 'rejected',
          rejection_reason: 'Not operationally ready.'
        },
        { status: 'pending_production' }
      ));
      assert.doesNotThrow(() => authorizeEntityAction(
        administrator,
        'Production',
        'update',
        { status: 'pending_procurement' },
        { status: 'pending_approval' }
      ));
      assert.throws(() => authorizeEntityAction(
        administrator,
        'Production',
        'update',
        { status: 'approved' },
        { status: 'pending_production' }
      ), /Area Manager approval action/i);
    }
  },
  {
    name: 'start authorization rejects incomplete workflow prerequisites',
    run() {
      assert.doesNotThrow(() => authorizeEntityAction(
        chef,
        'Production',
        'update',
        { status: 'in_progress' },
        readyProduction
      ));
      assert.throws(() => authorizeEntityAction(
        chef,
        'Production',
        'update',
        { status: 'in_progress' },
        { ...readyProduction, material_request_status: 'pending_procurement_ack' }
      ), /cannot start until procurement is acknowledged and the Area Manager has approved/i);
      assert.throws(() => authorizeEntityAction(
        projectManager,
        'Production',
        'update',
        { status: 'in_progress' },
        readyProduction
      ), /do not have permission/i);
    }
  },
  {
    name: 'generic entity updates cannot complete production directly',
    run() {
      assert.throws(() => authorizeEntityAction(
        chef,
        'Production',
        'update',
        { status: 'completed' },
        { status: 'in_progress' }
      ), (error) => error?.status === 409 && /completion action/i.test(error.message));
      assert.throws(() => authorizeEntityAction(
        administrator,
        'Production',
        'update',
        { status: 'completed' },
        { status: 'approved' }
      ), (error) => error?.status === 409 && /invalid production workflow transition/i.test(error.message));
    }
  },
  {
    name: 'completed production records reject every client mutation',
    run() {
      assert.throws(() => authorizeEntityAction(
        administrator,
        'Production',
        'update',
        { notes: 'Changed after posting' },
        { status: 'completed' }
      ), (error) => error?.status === 409 && /immutable/i.test(error.message));
      assert.throws(() => authorizeEntityAction(
        administrator,
        'Production',
        'update',
        { status: 'in_progress' },
        { status: 'completed' }
      ), (error) => error?.status === 409 && /immutable/i.test(error.message));
      for (const status of ['draft', 'pending_approval', 'pending_procurement', 'pending_production', 'approved', 'in_progress', 'completed']) {
        assert.throws(() => authorizeEntityAction(
          administrator,
          'Production',
          'delete',
          null,
          { status }
        ), (error) => error?.status === 409 && /cannot be deleted/i.test(error.message));
      }
    }
  },
  {
    name: 'production consumption reports reject all client writes',
    run() {
      for (const action of ['create', 'update', 'delete']) {
        assert.throws(() => authorizeEntityAction(
          administrator,
          'ProductionConsumptionReport',
          action,
          { report_number: 'PCR-TEST' },
          { id: 'report-1' }
        ), (error) => (
          error?.status === 409
          && /immutable and are generated only by completing production/i.test(error.message)
        ));
      }
    }
  }
];

let failed = false;
for (const testCase of cases) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`PASS ${cases.length} production workflow tests`);
}
