const ADMIN_ROLE_KEYS = new Set([
  'admin',
  'super_admin',
  'super_administrator'
]);

export const ADMIN_ONLY_BULK_UPLOAD_PAGES = Object.freeze([
  'BulkUploadCenter'
]);

export const ADMIN_ONLY_BULK_UPLOAD_PERMISSION_KEYS = Object.freeze([
  'access_bulk_upload_center',
  'manage_bulk_uploads'
]);

export const STANDARD_USER_GROUP_MEMBER_CHANGE_LIMIT = 25;

const ADMIN_ONLY_PAGE_SET = new Set(ADMIN_ONLY_BULK_UPLOAD_PAGES);
const ADMIN_ONLY_PERMISSION_SET = new Set(ADMIN_ONLY_BULK_UPLOAD_PERMISSION_KEYS);

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

export function hasAdministratorAccess(identity = {}) {
  const explicitAccessLevel = identity.role_access_level ?? identity.access_level;
  const accessLevel = normalizeToken(explicitAccessLevel);
  const role = normalizeToken(identity.role ?? identity.role_key);
  if (explicitAccessLevel !== undefined && explicitAccessLevel !== null && accessLevel) {
    return accessLevel === 'admin';
  }
  return ADMIN_ROLE_KEYS.has(role);
}

export function assertBulkUploadAdministrator(identity = {}) {
  if (hasAdministratorAccess(identity)) return true;
  const error = Object.assign(
    new Error('Only administrators can perform bulk uploads.'),
    { status: 403 }
  );
  throw error;
}

export function isAdminOnlyBulkUploadPage(pageName) {
  return ADMIN_ONLY_PAGE_SET.has(String(pageName || ''));
}

export function filterBulkUploadPermissionsForAccessLevel(permissions = [], accessLevel = 'user') {
  const normalizedPermissions = Array.from(new Set((permissions || []).filter(Boolean)));
  if (normalizeToken(accessLevel) === 'admin') {
    return normalizedPermissions;
  }
  return normalizedPermissions.filter((permission) => !ADMIN_ONLY_PERMISSION_SET.has(permission));
}

export function getDisallowedBulkUploadPermissions(profile = {}) {
  if (hasAdministratorAccess(profile)) return [];
  return Array.from(new Set((profile.permissions || []).filter((permission) => (
    ADMIN_ONLY_PERMISSION_SET.has(permission)
  ))));
}

export function isBulkInventoryUpload(payload = {}) {
  return normalizeToken(payload.reason_code) === 'bulk_upload';
}

function normalizeUserGroupMember(member = {}) {
  return {
    user_id: String(member.user_id || '').trim(),
    name: String(member.name || '').trim(),
    email: normalizeToken(member.email),
    phone: String(member.phone || '').trim(),
    category: normalizeToken(member.category || 'labor')
  };
}

function userGroupMemberKey(member = {}, index = 0) {
  const normalized = normalizeUserGroupMember(member);
  return normalized.user_id
    || normalized.email
    || normalized.phone
    || `${normalized.name.toLowerCase()}|${normalized.category}|${index}`;
}

export function countUserGroupMemberChanges(existingMembers = [], nextMembers = []) {
  const existingByKey = new Map(
    (Array.isArray(existingMembers) ? existingMembers : []).map((member, index) => [
      userGroupMemberKey(member, index),
      normalizeUserGroupMember(member)
    ])
  );

  return (Array.isArray(nextMembers) ? nextMembers : []).reduce((changes, member, index) => {
    const normalized = normalizeUserGroupMember(member);
    const existing = existingByKey.get(userGroupMemberKey(member, index));
    return changes + (!existing || JSON.stringify(existing) !== JSON.stringify(normalized) ? 1 : 0);
  }, 0);
}

export function assertStandardUserGroupMemberEdit(identity = {}, payload = {}, existing = null) {
  if (hasAdministratorAccess(identity) || !Object.prototype.hasOwnProperty.call(payload || {}, 'members')) {
    return true;
  }
  if (!Array.isArray(payload.members)) {
    const error = Object.assign(new Error('User group members must be an array.'), { status: 400 });
    throw error;
  }

  const changedMembers = countUserGroupMemberChanges(existing?.members, payload.members);
  if (changedMembers <= STANDARD_USER_GROUP_MEMBER_CHANGE_LIMIT) return true;

  const error = Object.assign(
    new Error(`Adding or changing more than ${STANDARD_USER_GROUP_MEMBER_CHANGE_LIMIT} group members requires the Administrator bulk-upload action.`),
    { status: 403 }
  );
  throw error;
}
