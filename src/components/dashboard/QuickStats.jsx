import StatCard from "@/components/ui/StatCard";
import { 
  Utensils, 
  Factory, 
  Trash2, 
  Building2, 
  Flame,
  TrendingUp 
} from "lucide-react";

export default function QuickStats({ stats }) {
  const statCards = [
    {
      title: "Active Sites",
      value: stats.activeSites || 0,
      subtitle: "Operational locations",
      icon: Building2,
      iconBg: "bg-blue-50",
      iconColor: "text-blue-600"
    },
    {
      title: "Today's Production",
      value: `${stats.todayProduction || 0}`,
      subtitle: "Servings planned",
      icon: Factory,
      iconBg: "bg-emerald-50",
      iconColor: "text-emerald-600",
      trend: "up",
      trendValue: "+12% vs last week"
    },
    {
      title: "Total Recipes",
      value: stats.totalRecipes || 0,
      subtitle: "Active recipes",
      icon: Utensils,
      iconBg: "bg-amber-50",
      iconColor: "text-amber-600"
    },
    {
      title: "This Week's Waste",
      value: `${stats.weeklyWaste || 0} kg`,
      subtitle: "Food waste recorded",
      icon: Trash2,
      iconBg: "bg-red-50",
      iconColor: "text-red-600",
      trend: "down",
      trendValue: "-8% vs last week"
    },
    {
      title: "Avg Calories/Serving",
      value: stats.avgCalories || 0,
      subtitle: "Across all meals",
      icon: Flame,
      iconBg: "bg-orange-50",
      iconColor: "text-orange-600"
    },
    {
      title: "Efficiency Rate",
      value: `${stats.efficiency || 0}%`,
      subtitle: "Production efficiency",
      icon: TrendingUp,
      iconBg: "bg-purple-50",
      iconColor: "text-purple-600"
    }
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {statCards.map((stat, index) => (
        <StatCard key={index} {...stat} />
      ))}
    </div>
  );
}