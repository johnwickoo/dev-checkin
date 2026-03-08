import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import VotePage from './VotePage.jsx'
import StatsPage from './StatsPage.jsx'
import { supabase } from './supabase.js'

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('login') // 'login' or 'signup'

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error: authError } = mode === 'signup'
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password })

    if (authError) {
      setError(authError.message)
    }
    setLoading(false)
  }

  return (
    <div className="app">
      <header>
        <h1>Daily Dev Check-in</h1>
        <p className="date">{mode === 'login' ? 'Sign in to continue' : 'Create your account'}</p>
      </header>

      <section className="card">
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="email"
            className="field-input"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            type="password"
            className="field-input"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
          {error && <p className="missed-error">{error}</p>}
          <button className="save-btn" disabled={loading}>
            {loading ? 'Loading...' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
        </form>
        <button
          className="history-toggle"
          onClick={() => setMode(m => m === 'login' ? 'signup' : 'login')}
        >
          {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </section>
    </div>
  )
}

function TabNav({ tab, setTab, onLogout }) {
  return (
    <nav className="tab-nav">
      <button
        className={`tab-btn ${tab === 'checkin' ? 'tab-active' : ''}`}
        onClick={() => setTab('checkin')}
      >
        Check-in
      </button>
      <button
        className={`tab-btn ${tab === 'stats' ? 'tab-active' : ''}`}
        onClick={() => setTab('stats')}
      >
        Stats
      </button>
      <button className="tab-btn tab-logout" onClick={onLogout}>
        Log out
      </button>
    </nav>
  )
}

function Main() {
  const [tab, setTab] = useState('checkin')
  const [session, setSession] = useState(undefined) // undefined = loading

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <div className="app">
        <header>
          <h1>Daily Dev Check-in</h1>
        </header>
        <section className="card">
          <p className="vote-status">Loading...</p>
        </section>
      </div>
    )
  }

  if (!session) {
    return <LoginPage />
  }

  async function handleLogout() {
    await supabase.auth.signOut()
  }

  return (
    <>
      <TabNav tab={tab} setTab={setTab} onLogout={handleLogout} />
      {tab === 'checkin' && <App />}
      {tab === 'stats' && <StatsPage />}
    </>
  )
}

function Router() {
  const path = window.location.pathname
  if (path === '/vote') return <VotePage />
  return <Main />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router />
  </StrictMode>,
)
