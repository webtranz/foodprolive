import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Upload } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import BulkJobsTable from '@/components/utilities/BulkJobsTable';
import PageHeader from '@/components/ui/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SOURCE_NAME_OPTIONS } from '../../shared/sourceNames.js';
import { getMenuCategoryOptions, MENU_CUISINE_OPTIONS } from '../../shared/menuCategories.js';

const IMPORT_MODES = [
  { value: 'keep_existing', label: 'Keep existing data', description: 'Adds valid new records and skips duplicates.' },
  { value: 'update_stock_only', label: 'Update stock only', description: 'Keeps item master data unchanged and refreshes stock quantities from the file.' },
  { value: 'replace_existing', label: 'Replace existing data', description: 'Validates the whole file, then replaces authorized records.' },
  { value: 'delete_existing', label: 'Delete existing data', description: 'Deletes authorized records without importing a file.' }
];

const RECIPE_TYPE_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'filipino', label: 'Filipino' }
];

function normalizeCsvHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseCsvHeaderLine(line = '') {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

function detectModuleFromHeaders(headers = [], modules = []) {
  const incoming = new Set(headers.map(normalizeCsvHeader).filter(Boolean));
  if (!incoming.size) return null;

  const rankedModules = modules
    .map((module) => {
      const moduleHeaders = (module.headers || []).map(normalizeCsvHeader);
      const requiredHeaders = (module.required || []).map(normalizeCsvHeader);
      const matchedHeaders = moduleHeaders.filter((header) => incoming.has(header)).length;
      const matchedRequired = requiredHeaders.filter((header) => incoming.has(header)).length;
      const exactShape = moduleHeaders.length === incoming.size
        && moduleHeaders.every((header) => incoming.has(header));
      return {
        module,
        score: matchedHeaders + (matchedRequired * 5) + (exactShape ? 100 : 0)
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!rankedModules.length) return null;
  if (rankedModules[1] && rankedModules[0].score === rankedModules[1].score) return null;
  return rankedModules[0].module;
}

function readCsvFirstLine(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      resolve(text.split(/\r?\n/)[0] || '');
    };
    reader.onerror = () => reject(reader.error || new Error('Unable to inspect CSV file.'));
    reader.readAsText(file.slice(0, 8192));
  });
}

