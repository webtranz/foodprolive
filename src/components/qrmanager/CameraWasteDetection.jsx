import React, { useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Camera, Upload, Sparkles, Lightbulb, RefreshCw, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import { formatCurrency } from '@/lib/currency';

export default function CameraWasteDetection() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [capturedImage, setCapturedImage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [siteId, setSiteId] = useState('');
  const queryClient = useQueryClient();

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => base44.entities.Site.list() });
  const { data: logs = [] } = useQuery({
    queryKey: ['wasteDetectionLogs'],
    queryFn: () => base44.entities.WasteDetectionLog.list('-detected_at', 50)
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const user = await base44.auth.me();
      return base44.entities.WasteDetectionLog.create({
        ...data,
        detected_at: new Date().toISOString(),
        detected_by: user.email
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wasteDetectionLogs'] })
  });

  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    videoRef.current.srcObject = stream;
    await videoRef.current.play();
    setStreaming(true);
    setCapturedImage(null);
    setAiResult(null);
  };

  const stopCamera = () => {
    videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  };

  const capturePhoto = () => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataURL = canvas.toDataURL('image/jpeg', 0.8);
    setCapturedImage(dataURL);
    stopCamera();
    setAiResult(null);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCapturedImage(ev.target.result);
      setAiResult(null);
    };
    reader.readAsDataURL(file);
  };

  const analyzeImage = async () => {
    if (!capturedImage) return;
    setAnalyzing(true);
    setUploading(true);

    // Convert base64 to blob and upload
    const res = await fetch(capturedImage);
    const blob = await res.blob();
    const file = new File([blob], 'waste-capture.jpg', { type: 'image/jpeg' });
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    setUploading(false);

    const result = await base44.integrations.Core.InvokeLLM({
      prompt: `You are an AI food waste analyst. Analyze this food image carefully.
Detect:
1. Food types visible on the plate/area
2. Estimate what percentage of food is wasted/leftover (0-100%)
3. Estimate waste quantity in grams
4. Classify waste category
5. Provide 2-3 specific suggestions to reduce this type of waste
6. Give a confidence score (0-100)
7. Estimate cost of waste (assume average ⃁ 0.01 per gram)

Be precise and practical.`,
      file_urls: [file_url],
      response_json_schema: {
        type: 'object',
        properties: {
          detected_food_types: { type: 'array', items: { type: 'string' } },
          waste_percentage: { type: 'number' },
          estimated_waste_grams: { type: 'number' },
          waste_category: { type: 'string', enum: ['plate_waste', 'cooking_waste', 'preparation_waste', 'spoilage', 'other'] },
          confidence_score: { type: 'number' },
          suggestions: { type: 'array', items: { type: 'string' } },
          cost_estimate: { type: 'number' },
          observation: { type: 'string' }
        }
      }
    });

    setAiResult({ ...result, image_url: file_url });
    setAnalyzing(false);
  };

  const saveResult = () => {
    if (!aiResult) return;
    saveMutation.mutate({
      site_id: siteId,
      site_name: sites.find(s => s.id === siteId)?.name || '',
      image_url: aiResult.image_url,
      detected_food_types: aiResult.detected_food_types,
      estimated_waste_grams: aiResult.estimated_waste_grams,
      waste_percentage: aiResult.waste_percentage,
      waste_category: aiResult.waste_category,
      confidence_score: aiResult.confidence_score,
      ai_suggestions: aiResult.suggestions,
      cost_estimate: aiResult.cost_estimate,
      detection_method: capturedImage?.startsWith('data:') ? 'camera' : 'upload'
    });
    setCapturedImage(null);
    setAiResult(null);
  };

  const riskColor = (pct) => {
    if (pct < 20) return 'text-green-600 bg-green-50';
    if (pct < 50) return 'text-amber-600 bg-amber-50';
    return 'text-red-600 bg-red-50';
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Capture Area */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Camera className="w-4 h-4" /> Food Waste Detection</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="relative bg-slate-900 rounded-xl overflow-hidden aspect-video">
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
              <canvas ref={canvasRef} className="hidden" />
              {!streaming && !capturedImage && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                  <Camera className="w-10 h-10 mb-2 opacity-40" />
                  <p className="text-sm opacity-60">Camera / Upload</p>
                </div>
              )}
              {capturedImage && !streaming && (
                <img src={capturedImage} alt="Captured" className="absolute inset-0 w-full h-full object-cover" />
              )}
            </div>

            <div className="flex gap-2">
              {!streaming ? (
                <Button onClick={startCamera} className="flex-1 bg-slate-800 hover:bg-slate-900 text-white">
                  <Camera className="w-4 h-4 mr-2" /> Camera
                </Button>
              ) : (
                <Button onClick={capturePhoto} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                  📸 Capture
                </Button>
              )}
              <Button variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}>
                <Upload className="w-4 h-4 mr-2" /> Upload
              </Button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
            </div>

            {capturedImage && (
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Site (optional)</Label>
                  <Select value={siteId} onValueChange={setSiteId}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="Select site" /></SelectTrigger>
                    <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button onClick={analyzeImage} disabled={analyzing || uploading} className="w-full bg-indigo-600 hover:bg-indigo-700">
                  {analyzing || uploading ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />{uploading ? 'Uploading...' : 'Analyzing...'}</> : <><Sparkles className="w-4 h-4 mr-2" />Analyze with AI</>}
                </Button>
                <Button variant="outline" className="w-full" onClick={() => { setCapturedImage(null); setAiResult(null); }}>
                  Clear
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI Result */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Sparkles className="w-4 h-4 text-indigo-600" /> AI Analysis Result</CardTitle></CardHeader>
          <CardContent>
            {!aiResult && !analyzing && (
              <div className="flex flex-col items-center justify-center h-48 text-slate-400">
                {capturedImage ? (
                  <div className="w-full space-y-2">
                    <p className="text-xs text-center text-slate-500 mb-2">Image loaded — click <strong>Analyze with AI</strong> to proceed</p>
                    <img src={capturedImage} alt="Preview" className="w-full rounded-xl object-cover max-h-48 border border-slate-200" />
                  </div>
                ) : (
                  <>
                    <Sparkles className="w-10 h-10 mb-2 opacity-30" />
                    <p className="text-sm">Capture or upload an image to analyze</p>
                  </>
                )}
              </div>
            )}
            {analyzing && <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 rounded-lg" />)}</div>}
            {aiResult && !analyzing && (
              <div className="space-y-4">
                {/* Show analyzed image thumbnail */}
                {capturedImage && (
                  <img src={capturedImage} alt="Analyzed" className="w-full rounded-xl object-cover max-h-36 border border-slate-200" />
                )}
                <div className={`rounded-xl p-4 flex items-center justify-between ${riskColor(aiResult.waste_percentage)}`}>
                  <div>
                    <p className="text-2xl font-bold">{aiResult.waste_percentage?.toFixed(0)}%</p>
                    <p className="text-sm">Food Wasted</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold">{aiResult.estimated_waste_grams?.toFixed(0)}g</p>
                    <p className="text-sm">≈ {formatCurrency(aiResult.cost_estimate)}</p>
                  </div>
                </div>

                {aiResult.detected_food_types?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-slate-600 mb-1">Detected Foods</p>
                    <div className="flex flex-wrap gap-1">
                      {aiResult.detected_food_types.map((f, i) => <Badge key={i} variant="secondary">{f}</Badge>)}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-slate-50 rounded-lg p-2">
                    <p className="text-slate-500">Category</p>
                    <p className="font-medium capitalize">{aiResult.waste_category?.replace('_', ' ')}</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-2">
                    <p className="text-slate-500">Confidence</p>
                    <p className="font-medium">{aiResult.confidence_score?.toFixed(0)}%</p>
                  </div>
                </div>

                {aiResult.suggestions?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-slate-600 mb-2 flex items-center gap-1"><Lightbulb className="w-3 h-3 text-yellow-500" /> Suggestions</p>
                    <div className="space-y-1">
                      {aiResult.suggestions.map((s, i) => (
                        <div key={i} className="text-xs bg-yellow-50 border border-yellow-200 rounded-lg p-2 text-slate-700">{s}</div>
                      ))}
                    </div>
                  </div>
                )}

                <Button onClick={saveResult} className="w-full bg-green-600 hover:bg-green-700" disabled={saveMutation.isPending}>
                  <CheckCircle2 className="w-4 h-4 mr-2" /> Save to Log
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Detections */}
      <Card>
        <CardHeader><CardTitle className="text-base">Recent Waste Detections</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date/Time</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Food Types</TableHead>
                <TableHead>Waste</TableHead>
                <TableHead>% Wasted</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Category</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map(log => (
                <TableRow key={log.id}>
                  <TableCell className="text-sm">{format(new Date(log.detected_at), 'MMM d, HH:mm')}</TableCell>
                  <TableCell>{log.site_name || '-'}</TableCell>
                  <TableCell className="text-xs max-w-[120px] truncate">{log.detected_food_types?.join(', ') || '-'}</TableCell>
                  <TableCell className="font-medium">{log.estimated_waste_grams?.toFixed(0)}g</TableCell>
                  <TableCell>
                    <Badge className={log.waste_percentage >= 50 ? 'bg-red-600' : log.waste_percentage >= 20 ? 'bg-amber-500' : 'bg-green-600'}>
                      {log.waste_percentage?.toFixed(0)}%
                    </Badge>
                  </TableCell>
                  <TableCell>{formatCurrency(log.cost_estimate || 0)}</TableCell>
                  <TableCell className="text-xs capitalize">{log.waste_category?.replace('_', ' ')}</TableCell>
                </TableRow>
              ))}
              {logs.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-8 text-slate-400">No detections yet</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
