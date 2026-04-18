import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/AuthContext';

export default function Login() {
  const location = useLocation();
  const { login, isAuthenticated, isLoadingAuth, authError } = useAuth();
  const [form, setForm] = useState({ email: 'humayunkhizar12@gmail.com', password: 'Tafga@2030' });
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await login(form.email, form.password);
    } finally {
      setSubmitting(false);
    }
  };

  const visibleError = authError?.type === 'auth_required'
    ? null
    : (authError?.message || location.state?.error || null);

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.18),transparent_28%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.16),transparent_32%),linear-gradient(180deg,#fffdf8_0%,#f8fafc_45%,#eef6f2_100%)]" />
      <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(90deg,rgba(251,191,36,0.08),rgba(16,185,129,0.06),rgba(59,130,246,0.05))]" />
      <Card className="relative w-full max-w-md border-stone-200 bg-white/95 shadow-2xl backdrop-blur">
        <CardHeader>
          <CardTitle className="text-2xl text-slate-900">FoodPro Control Center</CardTitle>
          <CardDescription className="text-slate-600">
            Sign in to manage production, inventory, dining attendance, and supplier workflows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                autoComplete="current-password"
                required
              />
            </div>
            {visibleError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {visibleError}
              </div>
            ) : null}
            <Button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={submitting || isLoadingAuth}>
              {submitting || isLoadingAuth ? 'Signing in...' : 'Sign In'}
            </Button>
            <p className="text-xs text-slate-500">
              Default admin credentials: <strong>humayunkhizar12@gmail.com</strong> / <strong>Tafga@2030</strong>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
