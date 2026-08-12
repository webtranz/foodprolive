import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Returns the current user's site context.
 * - Admins: site_id is null → they see ALL sites
 * - Other roles: site_id is their assigned site → scoped view
 */
export function useSiteContext() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    base44.auth.me()
      .then(u => { setCurrentUser(u); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const isAdmin = (currentUser?.role_access_level || currentUser?.role) === 'admin';
  const allowedSiteIds = Array.isArray(currentUser?.allowed_site_ids)
    ? currentUser.allowed_site_ids
    : (currentUser?.site_id ? [currentUser.site_id] : []);
  const siteId = isAdmin ? null : (currentUser?.site_id || allowedSiteIds[0] || null);
  const siteName = currentUser?.site_name || null;
  const visibilityScope = currentUser?.visibility_scope || (isAdmin ? 'all_locations' : 'subtree');

  /**
   * Filter a query object to scope to the current user's site.
   * Usage: base44.entities.Production.filter(withSite({ status: 'active' }))
   */
  const withSite = (query = {}) => {
    if (!siteId) return query; // admin: no filter
    return { ...query, site_id: siteId };
  };

  /**
   * Given a list of records, filter to only this user's site.
   */
  const filterBySite = (records = []) => {
    if (!siteId) return records;
    if (allowedSiteIds.length === 0) return records.filter(r => r.site_id === siteId);
    return records.filter((record) => {
      if (record.site_id && allowedSiteIds.includes(record.site_id)) return true;
      if (record.from_site_id && allowedSiteIds.includes(record.from_site_id)) return true;
      if (record.to_site_id && allowedSiteIds.includes(record.to_site_id)) return true;
      if (Array.isArray(record.site_ids) && record.site_ids.some((id) => allowedSiteIds.includes(id))) return true;
      return false;
    });
  };

  return { currentUser, siteId, siteName, allowedSiteIds, visibilityScope, isAdmin, loading, withSite, filterBySite };
}
