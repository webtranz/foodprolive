export const WORKFLOW_NOTIFICATION_DURATION_MS = 5000;

function normalizeNotificationKeyPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildWorkflowNotificationDedupeKey(notification = {}) {
  return [
    'workflow',
    notification.action,
    notification.entity,
    notification.entity_id,
    notification.workflow_step,
    notification.site_id || notification.site_name,
    notification.actor_email || notification.actor_name,
    notification.title,
    notification.message
  ].map(normalizeNotificationKeyPart).join('|');
}
