import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './components/Layout'
import { ToastProvider, LoadingState } from './components/UI'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { Dashboard } from './pages/Dashboard'
import { Orders } from './pages/Orders'
import { OrderDetail } from './pages/OrderDetail'
import { Returns } from './pages/Returns'
import { Tracking } from './pages/Tracking'
import { Tools } from './pages/Tools'
import { Analytics } from './pages/Analytics'
import { Login } from './pages/Login'
import { Settings } from './pages/Settings'
import { Products } from './pages/Products'
import { Communications } from './pages/Communications'
import { SupportDesk } from './pages/SupportDesk'
import { Accounts } from './pages/Accounts'
import type { ReactNode } from 'react'

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
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
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
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/communications" element={<Communications />} />
                  <Route path="/support" element={<SupportDesk />} />
                  <Route path="/settings" element={<Settings />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}


