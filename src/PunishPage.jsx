import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

function PunishPage() {
  const params = new URLSearchParams(window.location.search)
  const userId = params.get('for') || ''

  const [email, setEmail] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState([])
  const [status, setStatus] = useState(userId ? 'ready' : 'invalid')

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = suggestion.trim()
    if (!trimmed || trimmed.length < 3 || !email.includes('@')) return

    setSubmitting(true)
    const { data, error } = await supabase.rpc('submit_punishment_suggestion', {
      p_user_id: userId,
      p_email: email.trim().toLowerCase(),
      p_suggestion: trimmed,
    })

    if (error) {
      setStatus('error')
      setSubmitting(false)
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    if (row?.status === 'rate_limited') {
      setStatus('rate_limited')
    } else {
      setSubmitted(prev => [...prev, trimmed])
      setSuggestion('')
      setStatus('ready')
    }
    setSubmitting(false)
  }

  if (status === 'invalid') {
    return (
      <div className="app">
        <header>
          <h1>Suggest a Punishment</h1>
          <p className="date">Missing user link — ask your friend for the correct URL.</p>
        </header>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Suggest a Punishment</h1>
        <p className="date">Your friend missed their check-in. What should they do?</p>
      </header>

      <section className="card">
        <h2>How it works</h2>
        <p className="subtitle">
          Suggest a consequence for when your friend skips their daily check-in.
          Be creative but fair — the group votes on which punishment to enforce.
        </p>
      </section>

      <section className="card card-accent-red">
        <h2>Your Suggestion</h2>
        <form onSubmit={handleSubmit} className="punish-form">
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
            placeholder="e.g., 50 pushups, no coffee for a day, write a blog post..."
            value={suggestion}
            onChange={e => setSuggestion(e.target.value)}
            maxLength={200}
            minLength={3}
            required
          />
          <div className="punish-char-count">{suggestion.length}/200</div>
          <button
            className="save-btn"
            disabled={submitting || suggestion.trim().length < 3 || !email.includes('@')}
          >
            {submitting ? 'Submitting...' : 'Submit Punishment Idea'}
          </button>
        </form>

        {status === 'rate_limited' && (
          <p className="missed-error">Too many suggestions — try again tomorrow.</p>
        )}
        {status === 'error' && (
          <p className="missed-error">Something went wrong. Try again.</p>
        )}
      </section>

      {submitted.length > 0 && (
        <section className="card">
          <h2>Your Submissions ({submitted.length})</h2>
          <div className="settings-list">
            {submitted.map((s, i) => (
              <div key={i} className="settings-item">
                <span className="settings-item-name">{s}</span>
              </div>
            ))}
          </div>
          <p className="subtitle" style={{ marginTop: '0.75rem' }}>
            Want to add another? Go for it.
          </p>
        </section>
      )}
    </div>
  )
}

export default PunishPage
