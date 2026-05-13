import React from 'react';
import { AlertCircle, Inbox, Loader2 } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';

const VARIANT_MAP = {
  loading: {
    icon: Loader2,
    iconClassName: 'text-slate-400 animate-spin',
    titleClassName: 'text-slate-700',
    descriptionClassName: 'text-slate-500'
  },
  error: {
    icon: AlertCircle,
    iconClassName: 'text-rose-500',
    titleClassName: 'text-rose-700',
    descriptionClassName: 'text-rose-600'
  },
  empty: {
    icon: Inbox,
    iconClassName: 'text-slate-300',
    titleClassName: 'text-slate-700',
    descriptionClassName: 'text-slate-500'
  }
};

export default function AsyncStatePanel({
  variant = 'empty',
  title,
  description,
  action = null,
  icon: IconOverride = null,
  className = ''
}) {
  const config = VARIANT_MAP[variant] || VARIANT_MAP.empty;
  const Icon = IconOverride || config.icon;

  return (
    <Card className={`border-slate-100 shadow-sm ${className}`.trim()}>
      <CardContent className="p-12 text-center">
        <Icon className={`mx-auto mb-4 h-16 w-16 ${config.iconClassName}`.trim()} />
        <h3 className={`mb-2 text-lg font-semibold ${config.titleClassName}`.trim()}>
          {title}
        </h3>
        {description ? (
          <p className={`mx-auto max-w-2xl ${config.descriptionClassName}`.trim()}>
            {description}
          </p>
        ) : null}
        {action ? (
          <div className="mt-6 flex justify-center">
            {action}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
