import React from 'react';
import PageHeader from '@/components/ui/PageHeader';
import ReportExplorer from '@/components/utilities/ReportExplorer';

export default function ReportsPreview() {
  return <div className="p-4 md:p-8"><PageHeader title="Reports Preview" description="Inspect authorized report data before choosing an export format." /><ReportExplorer allowExports /></div>;
}
