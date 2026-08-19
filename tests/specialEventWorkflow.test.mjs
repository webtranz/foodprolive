import assert from 'node:assert/strict';

import {
  SPECIAL_EVENT_STATUSES,
  appendApprovalHistory,
  assertSpecialEventBudgetApproval,
  buildSpecialEventWritePayload,
  createApprovalHistoryEntry,
  isSpecialEventPlan
} from '../server/specialEvents.js';
import {
  assertEventReadyForSubmission,
  buildEventProductionPlanPayloads,
  buildEventPurchaseRequestItems,
  calculateEventPlanningSnapshot
} from '../shared/specialEventPlanning.js';

const linkedRecipe = {
  id: 'recipe-main',
  name: 'Gala Main Course',
  servings: 10,
  portion_size_grams: 250,
  batch_yield: 10,
  costing_method: 'average_cost',
  ingredients: [{ ingredient_id: 'ingredient-main', ingredient_name: 'Main ingredient', quantity: 2, unit: 'kg' }]
};
const eventIngredients = [{
  id: 'ingredient-main',
  item_code: 'ITEM-MAIN-001',
  name: 'Main ingredient',
  unit: 'kg',
  average_cost: 5,
  cost_per_unit: 5,
  cooking_yield_percent: 80
}];
const linkedEvent = {
  event_name: 'Corporate Gala',
  event_date: '2026-05-24',
  site_id: 'site-1',
  event_location: 'Grand Ballroom',
  meal_period: 'dinner',
  service_style: 'plated_service',
  expected_participants: 250,
  event_budget: 300,
  linked_recipes: [{ recipe_id: 'recipe-main', recipe_name: 'Gala Main Course', portion_requirement: 1 }]
};

const cases = [
  {
    name: 'builds connected production handoff and procurement request payloads',
    run() {
      const event = { ...linkedEvent, id: 'event-1', site_name: 'Project A' };
      const snapshot = calculateEventPlanningSnapshot(
        event,
        [linkedRecipe],
        eventIngredients,
        [{ site_id: 'site-1', ingredient_id: 'ingredient-main', quantity: 40, unit: 'kg' }]
      );
      const plans = buildEventProductionPlanPayloads(event, snapshot, [linkedRecipe], eventIngredients);
      assert.equal(plans.length, 1);
      assert.equal(plans[0].source_event_id, 'event-1');
      assert.equal(plans[0].target_servings, 250);
      assert.equal(plans[0].ingredients_used[0].net_quantity, 50);
      assert.equal(plans[0].ingredients_used[0].planned_quantity, 62.5);
      assert.equal(plans[0].ingredients_used[0].yield_percent, 80);
      assert.equal(plans[0].ingredients_used[0].item_code, 'ITEM-MAIN-001');
      const prItems = buildEventPurchaseRequestItems(snapshot, event.event_name);
      assert.equal(prItems.length, 1);
      assert.equal(prItems[0].requested_quantity, 22.5);
      assert.equal(prItems[0].estimated_unit_price, 5);
      assert.equal(prItems[0].item_code, 'ITEM-MAIN-001');
    }
  },
  {
    name: 'scales linked recipe portions, cost, and ingredient demand from guest count',
    run() {
      const snapshot = calculateEventPlanningSnapshot(
        linkedEvent,
        [linkedRecipe],
        eventIngredients,
        [{ site_id: 'site-1', ingredient_id: 'ingredient-main', quantity: 40, unit: 'kg' }]
      );
      assert.equal(snapshot.linked_recipes[0].required_portions, 250);
      assert.equal(snapshot.linked_recipes[0].item_cost, 1);
      assert.equal(snapshot.total_event_cost, 250);
      assert.equal(snapshot.cost_per_guest, 1);
      assert.equal(snapshot.ingredient_requirements[0].net_required_quantity, 50);
      assert.equal(snapshot.ingredient_requirements[0].required_quantity, 62.5);
      assert.equal(snapshot.ingredient_requirements[0].shortage_quantity, 22.5);
      assert.equal(snapshot.ingredient_requirements[0].item_code, 'ITEM-MAIN-001');
      assert.equal(snapshot.estimated_procurement_spend, 112.5);
      assert.equal(snapshot.checklist.menu_and_costing, true);
    }
  },
  {
    name: 'recalculates event cost and detects budget overruns when guest count changes',
    run() {
      const scaled = calculateEventPlanningSnapshot(
        { ...linkedEvent, expected_participants: 400, event_budget: 350 },
        [linkedRecipe],
        eventIngredients,
        []
      );
      assert.equal(scaled.total_event_cost, 400);
      assert.equal(scaled.budget_remaining, -50);
      assert.equal(scaled.is_over_budget, true);
      assert.equal(scaled.checklist.budget_check, false);
    }
  },
  {
    name: 'requires a linked and fully costed recipe before submission',
    run() {
      const noMenu = calculateEventPlanningSnapshot({ ...linkedEvent, linked_recipes: [] }, [linkedRecipe], eventIngredients, []);
      assert.throws(() => assertEventReadyForSubmission({ ...linkedEvent, linked_recipes: [] }, noMenu), /at least one/i);
      const ready = calculateEventPlanningSnapshot(linkedEvent, [linkedRecipe], eventIngredients, []);
      assert.doesNotThrow(() => assertEventReadyForSubmission(linkedEvent, ready));
    }
  },
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
