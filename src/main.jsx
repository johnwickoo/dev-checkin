/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState, useEffect, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { supabase } from './supabase.js'

// Code splitting — only load when needed
const StatsPage = lazy(() => import('./StatsPage.jsx'))
const SettingsPage = lazy(() => import('./SettingsPage.jsx'))
const VotePage = lazy(() => import('./VotePage.jsx'))
const PunishPage = lazy(() => import('./PunishPage.jsx'))
const CheerPage = lazy(() => import('./CheerPage.jsx'))
const FeedbackPage = lazy(() => import('./FeedbackPage.jsx'))
const THEME_STORAGE_KEY = 'ui_theme_mode'

function toDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function LoadingFallback() {
  return (
    <div className="app">
      <section className="card"><p className="vote-status">Loading...</p></section>
    </div>
  )
}

function getPreferredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.body.setAttribute('data-theme', theme)
}

function getPasswordStrength(pw) {
  if (!pw) return { score: 0, label: '', cls: '' }
  let score = 0
  if (pw.length >= 6) score++
  if (pw.length >= 10) score++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (score <= 1) return { score, label: 'Weak', cls: 'pw-weak' }
  if (score <= 2) return { score, label: 'Fair', cls: 'pw-fair' }
  if (score <= 3) return { score, label: 'Good', cls: 'pw-good' }
  return { score, label: 'Strong', cls: 'pw-strong' }
}

function EyeIcon({ visible }) {
  if (visible) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}

function PasswordInput({ value, onChange, placeholder, autoComplete, minLength, required = true }) {
  const [showPw, setShowPw] = useState(false)
  return (
    <div className="pw-input-wrap">
      <input
        type={showPw ? 'text' : 'password'}
        className="field-input pw-field"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
      />
      <button type="button" className="pw-eye-btn" onClick={() => setShowPw(v => !v)} tabIndex={-1} aria-label={showPw ? 'Hide password' : 'Show password'}>
        <EyeIcon visible={showPw} />
      </button>
    </div>
  )
}

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState(null)
  const [mode, setMode] = useState('login')
  const [sliding, setSliding] = useState(false)
  const [slideDir, setSlideDir] = useState('right')

  const strength = mode === 'signup' ? getPasswordStrength(password) : null

  function showToast(message, type = 'success') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  function switchMode() {
    setSlideDir(mode === 'login' ? 'right' : 'left')
    setSliding(true)
    setTimeout(() => {
      setMode(m => m === 'login' ? 'signup' : 'login')
      setError('')
      setPassword('')
      setConfirmPassword('')
      setSliding(false)
    }, 200)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true); setError('')

    if (mode === 'signup') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters')
        setLoading(false)
        return
      }
      if (strength.score <= 1) {
        setError('Password is too weak. Add uppercase, numbers, or symbols.')
        setLoading(false)
        return
      }
      if (password !== confirmPassword) {
        setError('Passwords don\'t match')
        setLoading(false)
        return
      }
    }

    if (mode === 'signup') {
      // Supabase signUp: if the user already exists and is confirmed,
      // it returns a user with a fake ID and no identities array.
      // We detect this to show a helpful message.
      const { data, error: authError } = await supabase.auth.signUp({ email, password })
      if (authError) {
        if (authError.message?.includes('already registered') || authError.message?.includes('already been registered')) {
          setError('This email is already registered. Try signing in, or check your inbox for a confirmation link.')
        } else {
          setError(authError.message)
        }
      } else if (data?.user && (!data.user.identities || data.user.identities.length === 0)) {
        // User already exists (confirmed account) — identities is empty
        setError('An account with this email already exists. Try signing in instead.')
      } else if (data?.user && !data.session) {
        showToast('Confirmation email sent! Check your inbox.', 'success')
        setPassword('')
        setConfirmPassword('')
      }
    } else {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
      if (authError) {
        if (authError.message?.includes('Email not confirmed')) {
          setError('Email not confirmed yet. Check your inbox or sign up again if the link expired.')
        } else if (authError.message?.includes('Invalid login credentials')) {
          setError('Invalid email or password')
        } else {
          setError(authError.message)
        }
      }
    }
    setLoading(false)
  }

  async function handleResendConfirmation() {
    if (!email || !email.includes('@')) {
      setError('Enter your email above first')
      return
    }
    setLoading(true)
    const { error: resendErr } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim().toLowerCase(),
    })
    if (resendErr) {
      setError(resendErr.message)
    } else {
      showToast('Confirmation email resent! Check your inbox.', 'success')
      setError('')
    }
    setLoading(false)
  }

  async function handleForgotPassword() {
    if (!email || !email.includes('@')) {
      setError('Enter your email above first')
      return
    }
    setLoading(true); setError('')
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: `${window.location.origin}` }
    )
    if (resetErr) {
      setError(resetErr.message)
    } else {
      showToast('Password reset email sent! Check your inbox.', 'success')
    }
    setLoading(false)
  }

  const showResend = error && (error.includes('not confirmed') || error.includes('confirmation link'))

  return (
    <div className="app">
      <header>
        <h1>Accountabuddy</h1>
        <p className="date">{mode === 'login' ? 'Sign in to continue' : 'Create your account'}</p>
      </header>

      <div className="auth-mode-toggle">
        <button
          className={`auth-mode-btn ${mode === 'login' ? 'auth-mode-active' : ''}`}
          onClick={() => mode !== 'login' && switchMode()}
        >
          Sign In
        </button>
        <button
          className={`auth-mode-btn ${mode === 'signup' ? 'auth-mode-active' : ''}`}
          onClick={() => mode !== 'signup' && switchMode()}
        >
          Sign Up
        </button>
      </div>

      <section className={`card auth-card ${sliding ? `auth-slide-out-${slideDir}` : 'auth-slide-in'}`}>
        <form onSubmit={handleSubmit} className="login-form">
          <input type="email" className="field-input" placeholder="Email"
            value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
          <PasswordInput
            value={password} onChange={e => setPassword(e.target.value)}
            placeholder={mode === 'signup' ? 'Password (min 8 chars)' : 'Password'}
            minLength={mode === 'signup' ? 8 : 6}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />

          {mode === 'signup' && password && (
            <div className="pw-strength">
              <div className="pw-strength-bar">
                <div className={`pw-strength-fill ${strength.cls}`} style={{ width: `${Math.min(strength.score, 4) * 25}%` }} />
              </div>
              <span className={`pw-strength-label ${strength.cls}`}>{strength.label}</span>
            </div>
          )}

          {mode === 'signup' && (
            <PasswordInput
              value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm password" minLength={8}
              autoComplete="new-password"
            />
          )}

          {error && <p className="missed-error">{error}</p>}
          {showResend && (
            <button type="button" className="history-toggle" onClick={handleResendConfirmation} disabled={loading}>
              Resend confirmation email
            </button>
          )}
          <button className="save-btn" disabled={loading}>
            {loading ? 'Loading...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {mode === 'login' && (
          <>
            <p className="auth-hint auth-forgot">
              <button className="auth-hint-link" onClick={handleForgotPassword} disabled={loading}>
                Forgot password?
              </button>
            </p>
            <p className="auth-hint">
              Don't have an account?{' '}
              <button className="auth-hint-link" onClick={switchMode}>Sign up</button>
            </p>
          </>
        )}
        {mode === 'signup' && (
          <p className="auth-hint">
            Already have an account?{' '}
            <button className="auth-hint-link" onClick={switchMode}>Sign in</button>
          </p>
        )}
      </section>

      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.message}</div>
      )}
    </div>
  )
}

