import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPageUrl } from '@/utils';
import { cn } from '@/lib/utils';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/use-toast';
import {
  Bell,
  LayoutDashboard,
  Package,
  Building2,
  Utensils,
  Factory,
  BarChart3,
  Calendar,
  Boxes,
  Menu,
  ChevronRight,
  DollarSign,
  FileText,
  FolderTree,
  Zap,
  Database,
  ShoppingCart,
  QrCode,
  Trash2,
  Shield,
  ChefHat,
  MapPin,
  LogOut,
  Cable,
  ShieldAlert,
  Upload,
  Activity,
  CheckCircle2,
  ArrowRight
} from 'lucide-react';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { usePermissions } from '@/components/auth/usePermissions';
import { LanguageProvider, useLanguage } from '@/components/i18n/LanguageContext';
import { useAuth } from '@/lib/AuthContext';
import {
  canAccessGranularPage,
  GRANULAR_PAGE_ACCESS_PERMISSION,
} from '@/lib/rolePermissions';
import {
  buildWorkflowNotificationDedupeKey,
  WORKFLOW_NOTIFICATION_DURATION_MS
} from '@/lib/notificationToast';
import tamimiGlobalLogo from '@/assets/tamimi-global-logo.png';

const NOTIFICATION_LAST_SEEN_KEY = 'foodpro_notifications_last_seen_at';

function formatNotificationAction(value) {
  return String(value || 'Activity')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNotificationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
}

function isWorkflowNotification(item = {}) {
  if (item.notification_type === 'workflow') return true;
  if (item.notification_type === 'user_action') return false;
  const action = String(item.action || '').toLowerCase();
  const entity = String(item.entity || '').toLowerCase();
  return /workflow|approval|approved|reject|submitted|acknowledged|production|procurement|bulk_upload|status/.test(action)
    || ['production', 'materialrequest', 'purchaseorder', 'goodsreceipt'].includes(entity);
}

function filterNavigationItems(items = [], can = () => true, { isAdmin = false } = {}) {
  const usesGranularPageAccess = can(GRANULAR_PAGE_ACCESS_PERMISSION);

  return items.reduce((visibleItems, item) => {
    if (item.adminOnly && !isAdmin) {
      return visibleItems;
    }

    let itemAllowed = true;
    if (usesGranularPageAccess) {
      if (item.href) {
        if (!canAccessGranularPage(item.href, can)) {
          itemAllowed = false;
        }
      }
    } else {
      if (item.permission && !can(item.permission)) {
        itemAllowed = false;
      }

      if (item.permissions && !item.permissions.some((permission) => can(permission))) {
        itemAllowed = false;
      }
    }

    if (item.children) {
      const visibleChildren = filterNavigationItems(item.children, can, { isAdmin });
      if (!visibleChildren.length && (!item.href || !itemAllowed)) {
        return visibleItems;
      }
      visibleItems.push({
        ...item,
        href: itemAllowed ? item.href : undefined,
        children: visibleChildren
      });
      return visibleItems;
    }

    if (!itemAllowed) {
      return visibleItems;
    }

    visibleItems.push(item);
    return visibleItems;
  }, []);
}

function hasActiveDescendant(item, currentPath) {
  if (!item?.children?.length) return false;
  return item.children.some((child) => child.href === currentPath || hasActiveDescendant(child, currentPath));
}

