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
  BarChart3,
  Calendar,
  Boxes,
  Menu,
  ChevronRight,
  DollarSign,
  FileText,
  Sparkles,
  Zap,
  Database,
  ArrowRight,
  CheckCircle2,
  ShoppingCart,
  QrCode,
  Shield,
  ChefHat,
  MapPin
} from 'lucide-react';
import { useSiteContext } from '@/components/auth/useSiteContext';
import { LanguageProvider, useLanguage } from '@/components/i18n/LanguageContext';

function buildNavigation(t) {
  const n = t.nav;
  return [
    { name: n.dashboard, href: 'Dashboard', icon: LayoutDashboard },
    { name: n.sites, href: 'Sites', icon: Building2 },
    { name: n.ingredients, href: 'Ingredients', icon: Package },
    { name: n.recipes, href: 'Recipes', icon: Utensils },
    { name: n.attendance, href: 'Attendance', icon: QrCode },
    {
      name: n.menuPlanning,
      icon: Calendar,
      children: [
        { name: n.menu, href: 'Menu', icon: Calendar },
        { name: n.menuPlanningPage, href: 'MenuPlanning', icon: Calendar },
        { name: n.eventPlanning, href: 'EventPlanning', icon: ChefHat },
        { name: n.menuBuilder, href: 'MenuBuilder', icon: Utensils },
        { name: n.autoSchedule, href: 'AutoSchedule', icon: Zap },
      ]
    },
    { name: n.production, href: 'Production', icon: Factory },
    { name: n.materialRequests, href: 'MaterialRequests', icon: FileText },
    { name: n.foodWaste, href: 'FoodWaste', icon: Trash2 },
    { name: n.yieldCost, href: 'YieldCost', icon: DollarSign },
    {
      name: n.reportsAnalytics,
      icon: BarChart3,
      children: [
        { name: n.reports, href: 'Reports', icon: BarChart3 },
        { name: n.advancedReports, href: 'AdvancedReports', icon: FileText },
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
    { name: n.supplierPortal, href: 'SupplierPortal', icon: Building2 },
    { name: n.userRoles, href: 'UserRoleManagement', icon: Shield }
  ];
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
  const navigation = buildNavigation(t);

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-6 border-b border-slate-100">
        <Link to={createPageUrl('Dashboard')} className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Utensils className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">FoodPro</h1>
            <p className="text-xs text-slate-500">Production Manager</p>
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
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <Utensils className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-slate-900">FoodPro</span>
        </Link>
        
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
      </header>

      {/* Main Content */}
      <main className="lg:pl-72 pt-16 lg:pt-0">
        {children}
      </main>
    </div>
    </LanguageProvider>
  );
}