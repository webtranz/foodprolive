import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import CategoryQRScan from './pages/CategoryQRScan';
import AttendanceScan from './pages/AttendanceScan';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { usePermissions } from '@/components/auth/usePermissions';
import { canAccessPage } from '@/lib/pageAccess';
import Login from '@/pages/Login';

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

const AccessDenied = () => (
  <div className="min-h-screen bg-slate-50 p-6 flex items-center justify-center">
    <div className="max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-2xl font-bold text-slate-900">Access Restricted</h1>
      <p className="mt-3 text-sm text-slate-600">
        You do not have permission to access this module.
      </p>
    </div>
  </div>
);

const AuthenticatedApp = () => {
  const { isLoadingAuth, isAuthenticated, authError } = useAuth();
  const { can, loading: permissionsLoading } = usePermissions();

  if (isLoadingAuth || permissionsLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ error: authError?.message }} />;
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <MainPage />
        </LayoutWrapper>
      } />
      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            canAccessPage(path, can)
              ? (
                <LayoutWrapper currentPageName={path}>
                  <Page />
                </LayoutWrapper>
              )
              : <AccessDenied />
          }
        />
      ))}
      <Route path="/CategoryQRScan" element={<CategoryQRScan />} />
      <Route path="/AttendanceScan" element={<AttendanceScan />} />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <NavigationTracker />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<AuthenticatedApp />} />
          </Routes>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
