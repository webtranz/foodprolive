export function getUserEffectiveRole(user) {
  const role = user?.role_access_level || user?.role || 'user';
  return ['admin', 'manager', 'user'].includes(role) ? role : 'user';
}

export function hasAdminAccess(user) {
  return getUserEffectiveRole(user) === 'admin';
}

export function assertCanCreateProject(user) {
  return assertCanManageSiteStructure(user);
}

export function assertCanManageSiteStructure(user) {
  if (hasAdminAccess(user)) {
    return true;
  }

  const error = new Error('Only administrators can change the site structure');
  error.status = 403;
  throw error;
}
