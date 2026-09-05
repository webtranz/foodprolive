import React, { useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { QrCode } from 'lucide-react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { getDinerScanHeadcount } from '@/lib/mealServiceAttendance';

export default function LiveDinersPanel() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const queryClient = useQueryClient();

  const { data: allEvents = [] } = useQuery({
    queryKey: ['eventPlans'],
    queryFn: () => base44.entities.MenuPlan.list('-plan_date', 100),
    refetchInterval: 60000
  });

  const { data: allScans = [] } = useQuery({
    queryKey: ['dinerScans', 'today'],
    queryFn: () => base44.entities.DinerScan.filter({ plan_date: today }),
    refetchInterval: 60000
  });

  useEffect(() => {
    const unsubscribeEvents = base44.entities.MenuPlan.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['eventPlans'] });
    });
    const unsubscribeScans = base44.entities.DinerScan.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['dinerScans'] });
    });
    return () => {
      unsubscribeEvents();
      unsubscribeScans();
    };
  }, [queryClient]);

  const todayEvents = allEvents.filter(e => e.event_name && e.plan_date === today && e.service_style === 'dining_hall');
  const totalDiners = getDinerScanHeadcount(allScans);

  if (todayEvents.length === 0) return null;

  return (
    <Card className="border-slate-100 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <QrCode className="w-4 h-4 text-emerald-600" />
            Live Dining Hall Tracker
          </CardTitle>
          <div className="flex items-center gap-3">
            <Badge className="bg-emerald-100 text-emerald-700">{totalDiners} diners today</Badge>
            <Link to={createPageUrl('DiningScanner')}>
              <button className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">Open Scanner →</button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {todayEvents.map(event => {
          const eventScans = allScans.filter(s => s.event_id === event.id);
          const planned = event.total_expected_servings || 0;
          const actual = getDinerScanHeadcount(eventScans);
          const rate = planned > 0 ? Math.round((actual / planned) * 100) : 0;
          const noShows = Math.max(0, planned - actual);
          const wasteKg = ((noShows * (event.consumption_per_person_g || 550)) / 1000).toFixed(1);

          return (
            <div key={event.id} className="bg-slate-50 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="font-medium text-slate-900 text-sm">{event.event_name}</p>
                  <p className="text-xs text-slate-500">{event.site_name}</p>
                </div>
                <Badge className={rate >= 90 ? 'bg-emerald-100 text-emerald-700' : rate >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}>
                  {rate}%
                </Badge>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center mb-2">
                <div>
                  <p className="text-lg font-bold text-slate-700">{planned}</p>
                  <p className="text-xs text-slate-400">Planned</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-emerald-600">{actual}</p>
                  <p className="text-xs text-slate-400">Scanned</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-orange-500">{wasteKg} kg</p>
                  <p className="text-xs text-slate-400">Est. Waste</p>
                </div>
              </div>

              <div className="w-full bg-slate-200 rounded-full h-1.5">
                <div
                  className="h-1.5 rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(100, rate)}%`,
                    backgroundColor: rate >= 90 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444'
                  }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
