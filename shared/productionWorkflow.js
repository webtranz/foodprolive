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
  planned: Object.freeze(['pending_approval', 'cancelled']),
  draft: Object.freeze(['pending_approval', 'cancelled']),
  changes_requested: Object.freeze(['pending_approval', 'cancelled']),
  pending_approval: Object.freeze(['pending_procurement', 'changes_requested', 'cancelled']),
  pending_procurement: Object.freeze(['pending_production', 'cancelled']),
  pending_production: Object.freeze(['approved', 'pending_procurement', 'changes_requested', 'cancelled']),
  approved: Object.freeze(['pending_procurement', 'in_progress', 'cancelled']),
  in_progress: Object.freeze(['completed'])
});

const PRODUCTION_HISTORY_ACTION_LABELS = Object.freeze({
  submitted: 'Submitted for PM Approval',
  submitted_for_approval: 'Submitted for PM Approval',
  pm_approved: 'Project Manager Approved',
  project_manager_approved: 'Project Manager Approved',
  pm_rejected: 'Project Manager Rejected & Returned',
  project_manager_rejected: 'Project Manager Rejected & Returned',
  area_approved: 'Area Manager Approved',
  area_manager_approved: 'Area Manager Approved',
  area_rejected: 'Area Manager Rejected & Returned',
  area_manager_rejected: 'Area Manager Rejected & Returned',
  rejected: 'Rejected & Returned',
  changes_requested: 'Changes Requested',
  production_started: 'Production Started',
  started: 'Production Started',
  production_completed: 'Production Completed',
  completed: 'Production Completed',
  inventory_committed: 'Inventory Committed at Area Approval',
  inventory_reconciled: 'Inventory Commitment Reconciled',
  inventory_released: 'Committed Inventory Returned',
  production_cancelled: 'Production Cancelled',
  cancelled: 'Production Cancelled'
});

function normalizeHistoryAction(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function productionRecordMatchesScope(production, accessibleSiteIds) {
  if (!Array.isArray(accessibleSiteIds) || accessibleSiteIds.length === 0) return true;
  const scope = new Set(accessibleSiteIds.map(String));
  return [production?.site_id, production?.fulfillment_store_id]
    .filter(Boolean)
    .some((siteId) => scope.has(String(siteId)));
}

function normalizeApprovalHistoryEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  const action = normalizeHistoryAction(
    entry.action || entry.review_action || entry.event || entry.type
  );
  const timestamp = entry.timestamp
    || entry.action_at
    || entry.performed_at
    || entry.created_at
    || entry.date
    || null;
  const actorName = entry.actor_name
    || entry.user_name
    || entry.performed_by_name
    || entry.reviewed_by_name
    || entry.actor
    || null;
  const actorEmail = entry.actor_email
    || entry.user_email
    || entry.performed_by
    || entry.reviewed_by
    || null;
  const reason = entry.reason
    || entry.rejection_reason
    || entry.note
    || entry.notes
    || entry.review_notes
    || null;

  if (!action && !timestamp && !actorName && !actorEmail && !reason) return null;
  return {
    id: entry.id || `${action || 'workflow'}-${timestamp || index}`,
    action,
    action_label: entry.action_label
      || PRODUCTION_HISTORY_ACTION_LABELS[action]
      || getProductionStatusLabel(action || 'workflow_action'),
    actor_name: actorName,
    actor_email: actorEmail,
    timestamp,
    reason,
    from_status: normalizeProductionStatus(entry.from_status),
    to_status: normalizeProductionStatus(entry.to_status)
  };
}

function addScalarHistoryEntry(entries, entry) {
  if (!entry?.timestamp && !entry?.actor_name && !entry?.actor_email) return;
  const normalized = normalizeApprovalHistoryEntry(entry, entries.length);
  if (!normalized) return;
  const duplicate = entries.some((existing) => (
    existing.action === normalized.action
    && existing.timestamp === normalized.timestamp
    && existing.actor_email === normalized.actor_email
  ));
  if (!duplicate) entries.push(normalized);
}

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

