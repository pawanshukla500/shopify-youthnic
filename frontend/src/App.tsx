import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './components/Layout'
import { ToastProvider, LoadingState } from './components/UI'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { Login } from './pages/Login'
import { ErrorBoundary } from './components/ErrorBoundary'
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

// Route pages are lazy so the initial bundle stays small; each page chunk
// loads on first visit. Pages use named exports, hence the adapter.
function lazyPage<T extends string>(load: () => Promise<Record<T, ComponentType>>, name: T) {
  return lazy(() => load().then((m) => ({ default: m[name] })))
}
const Dashboard = lazyPage(() => import('./pages/Dashboard'), 'Dashboard')
const Orders = lazyPage(() => import('./pages/Orders'), 'Orders')
const OrderDetail = lazyPage(() => import('./pages/OrderDetail'), 'OrderDetail')
const Returns = lazyPage(() => import('./pages/Returns'), 'Returns')
const Tracking = lazyPage(() => import('./pages/Tracking'), 'Tracking')
const Tools = lazyPage(() => import('./pages/Tools'), 'Tools')
const Analytics = lazyPage(() => import('./pages/Analytics'), 'Analytics')
const Settings = lazyPage(() => import('./pages/Settings'), 'Settings')
const Products = lazyPage(() => import('./pages/Products'), 'Products')
const Communications = lazyPage(() => import('./pages/Communications'), 'Communications')
const SupportDesk = lazyPage(() => import('./pages/SupportDesk'), 'SupportDesk')
const Remittances = lazyPage(() => import('./pages/Remittances'), 'Remittances')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 20_000, refetchOnWindowFocus: false, retry: 1 },
  },
})

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', width: '100vw', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-canvas, #0f172a)' }}>
        <LoadingState label="Verifying Firebase authentication session..." />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

export function App() {
  return (
    <ErrorBoundary fallbackTitle="Youthnic OMS Application Error">
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <BrowserRouter>
                <Suspense fallback={<LoadingState label="Loading..." />}>
                  <Routes>
                    <Route path="/login" element={<Login />} />
                    <Route
                      element={
                        <RequireAuth>
                          <Layout />
                        </RequireAuth>
                      }
                    >
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/orders" element={<Orders />} />
                      <Route path="/orders/:id" element={<OrderDetail />} />
                      <Route path="/products" element={<Products />} />
                      <Route path="/analytics" element={<Analytics />} />
                      <Route path="/reports" element={<Analytics />} />
                      <Route path="/returns" element={<Returns />} />
                      <Route path="/tracking" element={<Tracking />} />
                      <Route path="/ledger" element={<Navigate to="/tools" replace />} />
                      <Route path="/tools" element={<Tools />} />
                      <Route path="/accounts" element={<Navigate to="/remittance" replace />} />
                      <Route path="/remittance" element={<Remittances />} />
                      <Route path="/remittances" element={<Navigate to="/remittance" replace />} />
                      <Route path="/communications" element={<Communications />} />
                      <Route path="/support" element={<SupportDesk />} />
                      <Route path="/settings" element={<Settings />} />
                    </Route>
                  </Routes>
                </Suspense>
              </BrowserRouter>
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
