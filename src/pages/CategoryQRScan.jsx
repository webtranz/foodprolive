import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle2, XCircle, Clock, QrCode, Loader2 } from 'lucide-react';

const CATEGORY_STYLES = {
  labor: { bg: 'bg-blue-600', light: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-300' },
  junior: { bg: 'bg-purple-600', light: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-300' },
  senior: { bg: 'bg-amber-500', light: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-300' }
};

export default function CategoryQRScan() {
  const [state, setState] = useState('loading'); // loading | success | error | already_scanned | expired | time_invalid
  const [session, setSession] = useState(null);
  const [category, setCategory] = useState(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) {
      setState('error');
      setMessage('No QR token found. Please scan a valid QR code.');
      return;
    }
    processToken(token);
  }, []);

  const processToken = async (token) => {
    try {
      // Decode token to get session and category
      let payload;
      try {
        payload = JSON.parse(atob(token));
      } catch {
        setState('error');
        setMessage('Invalid QR code format.');
        return;
      }

      if (payload.type !== 'category_attendance') {
        setState('error');
        setMessage('This QR code is not a category attendance code.');
        return;
      }

      // Find sessions that have this token in their categories
      const sessions = await base44.entities.CategoryQRSession.list('-session_date', 200);
      let matchedSession = null;
      let matchedCat = null;

      for (const s of sessions) {
        const cat = s.categories?.find(c => c.token === token);
        if (cat) {
          matchedSession = s;
          matchedCat = cat;
          break;
        }
      }

      if (!matchedSession || !matchedCat) {
        setState('error');
        setMessage('QR code not found or has been regenerated. Please ask for a new QR code.');
        return;
      }

      if (matchedSession.status === 'closed') {
        setState('expired');
        setMessage('This session has been closed by the administrator.');
        return;
      }

      // Check time window
      const now = new Date();
      const dateStr = matchedSession.session_date;
      const start = new Date(`${dateStr}T${matchedSession.start_time}:00`);
      const end = new Date(`${dateStr}T${matchedSession.end_time}:00`);

      if (now < start) {
        setState('time_invalid');
        setMessage(`This QR code is not active yet. It opens at ${matchedSession.start_time}.`);
        setSession(matchedSession);
        setCategory(matchedCat);
        return;
      }

      if (now > end) {
        setState('expired');
        setMessage(`This QR code expired at ${matchedSession.end_time}. The attendance window has closed.`);
        setSession(matchedSession);
        setCategory(matchedCat);
        return;
      }

      // Valid — record attendance
      setSession(matchedSession);
      setCategory(matchedCat);

      // Create attendance record
      await base44.entities.AttendanceRecord.create({
        session_id: matchedSession.id,
        session_name: matchedSession.title,
        site_id: matchedSession.site_id,
        site_name: matchedSession.site_name,
        session_date: matchedSession.session_date,
        meal_type: 'lunch',
        attendee_id: `cat-scan-${Date.now()}`,
        category: matchedCat.category,
        marked_at: new Date().toISOString(),
        scan_method: 'qr_scan'
      });

      // Increment scan count
      const updatedCategories = matchedSession.categories.map(c =>
        c.token === token ? { ...c, scan_count: (c.scan_count || 0) + 1 } : c
      );
      await base44.entities.CategoryQRSession.update(matchedSession.id, { categories: updatedCategories });

      setState('success');
    } catch (err) {
      setState('error');
      setMessage('Something went wrong. Please try again.');
    }
  };

  const catStyle = category ? CATEGORY_STYLES[category.category] : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">

        {state === 'loading' && (
          <div className="text-center space-y-4 py-16">
            <div className={`w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center mx-auto`}>
              <Loader2 className="w-10 h-10 text-slate-400 animate-spin" />
            </div>
            <p className="text-slate-600 font-medium">Verifying QR code...</p>
          </div>
        )}

        {state === 'success' && catStyle && (
          <div className="text-center space-y-5">
            <div className={`w-24 h-24 rounded-full ${catStyle.bg} flex items-center justify-center mx-auto shadow-lg`}>
              <CheckCircle2 className="w-12 h-12 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Attendance Recorded!</h1>
              <p className="text-slate-500 mt-1">Your attendance has been successfully logged.</p>
            </div>
            <div className={`${catStyle.light} ${catStyle.border} border-2 rounded-2xl p-5 space-y-3`}>
              <p className={`text-2xl font-bold ${catStyle.text} uppercase tracking-wide`}>{category.label || category.category}</p>
              <div className="text-sm text-slate-600 space-y-1">
                <p className="font-medium">{session.title}</p>
                <p>{session.session_date}</p>
                <p>{new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
            <p className="text-xs text-slate-400">You can now close this page</p>
          </div>
        )}

        {state === 'already_scanned' && (
          <div className="text-center space-y-4 py-8">
            <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
              <Clock className="w-10 h-10 text-amber-500" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Already Scanned</h1>
            <p className="text-slate-500">{message}</p>
          </div>
        )}

        {(state === 'expired' || state === 'time_invalid') && (
          <div className="text-center space-y-4 py-8">
            <div className={`w-20 h-20 rounded-full ${state === 'time_invalid' ? 'bg-blue-100' : 'bg-red-100'} flex items-center justify-center mx-auto`}>
              <Clock className={`w-10 h-10 ${state === 'time_invalid' ? 'text-blue-500' : 'text-red-500'}`} />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">
              {state === 'time_invalid' ? 'Not Active Yet' : 'QR Code Expired'}
            </h1>
            <p className="text-slate-500">{message}</p>
            {session && (
              <div className="bg-slate-100 rounded-xl px-4 py-3 text-sm text-slate-600">
                <p className="font-medium">{session.title}</p>
                <p>Active window: {session.start_time} – {session.end_time}</p>
              </div>
            )}
          </div>
        )}

        {state === 'error' && (
          <div className="text-center space-y-4 py-8">
            <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center mx-auto">
              <XCircle className="w-10 h-10 text-red-500" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Invalid QR Code</h1>
            <p className="text-slate-500">{message}</p>
            <div className="flex justify-center">
              <QrCode className="w-12 h-12 text-slate-200" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}