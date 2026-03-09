import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function SettingsPage({ userId, onSetupComplete, onSkip, onLogout, theme = 'dark', onToggleTheme }) {
  const [goals, setGoals] = useState([])
  const [completedGoals, setCompletedGoals] = useState([])
  const [partners, setPartners] = useState([])
  const [newGoal, setNewGoal] = useState('')
  const [newDeadline, setNewDeadline] = useState('')
  const [newPartner, setNewPartner] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showRestDays, setShowRestDays] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)

  // Rest days
  const [restDays, setRestDays] = useState([])

  // Notification reminder
  const [reminderHour, setReminderHour] = useState(21)
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  )

  async function loadData() {
    setLoading(true)
    const [goalsRes, completedGoalsRes, partnersRes, settingsRes] = await Promise.all([
      supabase.from('goals').select('*').eq('user_id', userId).eq('active', true).order('created_at'),
      supabase.from('goals').select('*').eq('user_id', userId).not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(20),
      supabase.from('accountability_partners').select('*').eq('user_id', userId).order('created_at'),
      supabase.from('user_settings').select('*').eq('user_id', userId).maybeSingle(),
    ])
    if (goalsRes.data) setGoals(goalsRes.data)
    if (completedGoalsRes.data) setCompletedGoals(completedGoalsRes.data)
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
    setGoals(prev => prev.filter(g => g.id !== id))
    setCompletedGoals(prev => prev.filter(g => g.id !== id))
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
    if (partners.length <= 3) {
      setError('At least 3 accountability partners are required.')
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

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setNotifPermission(result)
  }

  const isSetupDone = goals.length >= 1 && partners.length >= 3

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
          {isSetupDone ? 'Setup complete' : `Setup in progress: ${Math.min(goals.length, 1)}/1 goal, ${partners.length}/3 partners`}
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

      <section className="card">
        <h2>Accountability Partners ({partners.length})</h2>
        <p className="subtitle">
          People who will vote on your excuses. Minimum 3 required.
        </p>

        <div className="settings-list">
          {partners.map(p => (
            <div key={p.id} className="settings-item">
              <span className="settings-item-name">{p.email}</span>
              <button
                className="settings-remove"
                onClick={() => removePartner(p.id)}
                disabled={partners.length <= 3}
                title={partners.length <= 3 ? 'Need at least 3 partners' : 'Remove partner'}
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

      <section className="card card-accent-green">
        <h2>Encouragement Link</h2>
        <p className="subtitle">
          Share this with friends so they can send you encouragement. Auto-included in accountability emails.
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
          {onLogout && (
            <button className="history-toggle settings-logout-btn" onClick={onLogout}>
              Log out
            </button>
          )}
        </section>
      )}

      {error && <p className="missed-error">{error}</p>}

      {onSetupComplete && (
        <>
          <button
            className="save-btn"
            disabled={!isSetupDone}
            onClick={onSetupComplete}
          >
            {isSetupDone ? 'Continue to Check-in' : `Need ${goals.length < 1 ? 'at least 1 goal' : ''}${goals.length < 1 && partners.length < 3 ? ' and ' : ''}${partners.length < 3 ? `${3 - partners.length} more partner${3 - partners.length > 1 ? 's' : ''}` : ''}`}
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
