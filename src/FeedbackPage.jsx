import { useState } from 'react'
import { supabase } from './supabase.js'

const CATEGORIES = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'other', label: 'Other' },
]

function FeedbackPage() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('improvement')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [status, setStatus] = useState('ready')

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || trimmed.length < 5) return

    setSubmitting(true)
    const { data, error } = await supabase.rpc('submit_feedback', {
      p_email: email.trim().toLowerCase(),
      p_name: name.trim(),
      p_category: category,
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
      setSubmitted(true)
      setStatus('ready')
    } else {
      setStatus('error')
    }
    setSubmitting(false)
  }

  if (submitted) {
    return (
      <div className="app">
        <header>
          <h1>Feedback</h1>
          <p className="date">Thanks for helping us improve!</p>
        </header>
        <section className="card card-accent-green">
          <h2>Received</h2>
          <p className="subtitle">
            Your feedback has been submitted. We read every single one.
          </p>
          <button className="history-toggle" onClick={() => {
            setSubmitted(false)
            setMessage('')
          }}>
            Send Another
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Feedback</h1>
        <p className="date">Help us build a better Accountabuddy — we're in v1 and value your input.</p>
      </header>

      <section className="card card-accent-green">
        <h2>What's on your mind?</h2>
        <form onSubmit={handleSubmit} className="feedback-form">
          <input
            type="email"
            className="field-input"
            placeholder="Your email (optional, for follow-up)"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <input
            type="text"
            className="field-input"
            placeholder="Your name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={50}
          />
          <select
            className="field-input feedback-category"
            value={category}
            onChange={e => setCategory(e.target.value)}
          >
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <textarea
            className="field-input feedback-textarea"
            placeholder="Tell us what you'd like improved, what's broken, or what feature you wish existed..."
            value={message}
            onChange={e => setMessage(e.target.value)}
            maxLength={2000}
            minLength={5}
            rows={5}
            required
          />
          <div className="punish-char-count">{message.length}/2000</div>
          <button
            className="save-btn"
            disabled={submitting || message.trim().length < 5}
          >
            {submitting ? 'Sending...' : 'Submit Feedback'}
          </button>
        </form>

        {status === 'rate_limited' && (
          <p className="missed-error">Too many submissions today — try again tomorrow.</p>
        )}
        {status === 'error' && (
          <p className="missed-error">Something went wrong. Try again.</p>
        )}
      </section>
    </div>
  )
}

export default FeedbackPage
