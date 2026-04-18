import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function YieldUpload({ onSuccess }) {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    setResult(null);

    try {
      // Upload file
      const { file_url } = await base44.integrations.Core.UploadFile({ file });

      // Extract data using AI
      const extractionResult = await base44.integrations.Core.ExtractDataFromUploadedFile({
        file_url,
        json_schema: {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  cuisine_type: { type: "string" },
                  category: { type: "string" },
                  unit: { type: "string" },
                  raw_weight_per_unit: { type: "number" },
                  cooked_weight_per_unit: { type: "number" },
                  cooking_yield_percent: { type: "number" },
                  shrinkage_percent: { type: "number" },
                  calories_per_100g: { type: "number" },
                  protein_per_100g: { type: "number" },
                  carbs_per_100g: { type: "number" },
                  fat_per_100g: { type: "number" },
                  cost_per_unit: { type: "number" }
                }
              }
            }
          }
        }
      });

      if (extractionResult.status === 'success' && extractionResult.output?.data) {
        const ingredients = extractionResult.output.data;
        
        // Bulk create/update ingredients
        let created = 0;
        let updated = 0;

        for (const ingredient of ingredients) {
          try {
            // Check if ingredient exists
            const existing = await base44.entities.Ingredient.filter({ name: ingredient.name });
            
            if (existing.length > 0) {
              // Update existing
              await base44.entities.Ingredient.update(existing[0].id, ingredient);
              updated++;
            } else {
              // Create new
              await base44.entities.Ingredient.create(ingredient);
              created++;
            }
          } catch (err) {
            console.error('Error processing ingredient:', ingredient.name, err);
          }
        }

        setResult({
          success: true,
          message: `Successfully processed ${created + updated} ingredients (${created} created, ${updated} updated)`
        });
        
        if (onSuccess) onSuccess();
      } else {
        setResult({
          success: false,
          message: extractionResult.details || 'Failed to extract data from file'
        });
      }
    } catch (error) {
      setResult({
        success: false,
        message: error.message || 'Failed to upload and process file'
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Yield Data</CardTitle>
        <CardDescription>
          Upload a CSV file with yield data to bulk update ingredients
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileUpload}
            disabled={uploading}
            className="hidden"
            id="yield-upload"
          />
          <label htmlFor="yield-upload" className="flex-1">
            <Button 
              disabled={uploading}
              className="w-full"
              asChild
            >
              <span>
                {uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Choose File to Upload
                  </>
                )}
              </span>
            </Button>
          </label>
        </div>

        {result && (
          <Alert variant={result.success ? "default" : "destructive"}>
            {result.success ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}