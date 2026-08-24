const DISABLED_ACCOUNT_STATUSES = new Set([
  'deactivated',
  'disabled',
  'inactive',
  'deleted'
]);

const ADMIN_ROLE_KEYS = new Set([
  'admin',
  'super_admin',
  'super_administrator'
]);

function deactivationError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeUserStatus(status) {
  return String(status || 'active').trim().toLowerCase();
}

export function isUserAuthenticationAllowed(user) {
  return Boolean(user) && !DISABLED_ACCOUNT_STATUSES.has(normalizeUserStatus(user.status));
}

export function isAdministratorAccount(user) {
  const accessLevel = String(user?.role_access_level || '').trim().toLowerCase();
  const role = String(user?.role || '').trim().toLowerCase();
  return accessLevel === 'admin' || ADMIN_ROLE_KEYS.has(role);
}

export function isActiveAdministratorAccount(user) {
  return isAdministratorAccount(user) && normalizeUserStatus(user?.status) === 'active';
}

export function assertUserDeactivationAllowed({
  actor,
  target,
  activeAdministratorCount,
  confirmation,
  reason
}) {
  if (!isAdministratorAccount(actor)) {
    throw deactivationError('Only administrators can deactivate user accounts', 403);
  }

  if (!target) {
    throw deactivationError('User not found', 404);
  }

  if (String(actor.id || '') === String(target.id || '')) {
    throw deactivationError('You cannot deactivate your own account', 409);
  }

  if (!isUserAuthenticationAllowed(target)) {
    throw deactivationError('This user account is already deactivated', 409);
  }

  const expectedConfirmation = String(target.email || '').trim().toLowerCase();
  const submittedConfirmation = String(confirmation || '').trim().toLowerCase();
  if (!expectedConfirmation || submittedConfirmation !== expectedConfirmation) {
    throw deactivationError('Type the user email exactly to confirm deactivation', 400);
  }

  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) {
    throw deactivationError('A deactivation reason is required', 400);
  }
  if (normalizedReason.length > 500) {
    throw deactivationError('Deactivation reason must be 500 characters or fewer', 400);
  }

  if (isActiveAdministratorAccount(target) && Number(activeAdministratorCount) <= 1) {
    throw deactivationError('At least one active administrator must remain in the system', 409);
  }

  return { reason: normalizedReason };
}

export { DISABLED_ACCOUNT_STATUSES };
