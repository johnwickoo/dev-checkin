import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
      <button type="button" className="pw-eye-btn" onClick={() => setShowPw(v => !v)} tabIndex={-1}
        aria-label={showPw ? 'Hide password' : 'Show password'}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {showPw ? (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </>
          ) : (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </>
          )}
        </svg>
      </button>
    </div>
  )
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

function SettingsPage({ userId, onSetupComplete, onSkip, onLogout, theme = 'dark', onToggleTheme }) {
  const [goals, setGoals] = useState([])
  const [completedGoals, setCompletedGoals] = useState([])
  const [abandonedGoals, setAbandonedGoals] = useState([])
  const [abandonedReasons, setAbandonedReasons] = useState({})
  const [partners, setPartners] = useState([])
  const [newGoal, setNewGoal] = useState('')
  const [newDeadline, setNewDeadline] = useState('')
  const [newPartner, setNewPartner] = useState('')
  const [loading, setLoading] = useState(true)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showRestDays, setShowRestDays] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => localStorage.getItem('accountabuddy_autosave') === 'true')

  // Rest days
  const [restDays, setRestDays] = useState([])

  // Notification reminder
  const [reminderHour, setReminderHour] = useState(21)
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  )

  async function loadData() {
    setLoading(true)
    const [goalsRes, completedGoalsRes, abandonedRes, partnersRes, settingsRes] = await Promise.all([
      supabase.from('goals').select('*').eq('user_id', userId).eq('active', true).order('created_at'),
      supabase.from('goals').select('*').eq('user_id', userId).not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(20),
      supabase.from('goals').select('*').eq('user_id', userId).eq('active', false).is('completed_at', null)
        .not('abandoned_at', 'is', null).order('abandoned_at', { ascending: false }),
      supabase.from('accountability_partners').select('*').eq('user_id', userId).order('created_at'),
      supabase.from('user_settings').select('*').eq('user_id', userId).maybeSingle(),
    ])
    if (goalsRes.data) setGoals(goalsRes.data)
    if (completedGoalsRes.data) setCompletedGoals(completedGoalsRes.data)
    if (abandonedRes.data) setAbandonedGoals(abandonedRes.data)
    if (partnersRes.data) setPartners(partnersRes.data)

    // Load rest days from server (fall back to localStorage for migration)
    const serverSettings = settingsRes.data
    if (serverSettings) {
      setRestDays(serverSettings.rest_days || [])
      setReminderHour(serverSettings.reminder_hour ?? 21)
    } else {
      const stored = JSON.parse(localStorage.getItem(`rest_days_${userId}`) || '[]')
      setRestDays(stored)
      const hour = parseInt(localStorage.getItem(`reminder_hour_${userId}`) || '21', 10)
      setReminderHour(hour)
    }
    setAutoSaveEnabled(localStorage.getItem('accountabuddy_autosave') === 'true')

    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  async function addGoal() {
    const title = newGoal.trim()
    if (!title) return
    setSaving(true)
    setError('')
    const { data, error: err } = await supabase
      .from('goals')
      .insert({ user_id: userId, title, deadline: newDeadline || null, completed_at: null, active: true })
      .select()
      .single()
    if (err) {
      setError(err.message)
    } else {
      setGoals(prev => [...prev, data])
      setNewGoal('')
      setNewDeadline('')
    }
    setSaving(false)
  }

  async function removeGoal(id) {
    if (goals.length <= 1) {
      setError('Keep at least 1 active goal for accountability.')
      return
    }
    await supabase.from('goals').update({ active: false, completed_at: null }).eq('id', id)
    const goal = goals.find(g => g.id === id)
    setGoals(prev => prev.filter(g => g.id !== id))
    setCompletedGoals(prev => prev.filter(g => g.id !== id))
    if (goal) {
      setAbandonedGoals(prev => [{ ...goal, active: false, abandoned_at: new Date().toISOString() }, ...prev])
    }
  }

  async function completeGoal(id) {
    const completedAt = new Date().toISOString()
    await supabase.from('goals').update({ active: false, completed_at: completedAt }).eq('id', id)
    const goal = goals.find(g => g.id === id)
    setGoals(prev => prev.filter(g => g.id !== id))
    if (goal) {
      setCompletedGoals(prev => [{ ...goal, active: false, completed_at: completedAt }, ...prev])
    }
  }

  async function reactivateGoal(id) {
    await supabase.from('goals').update({ active: true, completed_at: null }).eq('id', id)
    const goal = completedGoals.find(g => g.id === id)
    setCompletedGoals(prev => prev.filter(g => g.id !== id))
    if (goal) {
      setGoals(prev => [...prev, { ...goal, active: true, completed_at: null }])
    }
  }

  async function reactivateAbandoned(id) {
    await supabase.from('goals').update({ active: true, completed_at: null }).eq('id', id)
    const goal = abandonedGoals.find(g => g.id === id)
    setAbandonedGoals(prev => prev.filter(g => g.id !== id))
    if (goal) {
      setGoals(prev => [...prev, { ...goal, active: true, completed_at: null, abandoned_at: null, abandoned_reason: null }])
    }
  }

  async function submitAbandonedReason(id) {
    const reason = (abandonedReasons[id] || '').trim()
    if (!reason) return
    await supabase.rpc('submit_abandonment_reason', { p_goal_id: id, p_reason: reason })
    setAbandonedGoals(prev => prev.map(g => g.id === id ? { ...g, abandoned_reason: reason } : g))
    setAbandonedReasons(prev => { const next = { ...prev }; delete next[id]; return next })
  }

  async function addPartner() {
    const email = newPartner.trim().toLowerCase()
    if (!email || !email.includes('@')) return
    setSaving(true)
    setError('')
    const { data, error: err } = await supabase
      .from('accountability_partners')
      .insert({ user_id: userId, email })
      .select()
      .single()
    if (err) {
      if (err.code === '23505') setError('Partner already added')
      else setError(err.message)
    } else {
      setPartners(prev => [...prev, data])
      setNewPartner('')
    }
    setSaving(false)
  }

  async function removePartner(id) {
    if (partners.length <= 1) {
      setError('At least 1 accountability partner is required.')
      return
    }
    await supabase.from('accountability_partners').delete().eq('id', id)
    setPartners(prev => prev.filter(p => p.id !== id))
  }

  async function saveSettings(updates) {
    const { error: err } = await supabase.from('user_settings')
      .upsert({ user_id: userId, ...updates }, { onConflict: 'user_id' })
    if (err) setError(err.message)
  }

  function toggleRestDay(day) {
    setRestDays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
      if (next.length > 2) {
        setError('Maximum 2 rest days per week allowed')
        return prev
      }
      setError('')
      saveSettings({ rest_days: next })
      return next
    })
  }

  function handleReminderHour(val) {
    const h = Math.max(0, Math.min(23, parseInt(val, 10) || 0))
    setReminderHour(h)
    saveSettings({ reminder_hour: h })
  }

  function toggleAutoSave() {
    const next = !autoSaveEnabled
    setAutoSaveEnabled(next)
    localStorage.setItem('accountabuddy_autosave', next ? 'true' : 'false')
    window.dispatchEvent(new CustomEvent('accountabuddy:autosave-changed', { detail: { enabled: next } }))
  }

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
  }

  const isSetupDone = goals.length >= 1 && partners.length >= 1

  if (loading) {
    return (
      <div className="app">
        <section className="card">
          <p className="vote-status">Loading settings...</p>
        </section>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Settings</h1>
        <p className="date">Set up your goals and accountability partners</p>
        <p className="streak-quality">
          {isSetupDone ? 'Setup complete' : `Setup in progress: ${Math.min(goals.length, 1)}/1 goal, ${partners.length}/1 partner`}
        </p>
      </header>

      <section className="card card-accent-green">
        <h2>Goals ({goals.length})</h2>
        <p className="subtitle">What are you working toward? Add at least 1.</p>

        <div className="settings-list">
          {goals.map(goal => (
            <div key={goal.id} className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-name">{goal.title}</span>
                {goal.deadline && (
                  <span className="settings-item-sub">due {goal.deadline}</span>
                )}
              </div>
              <div className="settings-item-actions">
                <button className="settings-complete" onClick={() => completeGoal(goal.id)}>Done</button>
                <button className="settings-remove" onClick={() => removeGoal(goal.id)}>x</button>
              </div>
            </div>
          ))}
        </div>

        <div className="settings-add">
          <input
            type="text"
            className="field-input"
            placeholder="Goal title (e.g., Learn Rust, Build portfolio)"
            value={newGoal}
            onChange={e => setNewGoal(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addGoal()}
          />
          <input
            type="date"
            className="field-input settings-date-input"
            value={newDeadline}
            onChange={e => setNewDeadline(e.target.value)}
            min={new Date().toISOString().split('T')[0]}
          />
          <button className="save-btn settings-add-btn" onClick={addGoal} disabled={saving || !newGoal.trim()}>
            Add Goal
          </button>
        </div>
      </section>

      {completedGoals.length > 0 && (
        <section className="card">
          <h2>Completed Goals ({completedGoals.length})</h2>
          <p className="subtitle">Finished goals are removed from daily streak requirements.</p>
          <div className="settings-list">
            {completedGoals.map(goal => (
              <div key={goal.id} className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-name">{goal.title}</span>
                  <span className="settings-item-sub">
                    completed {new Date(goal.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <button className="history-toggle settings-reactivate" onClick={() => reactivateGoal(goal.id)}>
                  Reactivate
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {abandonedGoals.length > 0 && (
        <section className="card card-accent-red">
          <h2>Abandoned Goals ({abandonedGoals.length})</h2>
          <p className="subtitle">
            Goals you dropped. After 30 days, your accountability partners will be notified.
          </p>
          <div className="settings-list">
            {abandonedGoals.map(goal => {
              const daysAgo = goal.abandoned_at
                ? Math.floor((Date.now() - new Date(goal.abandoned_at).getTime()) / 86400000)
                : 0
              return (
                <div key={goal.id} className="settings-item abandoned-goal-item">
                  <div className="settings-item-info">
                    <span className="settings-item-name">{goal.title}</span>
                    <span className={`settings-item-sub ${daysAgo >= 30 ? 'abandoned-overdue' : ''}`}>
                      dropped {daysAgo} day{daysAgo === 1 ? '' : 's'} ago
                      {daysAgo >= 30 && ' — partners notified'}
                    </span>
                    {goal.abandoned_reason ? (
                      <span className="settings-item-sub">Reason: {goal.abandoned_reason}</span>
                    ) : (
                      <div className="abandoned-reason-row">
                        <input
                          type="text"
                          className="field-input abandoned-reason-input"
                          placeholder="Why did you drop this?"
                          value={abandonedReasons[goal.id] || ''}
                          onChange={e => setAbandonedReasons(prev => ({ ...prev, [goal.id]: e.target.value }))}
                          maxLength={200}
                        />
                        <button
                          className="save-btn settings-add-btn"
                          disabled={!(abandonedReasons[goal.id] || '').trim()}
                          onClick={() => submitAbandonedReason(goal.id)}
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                  <button className="history-toggle settings-reactivate" onClick={() => reactivateAbandoned(goal.id)}>
                    Reactivate
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="card">
        <h2>Accountability Partners ({partners.length})</h2>
        <p className="subtitle">
          People who will vote on your excuses. Minimum 1 required.
        </p>

        <div className="settings-list">
          {partners.map(p => (
            <div key={p.id} className="settings-item">
              <span className="settings-item-name">{p.email}</span>
              <button
                className="settings-remove"
                onClick={() => removePartner(p.id)}
                disabled={partners.length <= 1}
                title={partners.length <= 1 ? 'Need at least 1 partner' : 'Remove partner'}
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div className="settings-add">
          <input
            type="email"
            className="field-input"
            placeholder="Partner's email"
            value={newPartner}
            onChange={e => setNewPartner(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addPartner()}
          />
          <button className="save-btn settings-add-btn" onClick={addPartner} disabled={saving || !newPartner.trim()}>
            Add Partner
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card-header" onClick={() => setShowRestDays(v => !v)}>
          Rest Days {showRestDays ? '' : '(hidden)'}
        </h2>
        {showRestDays && (
          <>
            <p className="subtitle">
              Select days you take off. Rest days won't break your streak or trigger missed-day excuses.
            </p>
            <div className="rest-day-grid">
              {DAY_NAMES.map((name, i) => (
                <button
                  key={i}
                  className={`rest-day-btn ${restDays.includes(i) ? 'rest-day-active' : ''}`}
                  onClick={() => toggleRestDay(i)}
                >
                  {name}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card card-accent-purple">
        <h2 className="card-header" onClick={() => setShowNotifications(v => !v)}>
          Notifications {showNotifications ? '' : '(hidden)'}
        </h2>
        {showNotifications && (
          <>
            <p className="subtitle">Get a browser reminder if you haven't checked in by a certain hour.</p>

            {notifPermission === 'granted' ? (
              <div className="notif-settings">
                <label className="notif-label">
                  Remind me after
                  <input
                    type="number"
                    className="field-input notif-hour-input"
                    min={0}
                    max={23}
                    value={reminderHour}
                    onChange={e => handleReminderHour(e.target.value)}
                  />
                  :00
                </label>
                <p className="settings-item-sub">
                  You'll get a notification if you haven't checked in by {reminderHour}:00.
                </p>
              </div>
            ) : notifPermission === 'denied' ? (
              <p className="empty-state">
                Notifications are blocked. Enable them in your browser settings to use reminders.
              </p>
            ) : (
              <button className="save-btn" onClick={requestNotifPermission}>
                Enable Browser Notifications
              </button>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Check-in Saving</h2>
        <p className="subtitle">Manual save is default. Enable autosave if you want check-ins saved automatically once complete.</p>
        <div className="settings-theme-row">
          <button
            className="theme-toggle"
            onClick={toggleAutoSave}
            aria-label={`Turn ${autoSaveEnabled ? 'off' : 'on'} autosave`}
          >
            <span className={`theme-toggle-switch ${autoSaveEnabled ? 'theme-toggle-switch-on' : ''}`}>
              <span className="theme-toggle-thumb" />
            </span>
            <span className="theme-toggle-label">{autoSaveEnabled ? 'Auto-save on' : 'Auto-save off'}</span>
          </button>
        </div>
        <p className="settings-item-sub settings-toggle-sub">
          {autoSaveEnabled
            ? 'App will save automatically when required fields are complete.'
            : 'You must tap "Save Check-in" each day.'}
        </p>
      </section>

      <section className="card card-accent-green">
        <h2>Encouragement Link</h2>
        <p className="subtitle">
          Share this with friends so they can send you encouragement. Auto-included in accountability emails.
          Unlocks for friends after a 7-day streak or completing a goal.
        </p>
        <div className="settings-add">
          <input
            type="text"
            className="field-input"
            readOnly
            value={`${window.location.origin}/cheer?for=${userId}`}
            onFocus={e => e.target.select()}
          />
          <button
            className="save-btn settings-add-btn"
            onClick={() => {
              navigator.clipboard.writeText(`${window.location.origin}/cheer?for=${userId}`)
              setError('Link copied!')
              setTimeout(() => setError(''), 2000)
            }}
          >
            Copy Link
          </button>
        </div>
      </section>

      <section className="card card-accent-red">
        <h2>Punishment Suggestions</h2>
        <p className="subtitle">
          Auto-included in accountability emails. Share manually only if you want extra suggestions.
        </p>
        <div className="settings-add">
          <input
            type="text"
            className="field-input"
            readOnly
            value={`${window.location.origin}/punish?for=${userId}`}
            onFocus={e => e.target.select()}
          />
          <button
            className="save-btn settings-add-btn"
            onClick={() => {
              navigator.clipboard.writeText(`${window.location.origin}/punish?for=${userId}`)
              setError('Link copied!')
              setTimeout(() => setError(''), 2000)
            }}
          >
            Copy Link
          </button>
        </div>
      </section>

      {(onToggleTheme || onLogout) && (
        <section className="card">
          <h2>Appearance & Account</h2>
          <p className="subtitle">Adjust display mode and manage your session.</p>
          {onToggleTheme && (
            <div className="settings-theme-row">
              <button
                className="theme-toggle"
                onClick={onToggleTheme}
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              >
                <span className={`theme-toggle-switch ${theme === 'dark' ? 'theme-toggle-switch-on' : ''}`}>
                  <span className="theme-toggle-thumb" />
                </span>
                <span className="theme-toggle-label">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
              </button>
            </div>
          )}

          <div className="change-pw-section">
            <h3 className="change-pw-title">Change Password</h3>
            <form onSubmit={async (e) => {
              e.preventDefault()
              setPwError(''); setPwSuccess('')
              if (pwNew.length < 8) { setPwError('New password must be at least 8 characters'); return }
              const strength = getPasswordStrength(pwNew)
              if (strength.score <= 1) { setPwError('New password is too weak. Add uppercase, numbers, or symbols.'); return }
              if (pwNew !== pwConfirm) { setPwError('New passwords don\'t match'); return }
              if (pwNew === pwCurrent) { setPwError('New password must be different from current'); return }
              setPwLoading(true)
              // Verify current password by re-signing in
              const { data: { user } } = await supabase.auth.getUser()
              const { error: signInErr } = await supabase.auth.signInWithPassword({
                email: user.email,
                password: pwCurrent,
              })
              if (signInErr) {
                setPwError('Current password is incorrect')
                setPwLoading(false)
                return
              }
              const { error: updateErr } = await supabase.auth.updateUser({ password: pwNew })
              if (updateErr) {
                setPwError(updateErr.message)
              } else {
                setPwSuccess('Password changed successfully')
                setPwCurrent(''); setPwNew(''); setPwConfirm('')
              }
              setPwLoading(false)
            }} className="change-pw-form">
              <PasswordInput value={pwCurrent} onChange={e => setPwCurrent(e.target.value)}
                placeholder="Current password" autoComplete="current-password" minLength={6} />
              <PasswordInput value={pwNew} onChange={e => setPwNew(e.target.value)}
                placeholder="New password (min 8 chars)" autoComplete="new-password" minLength={8} />
              {pwNew && (
                <div className="pw-strength">
                  <div className="pw-strength-bar">
                    <div className={`pw-strength-fill ${getPasswordStrength(pwNew).cls}`}
                      style={{ width: `${Math.min(getPasswordStrength(pwNew).score, 4) * 25}%` }} />
                  </div>
                  <span className={`pw-strength-label ${getPasswordStrength(pwNew).cls}`}>
                    {getPasswordStrength(pwNew).label}
                  </span>
                </div>
              )}
              <PasswordInput value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
                placeholder="Confirm new password" autoComplete="new-password" minLength={8} />
              {pwError && <p className="missed-error">{pwError}</p>}
              {pwSuccess && <p className="pw-success">{pwSuccess}</p>}
              <button className="save-btn" disabled={pwLoading || !pwCurrent || !pwNew || !pwConfirm}>
                {pwLoading ? 'Changing...' : 'Change Password'}
              </button>
            </form>
          </div>

          {onLogout && (
            <button className="history-toggle settings-logout-btn" onClick={onLogout}>
              Log out
            </button>
          )}
        </section>
      )}

      <section className="card">
        <h2>Feedback</h2>
        <p className="subtitle">We're in v1 — your input shapes what we build next.</p>
        <a href="/feedback" target="_blank" className="history-toggle feedback-link">
          Send us feedback
        </a>
      </section>

      {error && <p className="missed-error">{error}</p>}

      {onSetupComplete && (
        <>
          <button
            className="save-btn"
            disabled={!isSetupDone}
            onClick={onSetupComplete}
          >
            {isSetupDone ? 'Continue to Check-in' : `Need ${goals.length < 1 ? 'at least 1 goal' : ''}${goals.length < 1 && partners.length < 1 ? ' and ' : ''}${partners.length < 1 ? '1 partner' : ''}`}
          </button>
          {onSkip && !isSetupDone && (
            <button className="history-toggle" onClick={onSkip} style={{ marginTop: '0.5rem' }}>
              Skip for now — I'll set up later
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default SettingsPage
