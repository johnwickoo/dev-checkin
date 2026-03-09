import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

const MOOD_LABELS = ['Burnt out', 'Low', 'Okay', 'Focused', 'Locked in']

function CheerPage() {
  const params = new URLSearchParams(window.location.search)
  const userId = params.get('for') || ''

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState([])
  const [status, setStatus] = useState(userId ? 'ready' : 'invalid')
  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    if (!userId) return
    loadStats()
  }, [userId])

  async function loadStats() {
    setStatsLoading(true)
    const { data, error } = await supabase.rpc('get_public_user_stats', { p_user_id: userId })
    if (!error && data) {
      const row = Array.isArray(data) ? data[0] : data
      if (row && row.total_checkins > 0) setStats(row)
    }
    setStatsLoading(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || trimmed.length < 2 || !email.includes('@')) return

    setSubmitting(true)
    const { data, error } = await supabase.rpc('submit_encouragement', {
      p_user_id: userId,
      p_email: email.trim().toLowerCase(),
      p_name: name.trim(),
      p_message: trimmed,
    })

    if (error) {
      setStatus('error')
      setSubmitting(false)
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    if (row?.status === 'rate_limited') {
      setStatus('rate_limited')
    } else if (row?.status === 'ok') {
      setSubmitted(prev => [...prev, trimmed])
      setMessage('')
      setStatus('ready')
    } else {
      setStatus('error')
    }
    setSubmitting(false)
  }

  function formatMemberSince(dateStr) {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }

  if (status === 'invalid') {
    return (
      <div className="app">
        <header>
          <h1>Send Encouragement</h1>
          <p className="date">Missing user link — ask your friend for the correct URL.</p>
        </header>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Send Encouragement</h1>
        <p className="date">Your friend is working hard. Cheer them on!</p>
      </header>

      {/* User stats — gives context for the encouragement */}
      {statsLoading ? (
        <section className="card">
          <p className="vote-status">Loading their progress...</p>
        </section>
      ) : stats ? (
        <section className="card card-accent-cheer">
          <h2>How They're Doing</h2>
          <div className="cheer-stats">
            <div className="cheer-stat">
              <span className="cheer-stat-value">{stats.current_streak}</span>
              <span className="cheer-stat-label">Day Streak</span>
            </div>
            <div className="cheer-stat">
              <span className="cheer-stat-value">{stats.total_checkins}</span>
              <span className="cheer-stat-label">Check-ins</span>
            </div>
            <div className="cheer-stat">
              <span className="cheer-stat-value">{stats.active_goal_count}</span>
              <span className="cheer-stat-label">Active Goals</span>
            </div>
            {stats.latest_mood > 0 && (
              <div className="cheer-stat">
                <span className="cheer-stat-value cheer-stat-mood">{MOOD_LABELS[stats.latest_mood - 1]}</span>
                <span className="cheer-stat-label">Last Mood</span>
              </div>
            )}
          </div>
          {stats.member_since && (
            <p className="cheer-since">Building since {formatMemberSince(stats.member_since)}</p>
          )}
          {stats.current_streak >= 7 && (
            <p className="cheer-highlight">
              {stats.current_streak >= 30 ? 'Incredible consistency!' :
               stats.current_streak >= 14 ? 'On a serious roll!' :
               'Building real momentum!'}
            </p>
          )}
        </section>
      ) : (
        <section className="card">
          <h2>Getting Started</h2>
          <p className="subtitle">
            Your friend just started their accountability journey. A little encouragement goes a long way!
          </p>
        </section>
      )}

      <section className="card card-accent-green">
        <h2>Your Message</h2>
        <form onSubmit={handleSubmit} className="cheer-form">
          <input
            type="email"
            className="field-input"
            placeholder="Your email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <input
            type="text"
            className="field-input"
            placeholder="Your name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={50}
          />
          <textarea
            className="field-input cheer-textarea"
            placeholder={stats?.current_streak >= 7
              ? `e.g., ${stats.current_streak} days strong! Keep that streak alive!`
              : 'e.g., Keep going! Your consistency is inspiring. You\'ve got this!'}
            value={message}
            onChange={e => setMessage(e.target.value)}
            maxLength={500}
            minLength={2}
            rows={3}
            required
          />
          <div className="punish-char-count">{message.length}/500</div>
          <button
            className="save-btn"
            disabled={submitting || message.trim().length < 2 || !email.includes('@')}
          >
            {submitting ? 'Sending...' : 'Send Encouragement'}
          </button>
        </form>

        {status === 'rate_limited' && (
          <p className="missed-error">You've sent a lot today — try again tomorrow!</p>
        )}
        {status === 'error' && (
          <p className="missed-error">Something went wrong. Try again.</p>
        )}
      </section>

      {submitted.length > 0 && (
        <section className="card">
          <h2>Sent ({submitted.length})</h2>
          <div className="settings-list">
            {submitted.map((s, i) => (
              <div key={i} className="settings-item">
                <span className="settings-item-name">{s}</span>
              </div>
            ))}
          </div>
          <p className="subtitle" style={{ marginTop: '0.75rem' }}>
            Want to send another? Go ahead — there's no such thing as too much encouragement.
          </p>
        </section>
      )}
    </div>
  )
}

export default CheerPage
