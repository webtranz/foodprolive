import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function BulkUploadTemplates() {
  const [errorMessage, setErrorMessage] = useState('');
  const [downloading, setDownloading] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['utility-modules'], queryFn: () => base44.utilities.listModules() });
  const modules = data?.modules || [];

  const download = async (module) => {
    setDownloading(module.key);
    setErrorMessage('');
    try {
      const blob = await base44.utilities.downloadTemplate(module.key);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${module.key}-template.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setErrorMessage(downloadError.message || 'Template download failed.');
    } finally {
      setDownloading('');
    }
  };

  return (
    <div className="p-4 md:p-8">
      <PageHeader title="Bulk Upload Templates" description="Download the exact CSV column structure accepted by each background importer." />
      {(error || errorMessage) && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error?.message || errorMessage}</div>}
      {isLoading ? <div className="text-sm text-slate-500">Loading templates…</div> : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {modules.map((module) => (
            <Card key={module.key}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3"><FileSpreadsheet className="h-5 w-5 text-emerald-600" /><CardTitle className="text-base">{module.label}</CardTitle></div>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-slate-500">{module.headers.length} columns{module.required.length ? ` · Required: ${module.required.join(', ')}` : ' · No mandatory fields'}</p>
                <div className="mb-4 line-clamp-3 text-xs text-slate-400">{module.headers.join(', ')}</div>
                {module.key === 'ingredients' && (
                  <div className="mb-4 space-y-2 text-xs text-slate-500">
                    <p>Includes Basic Info, Weight &amp; Cooking, and Nutrition fields. Legacy columns are still accepted.</p>
                    <p>Conversion example: unit = l, conversion_unit = g, conversion_factor = 920 means 1 litre = 920 grams. Factors must be positive. Raw and cooked weights are in grams per base unit.</p>
                    <p>Use pipes for multiple aliases or allergens, such as maize|sweetcorn. Nutrition values are per 100 g; missing nutrition is treated as zero in recipe calculations.</p>
                    <p>Use Keep existing data to update matching ingredient codes without replacing their records. Blank optional fields do not clear existing data. Enter 0 for zero nutrition, or [] to clear aliases or allergens.</p>
                    <p>When both raw and cooked weights are supplied, omitted yield and shrinkage are calculated automatically.</p>
                  </div>
                )}
                <Button variant="outline" onClick={() => download(module)} disabled={downloading === module.key}>
                  <Download className="mr-2 h-4 w-4" />{downloading === module.key ? 'Downloading…' : 'Download CSV template'}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
