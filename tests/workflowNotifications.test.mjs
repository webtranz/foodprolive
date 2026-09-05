import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildWorkflowNotificationDedupeKey,
  WORKFLOW_NOTIFICATION_DURATION_MS
} from '../src/lib/notificationToast.js';

const layout = fs.readFileSync(new URL('../src/Layout.jsx', import.meta.url), 'utf8');
const toastStore = fs.readFileSync(new URL('../src/components/ui/use-toast.jsx', import.meta.url), 'utf8');
const toaster = fs.readFileSync(new URL('../src/components/ui/toaster.jsx', import.meta.url), 'utf8');

assert.equal(WORKFLOW_NOTIFICATION_DURATION_MS, 5000);

const commonEvent = {
  notification_type: 'workflow',
  action: 'production_area_approved',
  entity: 'Production',
  entity_id: 'production-123',
  workflow_step: 'Production Approved',
  site_id: 'project-384',
  actor_email: 'area.manager@foodpro.com',
  title: 'Production approved',
  message: 'Chicken Jalfrezi was approved and is ready for production.'
};

assert.equal(
  buildWorkflowNotificationDedupeKey({
    ...commonEvent,
    id: 'audit-log-a',
    created_at: '2026-09-02T08:59:36.100Z'
  }),
  buildWorkflowNotificationDedupeKey({
    ...commonEvent,
    id: 'audit-log-b',
    created_at: '2026-09-02T08:59:36.800Z'
  }),
  'duplicate audit rows for one workflow transition must share a toast key'
);
assert.notEqual(
  buildWorkflowNotificationDedupeKey(commonEvent),
  buildWorkflowNotificationDedupeKey({ ...commonEvent, action: 'production_started' }),
  'different workflow transitions must remain visible'
);

assert.match(layout, /duration: WORKFLOW_NOTIFICATION_DURATION_MS/);
assert.match(layout, /dedupeKey: workflow \? buildWorkflowNotificationDedupeKey\(newest\)/);
assert.match(toastStore, /export const DEFAULT_TOAST_DURATION_MS = 5000/);
assert.match(toastStore, /export const DEFAULT_TOAST_DEDUPE_WINDOW_MS = 60000/);
assert.match(toastStore, /scheduleToastRemoval\(id, duration\)/);
assert.match(toastStore, /recentToastKeys\.get\(dedupeKey\)/);
assert.match(toastStore, /recentToastKeys\.set\(dedupeKey, \{ id, shownAt: now \}\)/);
assert.match(toastStore, /dismiss: \(\) => removeToast\(id\)/);
assert.match(toaster, /onClick=\{\(\) => dismiss\(id\)\}/);
assert.match(toaster, /aria-label="Dismiss notification"/);

console.log('PASS workflow notification dismissal and duplicate suppression');
