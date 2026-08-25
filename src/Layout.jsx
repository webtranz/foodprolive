import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import {
  LayoutDashboard,
  Package,
  Building2,
  Utensils,
  Factory,
  Trash2,
  Flame,
  TrendingUp,
  BarChart3,
  Calendar,
  Boxes,
  Menu,
  ChevronRight,
  DollarSign,
  FileText,
  FolderTree,
  Sparkles,
  Zap,
  Database,
  ArrowRight,
  CheckCircle2,
  ShoppingCart,
  QrCode,
  Shield,
  ChefHat,
  MapPin,
  LogOut,
  Cable,
  ShieldAlert,
  Upload,
  Activity
} from 'lucide-react';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { usePermissions } from '@/components/auth/usePermissions';
import { LanguageProvider, useLanguage } from '@/components/i18n/LanguageContext';
import { useAuth } from '@/lib/AuthContext';
import {
  GRANULAR_PAGE_ACCESS_PERMISSION,
  PAGE_ACCESS_PERMISSION_MAP
} from '@/lib/rolePermissions';
import tamimiGlobalLogo from '@/assets/tamimi-global-logo.png';

function filterNavigationItems(items = [], can = () => true, { isAdmin = false } = {}) {
  const usesGranularPageAccess = can(GRANULAR_PAGE_ACCESS_PERMISSION);

  return items.reduce((visibleItems, item) => {
    if (item.adminOnly && !isAdmin) {
      return visibleItems;
    }

    if (usesGranularPageAccess) {
      if (item.href) {
        const pagePermission = PAGE_ACCESS_PERMISSION_MAP[item.href];
        if (!pagePermission || !can(pagePermission)) {
          return visibleItems;
        }
      }
    } else {
      if (item.permission && !can(item.permission)) {
        return visibleItems;
      }

      if (item.permissions && !item.permissions.some((permission) => can(permission))) {
        return visibleItems;
      }
    }

    if (item.children) {
      const visibleChildren = filterNavigationItems(item.children, can, { isAdmin });
      if (!visibleChildren.length) {
        return visibleItems;
      }
      visibleItems.push({
        ...item,
        children: visibleChildren
      });
      return visibleItems;
    }

    visibleItems.push(item);
    return visibleItems;
  }, []);
}

function buildNavigation(t, can = () => true, isAdmin = false) {
  const n = t.nav;
  return filterNavigationItems([
    { name: n.dashboard, href: 'Dashboard', icon: LayoutDashboard },
    { name: n.sites, href: 'Sites', icon: Building2 },
    { name: n.production, href: 'Production', icon: Factory },
    { name: n.foodCost || 'Food Cost', href: 'FoodCost', icon: DollarSign, permission: 'manage_menu_planning' },
    { name: n.ingredients, href: 'Ingredients', icon: Package },
    { name: n.foodCategories || 'Food Categories', href: 'FoodCategories', icon: FolderTree, permission: 'manage_food_categories' },
    { name: n.inventory, href: 'Inventory', icon: Boxes },
    { name: n.recipes, href: 'Recipes', icon: Utensils },
    { name: n.nutritionAllergens, href: 'NutritionAllergen', icon: ShieldAlert },
    { name: n.attendance, href: 'Attendance', icon: QrCode },
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
    { name: n.materialRequests, href: 'MaterialRequests', icon: FileText },
    { name: n.foodWaste, href: 'FoodWaste', icon: Trash2, permission: 'manage_waste' },
    { name: n.yieldCost, href: 'YieldCost', icon: DollarSign },
    {
      name: n.reportsAnalytics,
      icon: BarChart3,
      children: [
        { name: n.reports, href: 'Reports', icon: BarChart3 },
        { name: n.advancedReports, href: 'AdvancedReports', icon: FileText },
        { name: n.forecasting, href: 'Forecasting', icon: TrendingUp },
        { name: n.productionCalculator, href: 'ProductionCalculator', icon: Factory },
        { name: n.caloriesCalculator, href: 'CaloriesCalculator', icon: Flame }
      ]
    },
    { name: n.aiRecipeGenerator, href: 'AIRecipes', icon: Sparkles },
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
    { name: n.d365Integration, href: 'D365Integration', icon: Database },
    { name: n.procurement, href: 'ProcurementModule', icon: ShoppingCart },
    { name: n.posIntegration, href: 'POSIntegration', icon: Cable },
    { name: n.supplierPortal, href: 'SupplierPortal', icon: Building2 },
    { name: n.userRoles, href: 'UserRoleManagement', icon: Shield },
    {
      name: n.utilities || 'Utilities',
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

function NavItem({ item, isActive, onClick }) {
  const [expanded, setExpanded] = useState(false);
  
  if (item.children) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "flex items-center justify-between w-full px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
            "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          )}
        >
          <div className="flex items-center gap-3">
            <item.icon className="w-5 h-5" />
            <span>{item.name}</span>
          </div>
          <ChevronRight className={cn("w-4 h-4 transition-transform", expanded && "rotate-90")} />
        </button>
        {expanded && (
          <div className="ml-8 mt-1 space-y-1">
            {item.children.map(child => (
              <Link
                key={child.href}
                to={createPageUrl(child.href)}
                onClick={onClick}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                  "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                )}
              >
                <child.icon className="w-4 h-4" />
                <span>{child.name}</span>
              </Link>
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
      <main className="lg:pl-72 pt-16 lg:pt-0">
        {children}
      </main>
    </div>
    </LanguageProvider>
  );
}