function TabNav({ tab, setTab }) {
  return (
    <nav className="tab-nav">
      <div className="tab-row">
        <button className={`tab-btn ${tab === 'checkin' ? 'tab-active' : ''}`} onClick={() => setTab('checkin')}>Check-in</button>
        <button className={`tab-btn ${tab === 'stats' ? 'tab-active' : ''}`} onClick={() => setTab('stats')}>Stats</button>
        <button className={`tab-btn ${tab === 'settings' ? 'tab-active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </div>
    </nav>
  )
}

// Check and show notification reminder (uses server-side reminder_hour)
async function checkNotificationReminder(userId) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const now = new Date()
  const today = toDateKey(now)
  const lastNotified = localStorage.getItem(`last_notified_${userId}`)
  if (lastNotified === today) return

  // Fetch reminder hour from server settings
  const { data: settings } = await supabase.from('user_settings')
    .select('reminder_hour').eq('user_id', userId).maybeSingle()
  const hour = settings?.reminder_hour ?? 21
  if (now.getHours() < hour) return

  localStorage.setItem(`last_notified_${userId}`, today)
  new Notification('Accountabuddy Reminder', {
    body: "Don't forget to log your check-in today!",
    icon: '/accountabuddy-icon.svg',
  })
}

function ResetPasswordPage() {
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const strength = getPasswordStrength(newPw)

  async function handleReset(e) {
    e.preventDefault()
    setError('')
    if (newPw.length < 8) { setError('Password must be at least 8 characters'); return }
    if (strength.score <= 1) { setError('Password is too weak. Add uppercase, numbers, or symbols.'); return }
    if (newPw !== confirmPw) { setError('Passwords don\'t match'); return }
    setLoading(true)
    const { error: updateErr } = await supabase.auth.updateUser({ password: newPw })
    if (updateErr) {
      setError(updateErr.message)
    } else {
      setDone(true)
    }
    setLoading(false)
  }

  if (done) {
    return (
      <div className="app">
        <header><h1>Accountabuddy</h1></header>
        <section className="card">
          <p className="vote-status" style={{ color: '#4ade80' }}>Password updated successfully!</p>
          <button className="save-btn" onClick={() => window.location.replace('/')}>Continue to app</button>
        </section>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Accountabuddy</h1>
        <p className="date">Set your new password</p>
      </header>
      <section className="card auth-card auth-slide-in">
        <form onSubmit={handleReset} className="login-form">
          <PasswordInput value={newPw} onChange={e => setNewPw(e.target.value)}
            placeholder="New password (min 8 chars)" autoComplete="new-password" minLength={8} />
          {newPw && (
            <div className="pw-strength">
              <div className="pw-strength-bar">
                <div className={`pw-strength-fill ${strength.cls}`} style={{ width: `${Math.min(strength.score, 4) * 25}%` }} />
              </div>
              <span className={`pw-strength-label ${strength.cls}`}>{strength.label}</span>
            </div>
          )}
          <PasswordInput value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
            placeholder="Confirm new password" autoComplete="new-password" minLength={8} />
          {error && <p className="missed-error">{error}</p>}
          <button className="save-btn" disabled={loading}>
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </section>
    </div>
  )
}

function Main() {
  const [tab, setTab] = useState('checkin')
  const [session, setSession] = useState(undefined)
  const [setupDone, setSetupDone] = useState(undefined)
  const [visitedTabs, setVisitedTabs] = useState({ checkin: true, stats: false, settings: false })
  const [theme, setTheme] = useState(getPreferredTheme)
  const [recoveryMode, setRecoveryMode] = useState(false)

  async function checkSetup(userId) {
    const [goalsRes, partnersRes] = await Promise.all([
      supabase.from('goals').select('id').eq('user_id', userId).limit(1),
      supabase.from('accountability_partners').select('id').eq('user_id', userId).limit(3),
    ])
    const hasGoals = (goalsRes.data || []).length >= 1
    const hasPartners = (partnersRes.data || []).length >= 3
    setSetupDone(hasGoals && hasPartners)
  }

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true)
      }
      setSession(s)
      if (!s) setSetupDone(undefined)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    const userId = session.user.id
    checkSetup(userId)
    // Check notification reminder
    try {
      checkNotificationReminder(userId)
    } catch (err) {
      console.error('Notification reminder check failed:', err)
    }
  }, [session])

  useEffect(() => {
    setVisitedTabs(prev => (prev[tab] ? prev : { ...prev, [tab]: true }))
  }, [tab])

  useEffect(() => {
    if (!session?.user?.id) return
    setTab('checkin')
    setVisitedTabs({ checkin: true, stats: false, settings: false })
  }, [session?.user?.id])

  if (session === undefined || (session && setupDone === undefined)) {
    return (
      <div className="app">
        <header><h1>Accountabuddy</h1></header>
        <section className="card"><p className="vote-status">Loading...</p></section>
      </div>
    )
  }

  if (!session) return <LoginPage />

  if (recoveryMode) return <ResetPasswordPage />

  const userId = session.user.id

  async function handleLogout() { await supabase.auth.signOut() }

  // Onboarding — strict setup required
  if (setupDone === false) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <SettingsPage userId={userId}
          theme={theme}
          onToggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
          onLogout={handleLogout}
          onSetupComplete={() => { setSetupDone(true); setTab('checkin') }} />
      </Suspense>
    )
  }

  return (
    <div className="main-shell">
      <TabNav tab={tab} setTab={setTab} />
      <Suspense fallback={<LoadingFallback />}>
        {visitedTabs.checkin && (
          <div className={`tab-panel ${tab === 'checkin' ? 'tab-panel-active' : 'tab-panel-hidden'}`}>
            <App userId={userId} />
          </div>
        )}
        {visitedTabs.stats && (
          <div className={`tab-panel ${tab === 'stats' ? 'tab-panel-active' : 'tab-panel-hidden'}`}>
            <StatsPage userId={userId} />
          </div>
        )}
        {visitedTabs.settings && (
          <div className={`tab-panel ${tab === 'settings' ? 'tab-panel-active' : 'tab-panel-hidden'}`}>
            <SettingsPage
              userId={userId}
              theme={theme}
              onToggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
              onLogout={handleLogout}
            />
          </div>
        )}
      </Suspense>
    </div>
  )
}

function Router() {
  useEffect(() => { applyTheme(getPreferredTheme()) }, [])
  const path = window.location.pathname
  if (path === '/vote') return <Suspense fallback={<LoadingFallback />}><VotePage /></Suspense>
  if (path === '/punish') return <Suspense fallback={<LoadingFallback />}><PunishPage /></Suspense>
  if (path === '/cheer') return <Suspense fallback={<LoadingFallback />}><CheerPage /></Suspense>
  if (path === '/feedback') return <Suspense fallback={<LoadingFallback />}><FeedbackPage /></Suspense>
  return <Main />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router />
  </StrictMode>,
)
