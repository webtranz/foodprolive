function normalizeAccessLevel(value) {
  return String(value || 'user').trim().toLowerCase();
}

export function canAccessAdvancedReport({
  accessLevel,
  permissions = []
} = {}, allowedAccessLevels = []) {
  if (!Array.isArray(permissions) || !permissions.includes('view_reports')) {
    return false;
  }

  const normalizedAccessLevel = normalizeAccessLevel(accessLevel);
  return (Array.isArray(allowedAccessLevels) ? allowedAccessLevels : [])
    .map(normalizeAccessLevel)
    .includes(normalizedAccessLevel);
}

export const advancedReportAccessInternals = {
  normalizeAccessLevel
};