export function getProductionTransitionPermission(currentStatus, nextStatus, options = {}) {
  const current = normalizeProductionStatus(currentStatus, 'draft');
  const next = normalizeProductionStatus(nextStatus);
  const reviewAction = normalizeHistoryAction(
    typeof options === 'string' ? options : options?.reviewAction || options?.review_action
  );
  const key = `${current}->${next}`;
  if (next === PRODUCTION_STATUS.CANCELLED && canCancelProduction(current)) {
    return 'cancel_production';
  }
  if (reviewAction === 'rejected') {
    if (current === 'pending_approval' && next === 'changes_requested') {
      return 'reject_production_request';
    }
    if (
      ['pending_production', 'approved'].includes(current)
      && next === 'pending_procurement'
    ) {
      return 'reject_area_production';
    }
  }
  return {
    'planned->pending_approval': 'submit_production_request',
    'draft->pending_approval': 'submit_production_request',
    'changes_requested->pending_approval': 'submit_production_request',
    'pending_approval->pending_procurement': 'approve_production_request',
    'pending_approval->changes_requested': 'request_changes_production',
    'pending_production->approved': 'approve_production',
    'pending_production->pending_procurement': 'reject_area_production',
    'pending_production->changes_requested': 'request_changes_area_production',
    'approved->pending_procurement': 'reject_area_production',
    'approved->in_progress': 'start_production',
    'in_progress->completed': 'complete_production'
  }[key] || null;
}

export function canCancelProduction(value) {
  const status = normalizeProductionStatus(
    typeof value === 'object' ? value?.status : value,
    'draft'
  );
  return [
    'planned',
    PRODUCTION_STATUS.DRAFT,
    PRODUCTION_STATUS.CHANGES_REQUESTED,
    PRODUCTION_STATUS.PENDING_PM_APPROVAL,
    PRODUCTION_STATUS.PENDING_PROCUREMENT,
    PRODUCTION_STATUS.PENDING_PRODUCTION,
    PRODUCTION_STATUS.READY_TO_START
  ].includes(status);
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

export function getProductionStartBlockReason(production) {
  if (requiresAreaProductionApproval(production)) {
    return 'Production cannot start while Area Manager approval is pending.';
  }
  if (normalizeProductionStatus(production?.status) !== PRODUCTION_STATUS.READY_TO_START) {
    return 'Production is not approved and ready to start.';
  }
  if (!hasAcknowledgedMaterialRequest(production)) {
    return 'Production cannot start until Store / Procurement acknowledges the material request.';
  }
  return '';
}

export function requiresAreaProductionApproval(production) {
  const status = normalizeProductionStatus(production?.status);
  return status === PRODUCTION_STATUS.PENDING_PRODUCTION
    || (status === PRODUCTION_STATUS.READY_TO_START && !hasAreaProductionApproval(production));
}

export function getProductionRejectionReturnStatus(currentStatus) {
  const status = normalizeProductionStatus(currentStatus);
  if (status === PRODUCTION_STATUS.PENDING_PM_APPROVAL) {
    return PRODUCTION_STATUS.CHANGES_REQUESTED;
  }
  if (
    status === PRODUCTION_STATUS.PENDING_PRODUCTION
    || status === PRODUCTION_STATUS.READY_TO_START
  ) {
    return PRODUCTION_STATUS.PENDING_PROCUREMENT;
  }
  return '';
}

export function getPendingAreaApprovalProductions(productions = [], accessibleSiteIds = []) {
  return (Array.isArray(productions) ? productions : [])
    .filter((production) => (
      requiresAreaProductionApproval(production)
      && productionRecordMatchesScope(production, accessibleSiteIds)
    ))
    .sort((left, right) => {
      const dateComparison = String(left?.production_date || '9999-12-31')
        .localeCompare(String(right?.production_date || '9999-12-31'));
      if (dateComparison !== 0) return dateComparison;
      return String(left?.created_date || left?.created_at || left?.id || '')
        .localeCompare(String(right?.created_date || right?.created_at || right?.id || ''));
    });
}

export function getProductionApprovalHistory(production) {
  const rawHistory = [
    ...(Array.isArray(production?.approval_history) ? production.approval_history : []),
    ...(Array.isArray(production?.workflow_history) ? production.workflow_history : []),
    ...(Array.isArray(production?.review_history) ? production.review_history : [])
  ];
  const entries = rawHistory
    .map(normalizeApprovalHistoryEntry)
    .filter(Boolean);

  addScalarHistoryEntry(entries, {
    action: 'submitted',
    actor_name: production?.submitted_by_name,
    actor_email: production?.submitted_by,
    timestamp: production?.submitted_at
  });
  if (String(production?.pm_approval_status || '').toLowerCase() === 'approved') {
    addScalarHistoryEntry(entries, {
      action: 'pm_approved',
      actor_name: production?.pm_approved_by_name,
      actor_email: production?.pm_approved_by,
      timestamp: production?.pm_approved_at
    });
  }
  if (String(production?.area_approval_status || '').toLowerCase() === 'approved') {
    addScalarHistoryEntry(entries, {
      action: 'area_approved',
      actor_name: production?.area_approved_by_name,
      actor_email: production?.area_approved_by,
      timestamp: production?.area_approved_at
    });
  }
  if (String(production?.pm_approval_status || '').toLowerCase() === 'rejected') {
    addScalarHistoryEntry(entries, {
      action: 'pm_rejected',
      actor_name: production?.pm_reviewed_by_name,
      actor_email: production?.pm_reviewed_by,
      timestamp: production?.pm_reviewed_at || production?.reviewed_at,
      reason: production?.rejection_reason || production?.review_notes
    });
  }
  if (String(production?.area_approval_status || '').toLowerCase() === 'rejected') {
    addScalarHistoryEntry(entries, {
      action: 'area_rejected',
      actor_name: production?.area_reviewed_by_name,
      actor_email: production?.area_reviewed_by,
      timestamp: production?.area_reviewed_at || production?.reviewed_at,
      reason: production?.rejection_reason || production?.review_notes
    });
  }

  const uniqueEntries = entries.filter((entry, index, history) => (
    history.findIndex((candidate) => (
      candidate.action === entry.action
      && candidate.timestamp === entry.timestamp
      && candidate.actor_email === entry.actor_email
    )) === index
  ));

  return uniqueEntries.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || '') || 0;
    const rightTime = Date.parse(right.timestamp || '') || 0;
    return leftTime - rightTime;
  });
}

