import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
  type User as FirebaseUser,
} from 'firebase/auth'
import { auth, googleProvider } from '../firebase'
import type { AuthUser } from '../types'

interface AuthContextType {
  user: AuthUser | null
  firebaseUser: FirebaseUser | null
  isAuthenticated: boolean
  loading: boolean
  login: (email: string, password?: string) => Promise<boolean>
  register: (email: string, password?: string, name?: string) => Promise<boolean>
  loginWithGoogle: () => Promise<boolean>
  resetPassword: (email: string) => Promise<void>
  quickLogin: (preset: 'operator' | 'warehouse' | 'finance') => void
  logout: () => Promise<void>
}

const PRESET_USERS: Record<'operator' | 'warehouse' | 'finance', AuthUser> = {
  operator: {
    id: 'usr_operator',
    name: 'Pawan Shukla',
    email: 'operator@youthnic.com',
    role: 'Operations & Dispatch Lead',
    avatar: 'PS',
  },
  warehouse: {
    id: 'usr_warehouse',
    name: 'Warehouse QC Desk',
    email: 'warehouse@youthnic.com',
    role: 'Reverse Logistics & QC Specialist',
    avatar: 'WH',
  },
  finance: {
    id: 'usr_finance',
    name: 'Finance & Remittance Desk',
    email: 'finance@youthnic.com',
    role: '3-Way Payment Reconciliation',
    avatar: 'FN',
  },
}

const AuthContext = createContext<AuthContextType | null>(null)

const STORAGE_KEY = 'youthnic_auth_user'
const TOKEN_KEY = 'youthnic_firebase_token'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : PRESET_USERS.operator
    } catch {
      return PRESET_USERS.operator
    }
  })

  // Listen to live Firebase Authentication state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser)
      if (fbUser) {
        try {
          const token = await fbUser.getIdToken()
          localStorage.setItem(TOKEN_KEY, token)

          const email = fbUser.email || 'operator@youthnic.com'
          const name = fbUser.displayName || email.split('@')[0] || 'Youthnic User'
          const initials = name
            .split(' ')
            .map((n) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2) || 'YO'

          const idTokenResult = await fbUser.getIdTokenResult()
          const isAdminOrDev = Boolean(
            idTokenResult.claims.admin ||
            idTokenResult.claims.developer ||
            email.toLowerCase() === 'returnorders@vbexports.co.in'
          )

          const role = isAdminOrDev
            ? 'Administrator & Developer (Full Access)'
            : email.includes('warehouse')
            ? 'Reverse Logistics & QC Specialist'
            : email.includes('finance')
            ? '3-Way Payment Reconciliation'
            : 'Operations & Dispatch Lead'

          const authUser: AuthUser = {
            id: fbUser.uid,
            name,
            email,
            role,
            avatar: initials,
          }

          setUser(authUser)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser))
        } catch {
          // Fallback to active state
        }
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  // Sync user object to local storage
  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
      } else {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(TOKEN_KEY)
      }
    } catch {
      // ignore
    }
  }, [user])

  // Email and Password Login via Firebase Auth
  const login = async (email: string, password?: string): Promise<boolean> => {
    const trimmed = email.trim()
    if (!password) {
      // Fallback quick developer sign-in
      const loggedUser: AuthUser = {
        id: `usr_${Date.now()}`,
        name: trimmed.includes('warehouse')
          ? 'Warehouse Specialist'
          : trimmed.includes('finance')
          ? 'Finance Lead'
          : 'Operations Manager',
        email: trimmed || 'operator@youthnic.com',
        role: trimmed.includes('warehouse')
          ? 'Reverse Logistics & QC Specialist'
          : trimmed.includes('finance')
          ? '3-Way Payment Reconciliation'
          : 'Operations & Dispatch Lead',
        avatar: (trimmed.slice(0, 2) || 'OP').toUpperCase(),
      }
      setUser(loggedUser)
      return true
    }

    try {
      const userCredential = await signInWithEmailAndPassword(auth, trimmed, password)
      const token = await userCredential.user.getIdToken()
      localStorage.setItem(TOKEN_KEY, token)
      return true
    } catch (err: any) {
      // If user doesn't exist, try creating an account automatically or rethrow
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        throw new Error('Invalid email or password. Please verify your credentials or register.')
      }
      throw err
    }
  }

  // Register New User in Firebase Auth
  const register = async (email: string, password?: string, name?: string): Promise<boolean> => {
    if (!password) throw new Error('Password is required to create a Firebase account.')
    const userCredential = await createUserWithEmailAndPassword(auth, email.trim(), password)
    if (name && auth.currentUser) {
      await updateProfile(auth.currentUser, { displayName: name.trim() })
    }
    const token = await userCredential.user.getIdToken()
    localStorage.setItem(TOKEN_KEY, token)
    return true
  }

  // Google Single Sign-On
  const loginWithGoogle = async (): Promise<boolean> => {
    try {
      const result = await signInWithPopup(auth, googleProvider)
      const token = await result.user.getIdToken()
      localStorage.setItem(TOKEN_KEY, token)
      return true
    } catch (err: any) {
      throw new Error(err.message || 'Failed to sign in with Google.')
    }
  }

  const resetPassword = async (email: string): Promise<void> => {
    if (!email.trim()) {
      throw new Error('Please enter your work email to receive password reset instructions.')
    }
    await sendPasswordResetEmail(auth, email.trim())
  }

  const quickLogin = (preset: 'operator' | 'warehouse' | 'finance') => {
    setUser(PRESET_USERS[preset])
  }

  const logout = async () => {
    try {
      await signOut(auth)
    } catch {
      // ignore
    }
    setUser(null)
    setFirebaseUser(null)
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(TOKEN_KEY)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        firebaseUser,
        isAuthenticated: Boolean(user),
        loading,
        login,
        register,
        loginWithGoogle,
        resetPassword,
        quickLogin,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
