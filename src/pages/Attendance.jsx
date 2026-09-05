import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import { CustomerMealServicePanel } from '@/components/attendance/CustomerMealService';
import EmployeeMealQRManager from '@/components/attendance/EmployeeMealQRManager';
import PageHeader from '@/components/ui/PageHeader';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { SITE_HIERARCHY_TYPES, normalizeSiteType } from '../../shared/siteHierarchy.js';

export const FOOD_CONSUMPTION_SECTIONS = Object.freeze({
  MEAL_SERVICE: 'meal-service',
  MEAL_QR_GENERATOR: 'meal-qr-generator'
});

function normalizeFoodConsumptionSection(section) {
  return section === FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR
    ? FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR
    : FOOD_CONSUMPTION_SECTIONS.MEAL_SERVICE;
}

export default function Attendance({ section = FOOD_CONSUMPTION_SECTIONS.MEAL_SERVICE }) {
  const activeSection = normalizeFoodConsumptionSection(section);
  const { can, isAdmin, loading: permissionLoading } = usePermissions();
  const canConfirm = can('record_customer_meal_service');
  const canGenerateCoversQr = isAdmin || can('generate_staff_meal_qr');
  const canCreateEmployeeMealQr = isAdmin || can('create_employee_meal_qr');
  const canViewMealService = isAdmin || canConfirm || can('view_customer_meal_service') || canGenerateCoversQr;
  const canViewMealQrGenerator = canCreateEmployeeMealQr;
  const canView = activeSection === FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR
    ? canViewMealQrGenerator
    : canViewMealService;
  const sitesQuery = useQuery({
    queryKey: ['sites', 'mealService'],
    queryFn: () => base44.entities.Site.list(),
    enabled: activeSection === FOOD_CONSUMPTION_SECTIONS.MEAL_SERVICE && canViewMealService
  });
  const projectOptions = useMemo(() => (
    (sitesQuery.data || [])
      .filter((site) => site.is_active !== false && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT)
      .sort((left, right) => String(left.hierarchy_path || left.name || '').localeCompare(String(right.hierarchy_path || right.name || '')))
  ), [sitesQuery.data]);
  const pageDescription = activeSection === FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR
    ? 'Create and manage staff meal QR codes.'
    : "Save meal covers against the day's fully produced dishes.";
  const accessTitle = activeSection === FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR
    ? 'Meal QR Generator access is required'
    : 'Meal Service access is required';
  const accessDescription = activeSection === FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR
    ? 'Ask an administrator to grant the meal QR generator permission for this workspace.'
    : 'Ask an administrator to grant the view or record permission for this workspace.';

  if (permissionLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading Food Consumption...
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-[1680px] space-y-6">
          <PageHeader
            title="Food Consumption"
            description={pageDescription}
          />
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">{accessTitle}</p>
              <p className="mt-1 text-sm">{accessDescription}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1680px] space-y-6">
        <PageHeader
          title="Food Consumption"
          description={pageDescription}
        />

        {activeSection === FOOD_CONSUMPTION_SECTIONS.MEAL_QR_GENERATOR ? (
          <EmployeeMealQRManager canCreate={canCreateEmployeeMealQr} />
        ) : sitesQuery.isLoading ? (
          <div className="flex min-h-[320px] items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading accessible projects...
          </div>
        ) : sitesQuery.isError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
            {sitesQuery.error?.message || 'Accessible projects could not be loaded.'}
          </div>
        ) : projectOptions.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
            <p className="font-medium text-slate-900">No accessible projects</p>
            <p className="mt-1 text-sm text-slate-500">A project assignment is required before Food Consumption can be saved.</p>
          </div>
        ) : (
          <CustomerMealServicePanel
            locationOptions={projectOptions}
            isAdmin={isAdmin}
            canConfirm={canConfirm}
            canGenerateCoversQr={canGenerateCoversQr}
          />
        )}
      </div>
    </div>
  );
}
