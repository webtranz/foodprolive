export const PRODUCTION_STATUS = Object.freeze({
  DRAFT: 'draft',
  CREATED: 'draft',
  PENDING_PM_APPROVAL: 'pending_approval',
  PENDING_PROCUREMENT: 'pending_procurement',
  PENDING_PRODUCTION: 'pending_production',
  READY_TO_START: 'approved',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CHANGES_REQUESTED: 'changes_requested',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
});

export const PRODUCTION_STATUS_LABELS = Object.freeze({
  draft: 'Production Created',
  planned: 'Production Created',
  pending_approval: 'Pending PM Approval',
  pending_procurement: 'Pending Store / Procurement',
  pending_production: 'Pending Area Manager Approval',
  approved: 'Approved / Ready to Start',
  in_progress: 'Production In Progress',
  completed: 'Production Completed',
  changes_requested: 'Changes Requested',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
});

const ALLOWED_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['pending_approval']),
  draft: Object.freeze(['pending_approval']),
  changes_requested: Object.freeze(['pending_approval']),
  pending_approval: Object.freeze(['pending_procurement', 'changes_requested', 'rejected']),
  pending_procurement: Object.freeze(['pending_production']),
  pending_production: Object.freeze(['approved', 'changes_requested', 'rejected']),
  approved: Object.freeze(['in_progress']),
  in_progress: Object.freeze(['completed'])
});

export function normalizeProductionStatus(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

export function getProductionStatusLabel(value) {
  const status = normalizeProductionStatus(value, 'draft');
  return PRODUCTION_STATUS_LABELS[status]
    || status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function isAllowedProductionTransition(currentStatus, nextStatus) {
  const current = normalizeProductionStatus(currentStatus, 'draft');
  const next = normalizeProductionStatus(nextStatus);
  return Boolean(next && ALLOWED_TRANSITIONS[current]?.includes(next));
}

export function getProductionTransitionPermission(currentStatus, nextStatus) {
  const current = normalizeProductionStatus(currentStatus, 'draft');
  const next = normalizeProductionStatus(nextStatus);
  const key = `${current}->${next}`;
  return {
    'planned->pending_approval': 'submit_production_request',
    'draft->pending_approval': 'submit_production_request',
    'changes_requested->pending_approval': 'submit_production_request',
    'pending_approval->pending_procurement': 'approve_production_request',
    'pending_approval->changes_requested': 'request_changes_production',
    'pending_approval->rejected': 'reject_production_request',
    'pending_production->approved': 'approve_production',
    'pending_production->changes_requested': 'request_changes_area_production',
    'pending_production->rejected': 'reject_area_production',
    'approved->in_progress': 'start_production',
    'in_progress->completed': 'complete_production'
  }[key] || null;
}

export function isProductionTerminalStatus(value) {
  return ['completed', 'rejected', 'cancelled'].includes(normalizeProductionStatus(value));
}

export function hasAreaProductionApproval(production) {
  return normalizeProductionStatus(production?.status) === PRODUCTION_STATUS.READY_TO_START
    && String(production?.area_approval_status || '').toLowerCase() === 'approved'
    && Boolean(production?.area_approved_at);
}

export function hasAcknowledgedMaterialRequest(production) {
  return ['acknowledged', 'not_required'].includes(
    String(production?.material_request_status || '').toLowerCase()
  );
}

export function hasAuthoritativeNoMaterialRequirement(production) {
  return Boolean(
    production?.yield_adjustment_applied === true
    && production?.yield_snapshot_source === 'server_recipe_expansion'
    && String(production?.recipe_id || '').trim()
    && Number(production?.target_servings) > 0
    && Array.isArray(production?.ingredients_used)
    && production.ingredients_used.length === 0
  );
}

export function canStartApprovedProduction(production) {
  return hasAreaProductionApproval(production) && hasAcknowledgedMaterialRequest(production);
}

export function requiresAreaProductionApproval(production) {
  const status = normalizeProductionStatus(production?.status);
  return status === PRODUCTION_STATUS.PENDING_PRODUCTION
    || (status === PRODUCTION_STATUS.READY_TO_START && !hasAreaProductionApproval(production));
}