function buildNavigation(t, can = () => true, isAdmin = false) {
  const n = t.nav;
  return filterNavigationItems([
    { name: n.dashboard, href: 'Dashboard', icon: LayoutDashboard },
    { name: n.sites, href: 'Sites', icon: Building2 },
    { name: n.budget || 'Budget', href: 'Budget', icon: DollarSign, permissions: ['view_budget', 'manage_budget'] },
    { name: n.inventory, href: 'Inventory', icon: Boxes },
    { name: n.ingredients, href: 'Ingredients', icon: Package },
    { name: n.foodCategories || 'Food Categories', href: 'FoodCategories', icon: FolderTree, permission: 'manage_food_categories' },
    { name: n.recipes, href: 'Recipes', icon: Utensils },
    {
      name: n.menuPlanning,
      icon: Calendar,
      permissions: [
        'manage_menu_planning',
        'create_special_event',
        'edit_special_event',
        'submit_special_event',
        'review_special_event',
        'approve_special_event',
        'reject_special_event'
      ],
      children: [
        { name: n.menu, href: 'Menu', icon: Calendar, permission: 'manage_menu_planning' },
        { name: n.menuPlanningPage, href: 'MenuPlanning', icon: Calendar, permission: 'manage_menu_planning' },
        {
          name: n.eventPlanning,
          href: 'EventPlanning',
          icon: ChefHat,
          permissions: [
            'manage_menu_planning',
            'create_special_event',
            'edit_special_event',
            'submit_special_event',
            'review_special_event',
            'approve_special_event',
            'reject_special_event'
          ]
        },
        { name: n.menuBuilder, href: 'MenuBuilder', icon: Utensils, permission: 'manage_menu_planning' },
        { name: n.autoSchedule, href: 'AutoSchedule', icon: Zap, permission: 'manage_menu_planning' },
      ]
    },
    { name: n.nutritionAllergens, href: 'NutritionAllergen', icon: ShieldAlert },
    { name: n.yieldCost, href: 'YieldCost', icon: DollarSign },
    { name: n.production, href: 'Production', icon: Factory },
    { name: n.foodCost, href: 'FoodCost', icon: DollarSign },
    {
      name: n.attendance,
      icon: QrCode,
      permissions: [
        'view_customer_meal_service',
        'record_customer_meal_service',
        'generate_staff_meal_qr',
        'create_employee_meal_qr'
      ],
      children: [
        {
          name: n.mealService || 'Meal Service',
          href: 'MealService',
          icon: CheckCircle2,
          permissions: [
            'view_customer_meal_service',
            'record_customer_meal_service',
            'generate_staff_meal_qr'
          ]
        },
        {
          name: n.mealQrGenerator || 'Meal QR Generator',
          href: 'MealQRGenerator',
          icon: QrCode,
          permission: 'create_employee_meal_qr'
        }
      ]
    },
    { name: n.foodWaste, href: 'FoodWaste', icon: Trash2 },
    {
      name: n.procurement,
      href: 'ProcurementModule',
      icon: ShoppingCart,
      children: [
        { name: n.materialRequests, href: 'MaterialRequests', icon: FileText },
        { name: n.supplierPortal, href: 'SupplierPortal', icon: Building2 }
      ]
    },
    {
      name: n.cpuManagement,
      icon: Factory,
      children: [
        { name: n.batchTracking, href: 'BatchTracking', icon: Boxes },
        { name: n.qualityControl, href: 'QualityControl', icon: CheckCircle2 },
        { name: n.branchOrders, href: 'BranchOrders', icon: ShoppingCart },
        { name: n.productionTransfer, href: 'ProductionTransfer', icon: ArrowRight }
      ]
    },
    {
      name: n.integrations || 'Integrations',
      icon: Cable,
      children: [
        { name: n.d365Integration, href: 'D365Integration', icon: Database },
        { name: n.posIntegration, href: 'POSIntegration', icon: Cable }
      ]
    },
    { name: n.userRoles, href: 'UserRoleManagement', icon: Shield },
    {
      name: n.utilities || 'Utility Functions',
      icon: Upload,
      children: [
        { name: n.bulkUploadCenter || 'Bulk Upload Center', href: 'BulkUploadCenter', icon: Upload, permission: 'manage_bulk_uploads', adminOnly: true },
        { name: n.bulkUploadTemplates || 'Bulk Upload Templates', href: 'BulkUploadTemplates', icon: FileText, permissions: ['manage_bulk_uploads', 'export_data'] },
        { name: n.dataExports || 'CSV / Excel / PDF Reports', href: 'DataExports', icon: BarChart3, permission: 'export_data' }
      ]
    },
    {
      name: n.activityLogs || 'Activity Logs',
      icon: Activity,
      children: [
        { name: n.auditLogs || 'Audit Logs', href: 'AuditLogs', icon: Shield, permission: 'view_audit_logs' },
        { name: n.bulkUploadProgress || 'Bulk Upload Progress', href: 'BulkUploadProgress', icon: Activity, permission: 'view_bulk_upload_progress' },
        { name: n.reportsPreview || 'Reports Preview', href: 'ReportsPreview', icon: BarChart3, permission: 'view_reports' }
      ]
    }
  ], can, { isAdmin });
}

