import React from 'react';
import PageHeader from '@/components/ui/PageHeader';
import BulkJobsTable from '@/components/utilities/BulkJobsTable';

export default function BulkUploadProgress() {
  return <div className="p-4 md:p-8"><PageHeader title="Bulk Upload Progress" description="Live status, row counts, and validation errors for background upload jobs." /><BulkJobsTable limit={100} /></div>;
}
