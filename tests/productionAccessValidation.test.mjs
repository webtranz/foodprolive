import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  canStartApprovedProduction,
  getPendingAreaApprovalProductions,
  getProductionApprovalHistory,
  getProductionRejectionReturnStatus,
  getProductionReviewNotice,
  getProductionStartBlockReason,
  getProductionTransitionPermission
} from '../shared/productionWorkflow.js';

const cases = [
  {
    name: 'rejections return to the owner of the appropriate previous stage',
    run() {
      assert.equal(getProductionRejectionReturnStatus('pending_approval'), 'changes_requested');
      assert.equal(getProductionRejectionReturnStatus('pending_production'), 'pending_procurement');
      assert.equal(
        getProductionTransitionPermission('pending_approval', 'changes_requested', { reviewAction: 'rejected' }),
        'reject_production_request'
      );
      assert.equal(
        getProductionTransitionPermission('pending_production', 'pending_procurement', { reviewAction: 'rejected' }),
        'reject_area_production'
      );
      assert.equal(
        getProductionTransitionPermission('pending_approval', 'changes_requested'),
        'request_changes_production'
      );
    }
  },
  {
    name: 'active workflow no longer queues pending-production records for Area Manager approval',
    run() {
      const records = [
        { id: 'later', site_id: 'project-a', production_date: '2026-08-27', status: 'pending_production' },
        { id: 'other-scope', site_id: 'project-b', production_date: '2026-08-20', status: 'pending_production' },
        { id: 'earlier', site_id: 'project-a', production_date: '2026-08-25', status: 'pending_production' },
        {
          id: 'legacy-pending',
          site_id: 'project-a',
          production_date: '2026-08-26',
          status: 'approved',
          area_approval_status: 'pending',
          area_approved_at: null
        },
        {
          id: 'ready',
          site_id: 'project-a',
          production_date: '2026-08-24',
          status: 'approved',
          area_approval_status: 'approved',
          area_approved_at: '2026-08-24T09:00:00.000Z'
        }
      ];

      assert.deepEqual(
        getPendingAreaApprovalProductions(records, ['project-a']).map((record) => record.id),
        ['legacy-pending']
      );
    }
  },
  {
    name: 'production start remains blocked until Store / Procurement acknowledgement exists',
    run() {
      const pending = {
        status: 'pending_production',
        area_approval_status: 'pending',
        material_request_status: 'acknowledged'
      };
      assert.equal(canStartApprovedProduction(pending), false);
      assert.match(getProductionStartBlockReason(pending), /not approved and ready to start/i);

      const missingProcurement = {
        status: 'approved',
        area_approval_status: 'approved',
        area_approved_at: '2026-08-24T09:00:00.000Z',
        material_request_status: 'pending_procurement_ack'
      };
      assert.equal(canStartApprovedProduction(missingProcurement), false);
      assert.match(getProductionStartBlockReason(missingProcurement), /final approval is pending|Store \/ Procurement acknowledges/i);

      assert.equal(canStartApprovedProduction({
        ...missingProcurement,
        material_request_status: 'acknowledged'
      }), true);
    }
  },
  {
    name: 'approval history exposes action, actor, timestamp, transition, and reason',
    run() {
      const production = {
        submitted_by: 'chef@example.test',
        submitted_by_name: 'Chef One',
        submitted_at: '2026-08-24T06:00:00.000Z',
        pm_approval_status: 'approved',
        pm_approved_by: 'pm@example.test',
        pm_approved_by_name: 'Project Manager',
        pm_approved_at: '2026-08-24T07:00:00.000Z',
        approval_history: [
          {
            action: 'area_manager_rejected',
            actor_email: 'area@example.test',
            actor_name: 'Area Manager',
            timestamp: '2026-08-24T08:00:00.000Z',
            from_status: 'pending_production',
            to_status: 'pending_procurement',
            reason: 'Store must replace a short ingredient.'
          }
        ]
      };
      const history = getProductionApprovalHistory(production);

      assert.deepEqual(history.map((entry) => entry.action), [
        'submitted',
        'pm_approved',
        'area_manager_rejected'
      ]);
      assert.equal(history[2].actor_name, 'Area Manager');
      assert.equal(history[2].timestamp, '2026-08-24T08:00:00.000Z');
      assert.equal(history[2].from_status, 'pending_production');
      assert.equal(history[2].to_status, 'pending_procurement');
      assert.match(history[2].action_label, /Rejected & Returned/);
      assert.match(history[2].reason, /replace a short ingredient/);
    }
  },
  {
    name: 'returned production presents a clear rejection stage and reason',
    run() {
      const areaNotice = getProductionReviewNotice({
        status: 'pending_procurement',
        review_action: 'rejected',
        rejection_reason: 'Procurement must source a substitute.'
      });
      assert.match(areaNotice.label, /Final approval returned/i);
      assert.equal(areaNotice.reason, 'Procurement must source a substitute.');

      const pmNotice = getProductionReviewNotice({
        status: 'changes_requested',
        pm_approval_status: 'rejected',
        review_notes: 'Correct the recipe quantities.'
      });
      assert.match(pmNotice.label, /Project Manager rejected/i);
      assert.equal(pmNotice.reason, 'Correct the recipe quantities.');

      assert.equal(getProductionReviewNotice({
        status: 'pending_production',
        area_approval_status: 'pending',
        last_review_action: 'procurement_acknowledged',
        approval_history: [
          {
            action: 'area_rejected',
            timestamp: '2026-08-24T08:00:00.000Z',
            reason: 'Procurement rework was required.'
          },
          {
            action: 'procurement_acknowledged',
            timestamp: '2026-08-24T09:00:00.000Z'
          }
        ]
      }), null, 'an old rejection must not remain as the current notice after procurement re-acknowledges');

      assert.equal(getProductionReviewNotice({
        status: 'approved',
        area_approval_status: 'approved',
        area_approved_at: '2026-08-24T10:00:00.000Z',
        last_review_action: 'area_approved',
        approval_history: [
          {
            action: 'area_rejected',
            timestamp: '2026-08-24T08:00:00.000Z',
            reason: 'Procurement rework was required.'
          },
          {
            action: 'area_approved',
            timestamp: '2026-08-24T10:00:00.000Z'
          }
        ]
      }), null, 'a superseded rejection belongs in history, not in the current approved-state alert');
    }
  },
  {
    name: 'backend keeps authoritative history and uses Store / Procurement as the final approval gate',
    run() {
      const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
      const preparationSource = fs.readFileSync(new URL('../server/entityPreparation.js', import.meta.url), 'utf8');
      const entitySource = fs.readFileSync(new URL('../server/entities.js', import.meta.url), 'utf8');

      assert.match(serverSource, /applyProductionWorkflowMetadata\([\s\S]*lockedExisting[\s\S]*request\.body/);
      assert.match(serverSource, /approval_history: appendProductionApprovalHistory/);
      assert.match(serverSource, /operation: 'store_procurement_approval'/);
      assert.match(serverSource, /PRODUCTION_PROCUREMENT_ACKNOWLEDGED/);
      assert.match(serverSource, /acknowledged_by: null[\s\S]*acknowledged_by_name: null[\s\S]*acknowledged_at: null/);
      assert.match(preparationSource, /'approval_history', 'review_action', 'rejection_reason'/);
      assert.match(entitySource, /Rejected production requests must return to an actionable previous stage/);
    }
  },
  {
    name: 'production UI removes the active Area Manager approval queue and keeps visible history',
    run() {
      const pageSource = fs.readFileSync(new URL('../src/pages/Production.jsx', import.meta.url), 'utf8');
      const dashboardSource = fs.readFileSync(
        new URL('../src/components/production/ProductionPlanningDashboard.jsx', import.meta.url),
        'utf8'
      );
      assert.doesNotMatch(pageSource, /Area Manager Review/);
      assert.match(pageSource, /pending_production/);
      assert.match(pageSource, /getProductionRejectionReturnStatus/);
      assert.match(pageSource, /rejection_reason/);
      assert.match(pageSource, /Production Approval History/);
      assert.match(dashboardSource, /Legacy Pending Production Reviews/);
      assert.doesNotMatch(dashboardSource, /Pending Area Manager Approvals/);
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
  console.log(`PASS ${cases.length} production access and validation tests`);
}
