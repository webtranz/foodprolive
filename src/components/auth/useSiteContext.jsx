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

  const isAdmin = currentUser?.role === 'admin';
  // Admins see all sites; others are scoped to their site
  const siteId = isAdmin ? null : (currentUser?.site_id || null);
  const siteName = currentUser?.site_name || null;

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
    return records.filter(r => r.site_id === siteId);
  };

  return { currentUser, siteId, siteName, isAdmin, loading, withSite, filterBySite };
}