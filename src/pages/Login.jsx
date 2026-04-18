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
  const [form, setForm] = useState({ email: 'humayoonkhizar12@gmail.com', password: 'admin12345' });
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.25),transparent_35%),radial-gradient(circle_at_bottom,rgba(14,165,233,0.2),transparent_30%)]" />
      <Card className="relative w-full max-w-md border-slate-800 bg-slate-900/90 backdrop-blur">
        <CardHeader>
          <CardTitle className="text-2xl">FoodPro Control Center</CardTitle>
          <CardDescription className="text-slate-300">
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
            {(authError?.message || location.state?.error) ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {authError?.message || location.state?.error}
              </div>
            ) : null}
            <Button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={submitting || isLoadingAuth}>
              {submitting || isLoadingAuth ? 'Signing in...' : 'Sign In'}
            </Button>
            <p className="text-xs text-slate-400">
              Default admin credentials: <strong>admin@foodpro.local</strong> / <strong>admin12345</strong>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