function LanguageSwitcher() {
  const { lang, setLang, translations } = useLanguage();
  return (
    <div className="flex gap-1 flex-wrap">
      {Object.entries(translations).map(([code, cfg]) => (
        <button
          key={code}
          onClick={() => setLang(code)}
          title={cfg.label}
          className={`text-lg rounded-lg px-1.5 py-0.5 transition-all ${lang === code ? 'bg-emerald-100 ring-1 ring-emerald-400 scale-110' : 'hover:bg-slate-100 opacity-60 hover:opacity-100'}`}
        >
          {cfg.flag}
        </button>
      ))}
    </div>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState(() => localStorage.getItem(NOTIFICATION_LAST_SEEN_KEY) || '');
  const popupReadyRef = useRef(false);
  const lastPopupKeyRef = useRef('');
  const { can } = usePermissions();
  const canViewAuditLogs = can('view_audit_logs');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['activity-notifications'],
    queryFn: () => base44.activity.listNotifications(50),
    refetchInterval: 5000,
    refetchOnWindowFocus: true
  });
  const notifications = data?.notifications || [];
  const lastSeenTime = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  const unreadCount = notifications.filter((item) => {
    const createdTime = new Date(item.created_at).getTime();
    return Number.isFinite(createdTime) && createdTime > lastSeenTime;
  }).length;
  const badgeCount = Math.min(unreadCount, 99);
  const workflowNotifications = notifications.filter(isWorkflowNotification);
  const userActionNotifications = notifications.filter((item) => !isWorkflowNotification(item));
  const orderedSections = [
    { title: 'Workflow Notifications', items: workflowNotifications, tone: 'emerald' },
    { title: 'User Actions', items: userActionNotifications, tone: 'slate' }
  ].filter((section) => section.items.length > 0);
  const groupedCounts = useMemo(() => notifications.reduce((summary, item) => {
    const key = item.entity || 'System';
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {}), [notifications]);

  useEffect(() => {
    const unsubscribe = base44.entities.AuditLog.subscribe(() => {
      refetch();
    });
    return unsubscribe;
  }, [refetch]);

  useEffect(() => {
    const newest = notifications[0];
    if (!newest?.id || !newest?.created_at) return;
    const popupKey = `${newest.id}:${newest.created_at}`;
    if (!popupReadyRef.current) {
      popupReadyRef.current = true;
      lastPopupKeyRef.current = popupKey;
      return;
    }
    if (popupKey === lastPopupKeyRef.current) return;
    lastPopupKeyRef.current = popupKey;
    const createdTime = new Date(newest.created_at).getTime();
    if (!Number.isFinite(createdTime) || createdTime <= lastSeenTime) return;
    const workflow = isWorkflowNotification(newest);
    toast({
      title: workflow ? 'Workflow notification' : 'User action',
      description: newest.message || `${newest.title || formatNotificationAction(newest.action)} · ${newest.site_name || newest.entity || 'Food Pro'}`,
      duration: WORKFLOW_NOTIFICATION_DURATION_MS,
      dedupeKey: workflow ? buildWorkflowNotificationDedupeKey(newest) : `user-action:${newest.id}`
    });
  }, [lastSeenTime, notifications]);

  const handleOpenChange = (nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen || notifications.length === 0) return;
    const newest = notifications[0]?.created_at || new Date().toISOString();
    localStorage.setItem(NOTIFICATION_LAST_SEEN_KEY, newest);
    setLastSeenAt(newest);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative rounded-full text-slate-700 hover:bg-slate-100"
          aria-label="Notifications"
          title="Notifications"
        >
          <Bell className="h-5 w-5" />
          {badgeCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-5 text-white">
              {badgeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,420px)] rounded-xl p-0">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">Notifications</h2>
              <p className="text-xs text-slate-500">Workflow and user activity</p>
            </div>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
              {notifications.length} recent
            </span>
          </div>
          {notifications.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(groupedCounts).slice(0, 4).map(([entity, count]) => (
                <span key={entity} className="rounded-full border border-slate-200 px-2 py-1 text-[11px] text-slate-600">
                  {entity}: {count}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading notifications...</div>
          ) : error ? (
            <div className="p-4 text-sm text-red-700">{error.message || 'Could not load notifications.'}</div>
          ) : notifications.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500">No notifications yet.</div>
          ) : orderedSections.map((section) => (
            <div key={section.title}>
              <div className={cn(
                "sticky top-0 z-10 border-b px-4 py-2 text-xs font-semibold uppercase",
                section.tone === 'emerald'
                  ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                  : "border-slate-100 bg-slate-50 text-slate-600"
              )}>
                {section.title}
              </div>
              {section.items.map((item) => (
                <div key={item.id} className="border-b border-slate-100 px-4 py-3 last:border-b-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {item.title || formatNotificationAction(item.action)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        {item.workflow_step || item.entity || 'System'}{item.site_name || item.site_id ? ` · ${item.site_name || item.site_id}` : ''}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {item.message || `By ${item.actor_name || item.actor_email || 'System'}`}
                      </p>
                    </div>
                    <span className="shrink-0 text-right text-[11px] text-slate-500">
                      {formatNotificationTime(item.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        {canViewAuditLogs ? (
          <div className="border-t border-slate-100 p-3">
            <Link
              to={createPageUrl('AuditLogs')}
              className="block rounded-lg px-3 py-2 text-center text-sm font-medium text-emerald-700 hover:bg-emerald-50"
              onClick={() => setOpen(false)}
            >
              View all activity
            </Link>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function NavItem({ item, isActive, currentPath, onClick }) {
  const hasActiveChild = hasActiveDescendant(item, currentPath);
  const [expanded, setExpanded] = useState(Boolean(hasActiveChild));

  useEffect(() => {
    if (hasActiveChild) {
      setExpanded(true);
    }
  }, [hasActiveChild]);
  
  if (item.children) {
    return (
      <div>
        <div
          className={cn(
            "flex items-center gap-1 rounded-xl transition-all duration-200",
            (isActive || hasActiveChild) ? "bg-emerald-50 text-emerald-700 shadow-sm" : "text-slate-600 hover:bg-slate-100"
          )}
        >
          {item.href ? (
            <Link
              to={createPageUrl(item.href)}
              onClick={onClick}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-sm font-medium hover:text-slate-900"
            >
              <item.icon className={cn("w-5 h-5", (isActive || hasActiveChild) && "text-emerald-600")} />
              <span className="truncate">{item.name}</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm font-medium hover:text-slate-900"
            >
              <item.icon className={cn("w-5 h-5", (isActive || hasActiveChild) && "text-emerald-600")} />
              <span className="truncate">{item.name}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex h-10 w-9 shrink-0 items-center justify-center rounded-r-xl hover:bg-slate-100"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.name}`}
          >
            <ChevronRight className={cn("w-4 h-4 transition-transform", expanded && "rotate-90")} />
          </button>
        </div>
        {expanded && (
          <div className={cn(
            "mt-1 space-y-1",
            "ml-8"
          )}>
            {item.children.map((child, index) => (
              <NavItem
                key={child.href || `${child.name}-${index}`}
                item={child}
                isActive={currentPath === child.href}
                currentPath={currentPath}
                onClick={onClick}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <Link
      to={createPageUrl(item.href)}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
        isActive
          ? "bg-emerald-50 text-emerald-700 shadow-sm"
          : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
      )}
    >
      <item.icon className={cn("w-5 h-5", isActive && "text-emerald-600")} />
      <span>{item.name}</span>
    </Link>
  );
}

function SiteIndicator() {
  const { siteId, siteName, isAdmin, loading } = useSiteContext();
  const { t } = useLanguage();
  if (loading) return null;
  return (
    <div className={`rounded-xl px-3 py-2 flex items-center gap-2 text-xs font-medium ${isAdmin ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
      <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">
        {isAdmin ? t.common.allSitesAdmin : siteName ? `${t.common.site}: ${siteName}` : t.common.noSiteAssigned}
      </span>
    </div>
  );
}

function Sidebar({ onNavigate }) {
  const location = useLocation();
  const currentPath = location.pathname.split('/').pop() || 'Dashboard';
  const { t } = useLanguage();
  const { user, logout } = useAuth();
  const { can, isAdmin } = usePermissions();
  const navigation = buildNavigation(t, can, isAdmin);

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-6 border-b border-slate-100">
        <Link to={createPageUrl('Dashboard')} className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
            <img src={tamimiGlobalLogo} alt="Tamimi Global logo" className="h-full w-full object-contain" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Tamimi Global</h1>
            <p className="text-xs text-slate-500">Catering system</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 p-4">
        <nav className="space-y-1">
          {navigation.map(item => (
            <NavItem
              key={item.name}
              item={item}
              isActive={currentPath === item.href}
              currentPath={currentPath}
              onClick={onNavigate}
            />
          ))}
        </nav>
      </ScrollArea>

      {/* Footer */}
      <div className="p-4 border-t border-slate-100 space-y-3">
        <SiteIndicator />
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-sm font-medium text-slate-900 truncate">{user?.full_name || user?.email || 'Signed in'}</p>
          <p className="text-xs text-slate-500 truncate">{user?.role ? `${user.role} access` : 'Authenticated user'}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-2 border-slate-200 text-slate-700 hover:bg-slate-100"
          onClick={() => {
            logout(true);
            onNavigate?.();
          }}
        >
          <LogOut className="w-4 h-4" />
          <span>Logout</span>
        </Button>
        <LanguageSwitcher />
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl p-4">
          <p className="text-sm font-medium text-emerald-900">{t.common.needHelp}</p>
          <p className="text-xs text-emerald-700 mt-1">{t.common.helpText}</p>
        </div>
      </div>
    </div>
  );
}

export default function Layout({ children }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { logout } = useAuth();

  return (
    <LanguageProvider>
    <div className="min-h-screen bg-slate-50">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-50 lg:flex lg:w-72 lg:flex-col bg-white border-r border-slate-100">
        <Sidebar />
      </aside>

      {/* Desktop Header */}
      <header className="hidden lg:fixed lg:left-72 lg:right-0 lg:top-0 lg:z-40 lg:flex lg:h-14 lg:items-center lg:justify-end lg:border-b lg:border-slate-100 lg:bg-white/95 lg:px-8 lg:backdrop-blur">
        <NotificationBell />
      </header>

      {/* Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-slate-100 px-4 h-16 flex items-center justify-between">
        <Link to={createPageUrl('Dashboard')} className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-amber-200 bg-white shadow-sm">
            <img src={tamimiGlobalLogo} alt="Tamimi Global logo" className="h-full w-full object-contain" />
          </div>
          <div className="leading-tight">
            <span className="block text-sm font-bold text-slate-900">Tamimi Global</span>
            <span className="block text-[10px] text-slate-500">Catering system</span>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          <NotificationBell />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => logout(true)}
            aria-label="Logout"
            title="Logout"
          >
            <LogOut className="w-5 h-5" />
          </Button>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {/* Main Content */}
      <main className="lg:pl-72 pt-16 lg:pt-14">
        {children}
      </main>
    </div>
    </LanguageProvider>
  );
}
