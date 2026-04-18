import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export default function EmptyState({ 
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  className
}) {
  return (
    <div className={cn(
      "flex flex-col items-center justify-center py-16 px-4 text-center",
      className
    )}>
      {Icon && (
        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
          <Icon className="w-8 h-8 text-slate-400" />
        </div>
      )}
      <h3 className="text-lg font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-slate-500 max-w-md mb-6">{description}</p>
      {actionLabel && onAction && (
        <Button onClick={onAction} className="bg-emerald-600 hover:bg-emerald-700">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}