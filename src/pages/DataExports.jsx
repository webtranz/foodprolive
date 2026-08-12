import React from 'react';
import PageHeader from '@/components/ui/PageHeader';
import ReportExplorer from '@/components/utilities/ReportExplorer';

export default function DataExports() {
  return <div className="p-4 md:p-8"><PageHeader title="CSV / Excel / PDF Reports" description="Preview authorized data and export it in a portable format." /><ReportExplorer allowExports /></div>;
}
