import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Factory, Trash2, Utensils, Building2 } from "lucide-react";
import { format } from "date-fns";

const activityIcons = {
  production: Factory,
  waste: Trash2,
  recipe: Utensils,
  site: Building2
};

const activityColors = {
  production: "bg-emerald-50 text-emerald-600",
  waste: "bg-red-50 text-red-600",
  recipe: "bg-amber-50 text-amber-600",
  site: "bg-blue-50 text-blue-600"
};

export default function RecentActivity({ activities }) {
  const defaultActivities = [
    { type: 'production', message: 'Lunch production completed', site: 'Main Kitchen', time: new Date() },
    { type: 'waste', message: '2.5kg plate waste recorded', site: 'Camp Alpha', time: new Date(Date.now() - 3600000) },
    { type: 'recipe', message: 'New recipe "Grilled Chicken" added', site: 'System', time: new Date(Date.now() - 7200000) },
    { type: 'production', message: 'Breakfast prep started', site: 'Branch B', time: new Date(Date.now() - 10800000) },
  ];

  const items = activities || defaultActivities;

  return (
    <Card className="border-slate-100 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold text-slate-900">
          Recent Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.map((activity, index) => {
            const Icon = activityIcons[activity.type] || Factory;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${activityColors[activity.type]}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {activity.message}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs font-normal">
                      {activity.site}
                    </Badge>
                    <span className="text-xs text-slate-400">
                      {format(new Date(activity.time), 'HH:mm')}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}