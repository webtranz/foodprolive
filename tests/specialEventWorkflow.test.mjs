import assert from 'node:assert/strict';
import fs from 'node:fs';

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
      assert.equal(plans[0].ingredients_used[0].raw_quantity, 50);
      assert.equal(plans[0].ingredients_used[0].net_quantity, 40);
      assert.equal(plans[0].ingredients_used[0].planned_quantity, 50);
      assert.equal(plans[0].ingredients_used[0].yield_percent, 80);
      assert.equal(plans[0].ingredients_used[0].item_code, 'ITEM-MAIN-001');
      const prItems = buildEventPurchaseRequestItems(snapshot, event.event_name);
      assert.equal(prItems.length, 1);
      assert.equal(prItems[0].requested_quantity, 10);
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
      assert.equal(snapshot.ingredient_requirements[0].net_required_quantity, 40);
      assert.equal(snapshot.ingredient_requirements[0].required_quantity, 50);
      assert.equal(snapshot.ingredient_requirements[0].shortage_quantity, 10);
      assert.equal(snapshot.ingredient_requirements[0].item_code, 'ITEM-MAIN-001');
      assert.equal(snapshot.estimated_procurement_spend, 50);
      assert.equal(snapshot.checklist.menu_and_costing, true);
    }
  },
  {
    name: 'uses the assigned fulfillment Store inventory instead of Project-level stock',
    run() {
      const snapshot = calculateEventPlanningSnapshot(
        { ...linkedEvent, fulfillment_store_id: 'store-1' },
        [linkedRecipe],
        eventIngredients,
        [
          { site_id: 'site-1', ingredient_id: 'ingredient-main', quantity: 100, unit: 'kg' },
          { site_id: 'store-1', ingredient_id: 'ingredient-main', quantity: 10, unit: 'kg' }
        ]
      );
      assert.equal(snapshot.ingredient_requirements[0].available_stock, 10);
      assert.equal(snapshot.ingredient_requirements[0].shortage_quantity, 40);
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
    name: 'ignores client-controlled handoff linkage when creating a special event',
    run() {
      const payload = buildSpecialEventWritePayload({
        event_name: 'Forged Handoff',
        site_id: 'project-1',
        plan_date: '2026-05-20',
        production_plan_status: 'generated',
        production_plan_ids: ['production-forged'],
        production_generated_at: '2020-01-01T00:00:00.000Z',
        production_generated_by: 'attacker@example.com',
        production_generated_by_name: 'Attacker',
        procurement_pr_status: 'approved',
        procurement_pr_id: 'pr-forged',
        procurement_pr_number: 'PR-FORGED',
        procurement_generated_at: '2020-01-01T00:00:00.000Z',
        procurement_generated_by: 'attacker@example.com',
        procurement_generated_by_name: 'Attacker',
        linked_recipes: [{
          recipe_id: 'recipe-main',
          recipe_name: 'Gala Main Course',
          production_status: 'completed'
        }]
      });

      assert.equal(payload.production_plan_status, 'not_generated');
      assert.deepEqual(payload.production_plan_ids, []);
      assert.equal(payload.production_generated_at, null);
      assert.equal(payload.production_generated_by, null);
      assert.equal(payload.production_generated_by_name, null);
      assert.equal(payload.procurement_pr_status, 'not_created');
      assert.equal(payload.procurement_pr_id, null);
      assert.equal(payload.procurement_pr_number, null);
      assert.equal(payload.procurement_generated_at, null);
      assert.equal(payload.procurement_generated_by, null);
      assert.equal(payload.procurement_generated_by_name, null);
      assert.equal(payload.linked_recipes[0].production_status, 'not_generated');
    }
  },
  {
    name: 'preserves server-owned handoff linkage when updating a special event',
    run() {
      const existing = {
        event_name: 'Existing Event',
        plan_date: '2026-05-20',
        production_plan_status: 'generated',
        production_plan_ids: ['production-1'],
        production_generated_at: '2026-05-19T10:00:00.000Z',
        production_generated_by: 'server@example.com',
        production_generated_by_name: 'Server Actor',
        procurement_pr_status: 'pending',
        procurement_pr_id: 'pr-1',
        procurement_pr_number: 'PR-001',
        procurement_generated_at: '2026-05-19T11:00:00.000Z',
        procurement_generated_by: 'procurement@example.com',
        procurement_generated_by_name: 'Procurement Actor',
        linked_recipes: [{
          recipe_id: 'recipe-main',
          recipe_name: 'Gala Main Course',
          production_status: 'in_progress'
        }]
      };
      const payload = buildSpecialEventWritePayload({
        event_name: 'Updated Event Name',
        production_plan_status: 'not_generated',
        production_plan_ids: ['production-forged'],
        production_generated_at: '2020-01-01T00:00:00.000Z',
        production_generated_by: 'attacker@example.com',
        production_generated_by_name: 'Attacker',
        procurement_pr_status: 'approved',
        procurement_pr_id: 'pr-forged',
        procurement_pr_number: 'PR-FORGED',
        procurement_generated_at: '2020-01-01T00:00:00.000Z',
        procurement_generated_by: 'attacker@example.com',
        procurement_generated_by_name: 'Attacker',
        linked_recipes: [
          {
            recipe_id: 'recipe-main',
            recipe_name: 'Updated Main Course',
            production_status: 'completed'
          },
          {
            recipe_id: 'recipe-new',
            recipe_name: 'New Dish',
            production_status: 'completed'
          }
        ]
      }, existing);

      assert.equal(payload.production_plan_status, 'generated');
      assert.deepEqual(payload.production_plan_ids, ['production-1']);
      assert.notEqual(payload.production_plan_ids, existing.production_plan_ids);
      assert.equal(payload.production_generated_at, '2026-05-19T10:00:00.000Z');
      assert.equal(payload.production_generated_by, 'server@example.com');
      assert.equal(payload.production_generated_by_name, 'Server Actor');
      assert.equal(payload.procurement_pr_status, 'pending');
      assert.equal(payload.procurement_pr_id, 'pr-1');
      assert.equal(payload.procurement_pr_number, 'PR-001');
      assert.equal(payload.procurement_generated_at, '2026-05-19T11:00:00.000Z');
      assert.equal(payload.procurement_generated_by, 'procurement@example.com');
      assert.equal(payload.procurement_generated_by_name, 'Procurement Actor');
      assert.equal(payload.linked_recipes[0].production_status, 'in_progress');
      assert.equal(payload.linked_recipes[1].production_status, 'not_generated');
    }
  },
  {
    name: 'server validates event handoff ownership and supports audited regeneration',
    run() {
      const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
      assert.match(serverSource, /purchaseRequestCandidate\.source_event_id[\s\S]*hydratedRecord\.id/);
      assert.match(serverSource, /purchaseRequestCandidate\.site_id[\s\S]*expectedProcurementSiteId/);
      assert.match(serverSource, /getPurchaseRequestBySourceEventId\(existing\.id, client\)/);
      assert.match(serverSource, /source_event_id: existing\.id/);
      assert.match(serverSource, /site_id: fulfillmentStore\.id/);
      assert.match(serverSource, /PRODUCTION_REOPENED_FROM_SPECIAL_EVENT/);
      assert.match(serverSource, /\['rejected', 'cancelled'\]\.includes\(lockedStatus\)/);
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