export function getProductionReviewNotice(production) {
  const history = getProductionApprovalHistory(production);
  const latestEntry = history[history.length - 1] || null;
  const latestReview = latestEntry
    && (latestEntry.action.includes('rejected') || latestEntry.action === 'changes_requested')
    ? latestEntry
    : null;
  const explicitAction = normalizeHistoryAction(
    production?.last_review_action || production?.review_action
  );
  const reviewStage = normalizeHistoryAction(
    production?.rejection_stage || production?.last_review_stage || production?.review_stage
  );
  const status = normalizeProductionStatus(production?.status);
  const areaRejected = (
    String(production?.area_approval_status || '').toLowerCase() === 'rejected'
    && status === PRODUCTION_STATUS.PENDING_PROCUREMENT
  )
    || ['area_rejected', 'area_manager_rejected'].includes(explicitAction)
    || ['area_rejected', 'area_manager_rejected'].includes(latestReview?.action)
    || (
      explicitAction === 'rejected'
      && (reviewStage === 'area_manager' || status === PRODUCTION_STATUS.PENDING_PROCUREMENT)
    );
  const pmRejected = (
    String(production?.pm_approval_status || '').toLowerCase() === 'rejected'
    && status === PRODUCTION_STATUS.CHANGES_REQUESTED
  )
    || ['pm_rejected', 'project_manager_rejected'].includes(explicitAction)
    || ['pm_rejected', 'project_manager_rejected'].includes(latestReview?.action);
  const rejected = ['rejected', 'pm_rejected', 'project_manager_rejected', 'area_rejected', 'area_manager_rejected'].includes(explicitAction)
    || areaRejected
    || pmRejected
    || latestReview?.action === 'rejected';
  const reason = production?.rejection_reason
    || latestReview?.reason
    || (rejected ? production?.review_notes : null);

  if (rejected && areaRejected) {
    return {
      action: 'rejected',
      label: 'Area Manager rejected this request and returned it to Store / Procurement.',
      reason: reason || 'No rejection reason was recorded.'
    };
  }
  if (rejected) {
    return {
      action: 'rejected',
      label: 'Project Manager rejected this request and returned it for changes.',
      reason: reason || 'No rejection reason was recorded.'
    };
  }
  if (
    status === PRODUCTION_STATUS.CHANGES_REQUESTED
    && (explicitAction === 'changes_requested' || latestReview?.action === 'changes_requested')
    && production?.review_notes
  ) {
    return {
      action: 'changes_requested',
      label: 'Changes were requested before this production can continue.',
      reason: production.review_notes
    };
  }
  return null;
}
