import { useState } from 'react'
import { supabase } from './supabase.js'

function CheerPage() {
  const params = new URLSearchParams(window.location.search)
  const userId = params.get('for') || ''

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState([])
  const [status, setStatus] = useState(userId ? 'ready' : 'invalid')

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
        <p className="date">Your friend is building something great. Cheer them on!</p>
      </header>

      <section className="card">
        <h2>Why it matters</h2>
        <p className="subtitle">
          Accountability isn't just about consequences — it's about support.
          A quick message can make the difference between giving up and pushing through.
        </p>
      </section>

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
            placeholder="e.g., Keep going! Your consistency is inspiring. You've got this!"
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
