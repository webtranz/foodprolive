import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Role Permission Matrix:
 * admin   — full access to everything
 * manager — can create sessions, view reports, manage groups; cannot manage users
 * user    — can only scan QR codes and view attendance dashboard
 */
const PERMISSIONS = {
  admin: [
    'scan_qr', 'view_dashboard', 'view_reports', 'create_session',
    'manage_sessions', 'manage_groups', 'manage_users', 'delete_records',
    'export_data', 'view_ai_waste', 'camera_detection',
  ],
  manager: [
    'scan_qr', 'view_dashboard', 'view_reports', 'create_session',
    'manage_sessions', 'manage_groups', 'export_data', 'view_ai_waste', 'camera_detection',
  ],
  user: [
    'scan_qr', 'view_dashboard',
  ],
};

export function usePermissions() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    base44.auth.me()
      .then(u => { setCurrentUser(u); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const role = currentUser?.role || 'user';
  const permissions = PERMISSIONS[role] || PERMISSIONS.user;
  const can = (permission) => permissions.includes(permission);
  const isAdmin = role === 'admin';
  const isManager = role === 'manager' || role === 'admin';

  return { currentUser, role, can, isAdmin, isManager, loading };
}