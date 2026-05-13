import assert from 'node:assert/strict';

import {
  SPECIAL_EVENT_STATUSES,
  appendApprovalHistory,
  assertSpecialEventBudgetApproval,
  buildSpecialEventWritePayload,
  createApprovalHistoryEntry,
  isSpecialEventPlan
} from '../server/specialEvents.js';

const cases = [
  {
    name: 'builds a draft special event payload with event-specific totals',
    run() {
      const payload = buildSpecialEventWritePayload({
        event_name: 'Ramadan Iftar',
        site_id: 'site-1',
        plan_date: '2026-05-20',
        meal_types: ['breakfast', 'dinner'],
        expected_participants: 120,
        estimated_cost: 3500
      });

      assert.equal(payload.event_name, 'Ramadan Iftar');
      assert.equal(payload.plan_date, '2026-05-20');
      assert.equal(payload.event_date, '2026-05-20');
      assert.equal(payload.expected_participants, 120);
      assert.equal(payload.total_expected_servings, 120);
      assert.equal(payload.estimated_cost, 3500);
      assert.equal(payload.total_planned_cost, 3500);
      assert.equal(payload.status, SPECIAL_EVENT_STATUSES.draft);
      assert.deepEqual(payload.meals.map((meal) => meal.meal_type), ['breakfast', 'dinner']);
    }
  },
  {
    name: 'treats event_name plans as special events',
    run() {
      assert.equal(isSpecialEventPlan({ event_name: 'Team Gathering' }), true);
      assert.equal(isSpecialEventPlan({ event_name: '   ' }), false);
    }
  },
  {
    name: 'appends approval history entries in order',
    run() {
      const first = createApprovalHistoryEntry({
        action: 'submitted',
        fromStatus: 'draft',
        toStatus: 'pending_approval',
        actor: { email: 'chef@example.com', full_name: 'Chef One' },
        note: 'Ready for review'
      });
      const history = appendApprovalHistory([], first);

      assert.equal(history.length, 1);
      assert.equal(history[0].action, 'submitted');
      assert.equal(history[0].actor_name, 'Chef One');
      assert.equal(history[0].to_status, 'pending_approval');
    }
  },
  {
    name: 'blocks approval when no linked budget exists',
    run() {
      assert.throws(() => {
        assertSpecialEventBudgetApproval(
          { estimated_cost: 1500 },
          { linked_budget: null, budget_comparison: { is_over_budget: false } }
        );
      }, /linked budget/i);
    }
  },
  {
    name: 'blocks approval when estimated cost exceeds budget',
    run() {
      assert.throws(() => {
        assertSpecialEventBudgetApproval(
          { estimated_cost: 2500 },
          {
            linked_budget: { id: 'budget-1', budget_amount: 2000 },
            budget_comparison: { is_over_budget: true }
          }
        );
      }, /exceeds the available budget/i);
    }
  },
  {
    name: 'allows approval when budget is linked and within limit',
    run() {
      assert.doesNotThrow(() => {
        assertSpecialEventBudgetApproval(
          { estimated_cost: 1800 },
          {
            linked_budget: { id: 'budget-1', budget_amount: 2000 },
            budget_comparison: { is_over_budget: false }
          }
        );
      });
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
  console.log(`PASS ${cases.length} special event workflow tests`);
}
