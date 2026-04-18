import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, TrendingUp } from "lucide-react";
import { Progress } from "@/components/ui/progress";

export default function SiteOverview({ sites }) {
  const defaultSites = [
    { name: 'Main Kitchen', type: 'kitchen', capacity: 500, currentLoad: 420, efficiency: 92 },
    { name: 'Camp Alpha', type: 'camp', capacity: 300, currentLoad: 280, efficiency: 88 },
    { name: 'Branch Downtown', type: 'branch', capacity: 200, currentLoad: 150, efficiency: 95 },
  ];

  const items = sites || defaultSites;

  const typeColors = {
    kitchen: 'bg-emerald-100 text-emerald-700',
    camp: 'bg-blue-100 text-blue-700',
    branch: 'bg-amber-100 text-amber-700',
    warehouse: 'bg-purple-100 text-purple-700'
  };

  return (
    <Card className="border-slate-100 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-slate-900">
          Site Performance
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.map((site, index) => (
            <div key={index} className="p-4 bg-slate-50 rounded-xl">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-slate-500" />
                  <span className="font-medium text-slate-900">{site.name}</span>
                </div>
                <Badge className={typeColors[site.type]}>
                  {site.type}
                </Badge>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">Capacity Usage</span>
                  <span className="font-medium text-slate-700">
                    {site.currentLoad}/{site.capacity}
                  </span>
                </div>
                <Progress 
                  value={(site.currentLoad / site.capacity) * 100} 
                  className="h-2"
                />
                <div className="flex items-center gap-1 text-sm">
                  <TrendingUp className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-600 font-medium">{site.efficiency}%</span>
                  <span className="text-slate-400">efficiency</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}