export default function BulkUploadCenter() {
  const { isAdmin, loading: permissionLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [moduleKey, setModuleKey] = useState('');
  const [importMode, setImportMode] = useState('keep_existing');
  const [siteId, setSiteId] = useState('all');
  const [sourceName, setSourceName] = useState('');
  const [recipeType, setRecipeType] = useState('general');
  const [menuCuisine, setMenuCuisine] = useState('general');
  const [menuCategory, setMenuCategory] = useState('senior');
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [fileModuleNotice, setFileModuleNotice] = useState('');
  const [detectedModuleKey, setDetectedModuleKey] = useState('');
  const modulesQuery = useQuery({ queryKey: ['utility-modules'], queryFn: () => base44.utilities.listModules(), enabled: isAdmin });
  const sitesQuery = useQuery({ queryKey: ['bulk-upload-sites'], queryFn: () => base44.entities.Site.list('name', 2000), enabled: isAdmin });
  const modules = modulesQuery.data?.modules || [];
  const sites = Array.isArray(sitesQuery.data) ? sitesQuery.data : [];

  useEffect(() => {
    if (!moduleKey && modules.length) setModuleKey(modules[0].key);
  }, [moduleKey, modules]);

  const selectedModule = useMemo(() => modules.find((item) => item.key === moduleKey), [moduleKey, modules]);
  const selectedMode = IMPORT_MODES.find((item) => item.value === importMode);
  const isStockUpdateOnly = importMode === 'update_stock_only';
  const isStockUploadModule = ['Ingredient', 'Inventory'].includes(selectedModule?.entity);
  const isRecipeModule = selectedModule?.entity === 'Recipe';
  const isMenuPlanModule = selectedModule?.entity === 'MenuPlan';
  const menuCategoryOptions = useMemo(() => getMenuCategoryOptions(menuCuisine), [menuCuisine]);
  const isSiteScoped = selectedModule?.headers?.includes('site_id') || (isStockUpdateOnly && selectedModule?.entity === 'Ingredient');
  const requiresSourceName = ['Ingredient', 'Inventory'].includes(selectedModule?.entity) && importMode !== 'delete_existing';
  const selectedModeDescription = selectedModule?.entity === 'Inventory'
    ? {
        keep_existing: 'Refreshes stock from the uploaded snapshot and preserves movement history.',
        update_stock_only: 'Keeps inventory and ingredient master data unchanged, then updates only the stock quantity differences.',
        replace_existing: 'Deletes selected inventory records and open lots, then imports this file as fresh receipt lots.',
        delete_existing: 'Deletes selected inventory records and open lots from the chosen scope.'
      }[importMode] || selectedMode?.description
    : selectedModule?.entity === 'Ingredient'
      ? {
          keep_existing: 'Creates or updates ingredient master data and skips unsupported duplicate conflicts.',
          update_stock_only: 'Matches existing ingredients from the file and updates only stock quantities for the selected project scope. The CSV must include quantity and unit.'
        }[importMode] || selectedMode?.description
    : selectedMode?.description;

  useEffect(() => {
    if (!isSiteScoped) setSiteId('all');
  }, [isSiteScoped]);

  useEffect(() => {
    if (importMode === 'update_stock_only' && selectedModule && !isStockUploadModule) {
      setImportMode('keep_existing');
    }
  }, [importMode, isStockUploadModule, selectedModule]);

  useEffect(() => {
    if (!requiresSourceName) setSourceName('');
  }, [requiresSourceName]);

  useEffect(() => {
    if (!isMenuPlanModule) return;
    if (!menuCategoryOptions.some((option) => option.value === menuCategory)) {
      setMenuCategory(menuCategoryOptions[0]?.value || 'senior');
    }
  }, [isMenuPlanModule, menuCategory, menuCategoryOptions]);

  const handleFileChange = async (event) => {
    const selectedFile = event.target.files?.[0] || null;
    setFile(selectedFile);
    setMessage('');
    setErrorMessage('');
    setFileModuleNotice('');
    setDetectedModuleKey('');
    if (!selectedFile || !modules.length) return;

    try {
      const firstLine = await readCsvFirstLine(selectedFile);
      const detectedModule = detectModuleFromHeaders(parseCsvHeaderLine(firstLine), modules);
      if (!detectedModule) return;
      setDetectedModuleKey(detectedModule.key);
      if (detectedModule.key !== moduleKey) {
        setModuleKey(detectedModule.key);
        setFileModuleNotice(`Detected ${detectedModule.label} template and selected it automatically.`);
      }
    } catch {
      setFileModuleNotice('Could not inspect CSV headers. Confirm the selected module matches the template before uploading.');
    }
  };

  const submitMutation = useMutation({
    mutationFn: () => {
      if (!isAdmin) throw new Error('Only administrators can perform bulk uploads.');
      const selectedSite = sites.find((site) => site.id === siteId);
      return base44.utilities.submitBulkUpload({
        module: moduleKey,
        import_mode: importMode,
        file: importMode === 'delete_existing' ? null : file,
        site_id: isSiteScoped && siteId !== 'all' ? siteId : '',
        site_name: selectedSite?.name || '',
        source_name: requiresSourceName ? sourceName : '',
        recipe_type: isRecipeModule ? recipeType : '',
        menu_cuisine: isMenuPlanModule ? menuCuisine : '',
        menu_category: isMenuPlanModule ? menuCategory : ''
      });
    },
    onSuccess: (result) => {
      setMessage(`Upload job ${result.job.id} was queued. You can continue using Food Pro while it runs.`);
      setErrorMessage('');
      setFile(null);
      queryClient.invalidateQueries({ queryKey: ['bulk-upload-jobs'] });
    },
    onError: (error) => {
      setMessage('');
      setErrorMessage(error.message || 'The upload job could not be created.');
    }
  });

  const submit = (event) => {
    event.preventDefault();
    setMessage('');
    setErrorMessage('');
    if (!isAdmin) return setErrorMessage('Only administrators can perform bulk uploads.');
    if (!moduleKey) return setErrorMessage('Select a module.');
    if (isStockUpdateOnly && !isStockUploadModule) return setErrorMessage('Update stock only is available for Inventory and Ingredients uploads.');
    if (isStockUpdateOnly && selectedModule?.entity === 'Ingredient' && siteId === 'all') {
      return setErrorMessage('Select a project scope before updating stock from an Ingredients file.');
    }
    if (importMode !== 'delete_existing' && !file) return setErrorMessage('Select a CSV file.');
    if (detectedModuleKey && detectedModuleKey !== moduleKey) {
      const detectedModule = modules.find((item) => item.key === detectedModuleKey);
      return setErrorMessage(`This file matches ${detectedModule?.label || detectedModuleKey}. Select that module before uploading.`);
    }
    if (requiresSourceName && !sourceName) return setErrorMessage('Select Source Name: D365 or Cash before uploading.');
    if (isRecipeModule && !recipeType) return setErrorMessage('Select Recipe Type: General or Filipino before continuing.');
    if (isMenuPlanModule && !menuCuisine) return setErrorMessage('Select Menu Cuisine: General or Philippines before uploading.');
    if (isMenuPlanModule && !menuCategory) return setErrorMessage('Select Menu Category before uploading.');
    submitMutation.mutate();
  };

  if (permissionLoading) {
    return <div className="p-8 text-sm text-slate-500">Checking administrator access…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-4 md:p-8">
        <PageHeader title="Bulk Upload Center" description="Bulk uploads are restricted to administrators." />
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>You can continue to use the existing download, template, and export features.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <PageHeader title="Bulk Upload Center" description="Import large CSV files in background batches without blocking application requests." />

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-lg">Create upload job</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Label>Module</Label>
              <Select value={moduleKey} onValueChange={setModuleKey}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select module" /></SelectTrigger>
                <SelectContent>{modules.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Import mode</Label>
              <Select value={importMode} onValueChange={setImportMode}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IMPORT_MODES.map((mode) => (
                    <SelectItem
                      key={mode.value}
                      value={mode.value}
                      disabled={mode.value === 'update_stock_only' && !isStockUploadModule}
                    >
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-slate-500">{selectedModeDescription}</p>
            </div>
            {isSiteScoped && (
              <div>
                <Label>Project scope</Label>
                <Select value={siteId} onValueChange={setSiteId}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All authorized projects</SelectItem>
                    {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {importMode !== 'delete_existing' && (
              <div>
                <Label htmlFor="bulk_csv">CSV file</Label>
                <Input id="bulk_csv" type="file" accept=".csv,text/csv" className="mt-1" onChange={handleFileChange} />
                <p className="mt-1 text-xs text-slate-500">
                  {isStockUpdateOnly
                    ? 'Use a stock file with item_code or ingredient_code, quantity, unit, and optional unit_cost. The default upload limit is 25 MB.'
                    : 'Use the matching template. The default upload limit is 25 MB.'}
                </p>
              </div>
            )}
            {requiresSourceName ? (
              <div>
                <Label>Source Name *</Label>
                <Select value={sourceName} onValueChange={setSourceName}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Select source" /></SelectTrigger>
                  <SelectContent>
                    {SOURCE_NAME_OPTIONS.map((source) => (
                      <SelectItem key={source} value={source}>{source}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-slate-500">Assigned automatically to every record in this upload.</p>
              </div>
            ) : null}
            {isRecipeModule ? (
              <div>
                <Label>Recipe Type *</Label>
                <Select value={recipeType} onValueChange={setRecipeType}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Select recipe type" /></SelectTrigger>
                  <SelectContent>
                    {RECIPE_TYPE_OPTIONS.map((type) => (
                      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-slate-500">
                  {importMode === 'delete_existing'
                    ? 'Only recipes of this type will be deleted.'
                    : 'Assigned automatically to every recipe in this upload.'}
                </p>
              </div>
            ) : null}
            {isMenuPlanModule ? (
              <>
                <div>
                  <Label>Menu Cuisine *</Label>
                  <Select value={menuCuisine} onValueChange={setMenuCuisine}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select menu cuisine" /></SelectTrigger>
                    <SelectContent>
                      {MENU_CUISINE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">Assigned automatically to every menu plan in this upload.</p>
                </div>
                <div>
                  <Label>Menu Category *</Label>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {menuCategoryOptions.map((option) => {
                      const checked = menuCategory === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setMenuCategory(option.value)}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                            checked
                              ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                          }`}
                        >
                          <Checkbox checked={checked} onCheckedChange={() => setMenuCategory(option.value)} />
                          <span className="font-medium">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Use Senior, Junior, Labor, or Management Menu for General; Philippines supports Senior, Junior, and Labor.</p>
                </div>
              </>
            ) : null}
            {['replace_existing', 'delete_existing'].includes(importMode) && (
              <Alert variant="destructive" className="lg:col-span-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Destructive operation</AlertTitle>
                <AlertDescription>{selectedModeDescription} This action is restricted to data within your authorized project scope.</AlertDescription>
              </Alert>
            )}
            {fileModuleNotice && <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-700 lg:col-span-2">{fileModuleNotice}</div>}
            {(message || errorMessage) && <div className={`rounded-lg p-3 text-sm lg:col-span-2 ${errorMessage ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{errorMessage || message}</div>}
            <div className="lg:col-span-2">
              <Button type="submit" disabled={submitMutation.isPending}>
                <Upload className="mr-2 h-4 w-4" />{submitMutation.isPending ? 'Queuing…' : 'Queue background job'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-slate-900">Recent upload jobs</h2>
      <BulkJobsTable limit={10} compact />
    </div>
  );
}
