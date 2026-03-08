import { StrictMode, useState, useEffect, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { supabase } from './supabase.js'

// Code splitting — only load when needed
const StatsPage = lazy(() => import('./StatsPage.jsx'))
const SettingsPage = lazy(() => import('./SettingsPage.jsx'))
const VotePage = lazy(() => import('./VotePage.jsx'))

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

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('login')

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error: authError } = mode === 'signup'
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password })
    if (authError) setError(authError.message)
    setLoading(false)
  }

  return (
    <div className="app">
      <header>
        <h1>Daily Check-in</h1>
        <p className="date">{mode === 'login' ? 'Sign in to continue' : 'Create your account'}</p>
      </header>
      <section className="card">
        <form onSubmit={handleSubmit} className="login-form">
          <input type="email" className="field-input" placeholder="Email"
            value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
          <input type="password" className="field-input" placeholder="Password"
            value={password} onChange={e => setPassword(e.target.value)} required minLength={6}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          {error && <p className="missed-error">{error}</p>}
          <button className="save-btn" disabled={loading}>
            {loading ? 'Loading...' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>
        <button className="history-toggle" onClick={() => setMode(m => m === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </section>
    </div>
  )
}

function TabNav({ tab, setTab, onLogout }) {
  return (
    <nav className="tab-nav">
      <button className={`tab-btn ${tab === 'checkin' ? 'tab-active' : ''}`} onClick={() => setTab('checkin')}>Check-in</button>
      <button className={`tab-btn ${tab === 'stats' ? 'tab-active' : ''}`} onClick={() => setTab('stats')}>Stats</button>
      <button className={`tab-btn ${tab === 'settings' ? 'tab-active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      <button className="tab-btn tab-logout" onClick={onLogout}>Log out</button>
    </nav>
  )
}

// Check and show notification reminder
function checkNotificationReminder(userId) {
  if (Notification.permission !== 'granted') return
  const hour = parseInt(localStorage.getItem(`reminder_hour_${userId}`) || '21', 10)
  const now = new Date()
  if (now.getHours() < hour) return

  // Check if we already notified today
  const today = toDateKey(now)
  const lastNotified = localStorage.getItem(`last_notified_${userId}`)
  if (lastNotified === today) return

  localStorage.setItem(`last_notified_${userId}`, today)
  new Notification('Daily Check-in Reminder', {
    body: "Don't forget to log your check-in today!",
    icon: '/vite.svg',
  })
}

function Main() {
  const [tab, setTab] = useState('checkin')
  const [session, setSession] = useState(undefined)
  const [setupDone, setSetupDone] = useState(undefined)
  const [setupSkipped, setSetupSkipped] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) { setSetupDone(undefined); setSetupSkipped(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    const userId = session.user.id
    checkSetup(userId)
    // Check notification reminder
    try { checkNotificationReminder(userId) } catch {}
  }, [session])

  async function checkSetup(userId) {
    const [goalsRes, partnersRes] = await Promise.all([
      supabase.from('goals').select('id').eq('user_id', userId).eq('active', true).limit(1),
      supabase.from('accountability_partners').select('id').eq('user_id', userId).limit(3),
    ])
    const hasGoals = (goalsRes.data || []).length >= 1
    const hasPartners = (partnersRes.data || []).length >= 3
    setSetupDone(hasGoals && hasPartners)

    // Check if user skipped before (allow 3 days grace)
    const skipTs = localStorage.getItem(`setup_skipped_${userId}`)
    if (skipTs) {
      const daysAgo = (Date.now() - parseInt(skipTs, 10)) / 86400000
      if (daysAgo < 3) setSetupSkipped(true)
      else localStorage.removeItem(`setup_skipped_${userId}`)
    }
  }

  if (session === undefined || (session && setupDone === undefined && !setupSkipped)) {
    return (
      <div className="app">
        <header><h1>Daily Check-in</h1></header>
        <section className="card"><p className="vote-status">Loading...</p></section>
      </div>
    )
  }

  if (!session) return <LoginPage />

  const userId = session.user.id

  async function handleLogout() { await supabase.auth.signOut() }

  function handleSkipSetup() {
    localStorage.setItem(`setup_skipped_${userId}`, Date.now().toString())
    setSetupSkipped(true)
  }

  // Onboarding — needs setup (but can skip)
  if (setupDone === false && !setupSkipped) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <SettingsPage userId={userId}
          onSetupComplete={() => { setSetupDone(true); setTab('checkin') }}
          onSkip={handleSkipSetup} />
      </Suspense>
    )
  }

  return (
    <>
      <TabNav tab={tab} setTab={setTab} onLogout={handleLogout} />
      <Suspense fallback={<LoadingFallback />}>
        {tab === 'checkin' && <App userId={userId} />}
        {tab === 'stats' && <StatsPage userId={userId} />}
        {tab === 'settings' && <SettingsPage userId={userId} />}
      </Suspense>
    </>
  )
}

function Router() {
  const path = window.location.pathname
  if (path === '/vote') return <Suspense fallback={<LoadingFallback />}><VotePage /></Suspense>
  return <Main />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router />
  </StrictMode>,
)
