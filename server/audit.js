import { createAuditLog } from './db.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'temporary_password',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'api_secret',
  'authorization'
]);

function isSensitiveKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[-\s]/g, '_');
  return SENSITIVE_KEYS.has(normalized)
    || /(^|_)(password|passwd|token|secret|authorization|api_key)(_|$)/.test(normalized);
}

function redactAuditValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactAuditValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    isSensitiveKey(key)
      ? '[redacted]'
      : redactAuditValue(nested, depth + 1)
  ]));
}

function resolveAuditSite(details = {}) {
  const candidates = [
    details.after,
    details.saved_record,
    details.created_record,
    details.input,
    details.before,
    details.deleted_record,
    details
  ].filter(Boolean);
  const record = candidates.find((candidate) => candidate?.site_id || candidate?.site_name) || {};
  return {
    site_id: record.site_id || null,
    site_name: record.site_name || null
  };
}

export async function auditAction({
  user = null,
  action,
  entity,
  entityId = null,
  siteId = null,
  siteName = null,
  details = {}
}) {
  const inferredSite = resolveAuditSite(details);
  try {
    return await createAuditLog({
      actor_id: user?.id || null,
      actor_email: user?.email || null,
      actor_name: user?.full_name || user?.email || 'System',
      role: user?.role_name || user?.role || 'System',
      action,
      entity,
      entity_id: entityId,
      site_id: siteId || inferredSite.site_id,
      site_name: siteName || inferredSite.site_name,
      details: redactAuditValue({
        at: new Date().toISOString(),
        actor: user ? {
          id: user.id || null,
          email: user.email || null,
          name: user.full_name || null,
          role: user.role_name || user.role || null
        } : null,
        ...details
      })
    });
  } catch (error) {
    console.warn(`Audit logging failed for ${action}: ${error.message}`);
    return null;
  }
}

export { redactAuditValue };
