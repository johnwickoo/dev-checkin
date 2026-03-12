import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

function VotePage() {
  const params = new URLSearchParams(window.location.search || window.location.hash.replace('#/vote', '').replace('?', ''))
  const voteToken = params.get('token') || ''
  const requestedVote = params.get('vote') || ''

  const [status, setStatus] = useState('loading')
  const [submitting, setSubmitting] = useState(false)
  const [existingVote, setExistingVote] = useState(null)
  const [selectedPunishment, setSelectedPunishment] = useState(null)
  const [customPunishment, setCustomPunishment] = useState('')
  const [missedDate, setMissedDate] = useState('')
  const [excuseText, setExcuseText] = useState('')
  const [autoVoteDone, setAutoVoteDone] = useState(false)
  const [showRejectForm, setShowRejectForm] = useState(false)

  async function loadVoteContext() {
    const { data, error } = await supabase
      .rpc('get_excuse_vote_context', { p_token: voteToken })

    if (error) {
      console.error('Vote context error:', error)
      setStatus('error')
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row || row.status === 'invalid_token') {
      setStatus('invalid')
      return
    }

    setMissedDate(row.missed_date || '')
    setExcuseText(row.excuse_text || '')
    if (row.existing_vote) setExistingVote(row.existing_vote)

    if (row.status === 'already_voted') {
      setStatus('already_voted')
    } else if (row.status === 'expired') {
      setStatus('expired')
    } else if (row.status === 'ready') {
      setStatus('ready')
    } else {
      setStatus('invalid')
    }
  }

  async function castVote(vote) {
    setSubmitting(true)

    const { data, error } = await supabase
      .rpc('cast_excuse_vote', { p_token: voteToken, p_vote: vote })
    if (error) {
      console.error('Vote submit error:', error)
      setStatus('error')
      setSubmitting(false)
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      setStatus('error')
      setSubmitting(false)
      return
    }

    if (row.status === 'voted') {
      setExistingVote(row.vote || vote)
      setSelectedPunishment(row.selected_punishment || null)
      setStatus('voted')
    } else if (row.status === 'already_voted') {
      setExistingVote(row.vote || existingVote || vote)
      setSelectedPunishment(row.selected_punishment || null)
      setStatus('already_voted')
    } else if (row.status === 'expired') {
      setStatus('expired')
    } else if (row.status === 'invalid_token') {
      setStatus('invalid')
    } else {
      setStatus('error')
    }

    setSubmitting(false)
  }

  useEffect(() => {
    if (!voteToken) {
      setStatus('invalid')
      return
    }
    loadVoteContext()
  }, [voteToken])

  // Auto-vote accept from email link, but reject needs custom punishment
  useEffect(() => {
    if (autoVoteDone) return
    if (status !== 'ready') return
    if (requestedVote === 'accept') {
      setAutoVoteDone(true)
      castVote('accept')
    } else if (requestedVote === 'reject') {
      setAutoVoteDone(true)
      setShowRejectForm(true)
    }
  }, [autoVoteDone, status, requestedVote])

  function handleRejectSubmit(e) {
    e.preventDefault()
    const punishment = customPunishment.trim()
    if (!punishment || punishment.length < 3) return
    castVote(`reject:${punishment}`)
  }

  return (
    <div className="app">
      <header>
        <h1>Excuse Vote</h1>
        <p className="date">Developer's excuse for {missedDate || 'unknown date'}</p>
      </header>

      {excuseText && (
        <section className="card">
          <h2>The Excuse</h2>
          <p className="vote-excuse">{decodeURIComponent(excuseText)}</p>
        </section>
      )}

      {status === 'loading' && (
        <section className="card">
          <p className="vote-status">Checking vote status...</p>
        </section>
      )}

      {status === 'invalid' && (
        <section className="card missed-card">
          <p className="vote-status">Invalid or malformed voting link.</p>
        </section>
      )}

      {status === 'expired' && (
        <section className="card missed-card">
          <p className="vote-status">This voting link has expired.</p>
        </section>
      )}

      {status === 'error' && (
        <section className="card missed-card">
          <p className="vote-status">Something went wrong. Check the Supabase config and try again.</p>
        </section>
      )}

      {status === 'ready' && !showRejectForm && (
        <section className="card">
          <h2>Cast Your Vote</h2>
          <p className="vote-prompt">Is this excuse acceptable?</p>
          <div className="vote-buttons">
            <button
              className="vote-btn vote-accept"
              onClick={() => castVote('accept')}
              disabled={submitting}
            >
              {submitting ? '...' : 'Accept — fair enough'}
            </button>
            <button
              className="vote-btn vote-reject"
              onClick={() => setShowRejectForm(true)}
              disabled={submitting}
            >
              Reject — nice try
            </button>
          </div>
        </section>
      )}

      {status === 'ready' && showRejectForm && (
        <section className="card card-accent-red">
          <h2>Assign a Punishment</h2>
          <p className="vote-prompt">
            What should they have to do today? Be creative but fair.
          </p>
          <form onSubmit={handleRejectSubmit}>
            <input
              type="text"
              className="field-input"
              placeholder="e.g., 50 push-ups and post a video"
              value={customPunishment}
              onChange={e => setCustomPunishment(e.target.value)}
              maxLength={200}
              minLength={3}
              autoFocus
              required
            />
            <div className="punish-char-count">{customPunishment.length}/200</div>
            <div className="vote-buttons" style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="vote-btn vote-accept"
                onClick={() => setShowRejectForm(false)}
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="submit"
                className="vote-btn vote-reject"
                disabled={submitting || customPunishment.trim().length < 3}
              >
                {submitting ? '...' : 'Reject + Assign'}
              </button>
            </div>
          </form>
        </section>
      )}

      {(status === 'voted' || status === 'already_voted') && (
        <section className="card">
          <p className="vote-thanks">
            {status === 'already_voted' ? 'You already voted' : 'Vote recorded'}:
            <span className={`vote-result ${existingVote}`}>
              {' '}{existingVote === 'accept' ? 'Accepted' : 'Rejected'}
            </span>
          </p>
          {status === 'voted' && (
            <p className="vote-sub">Thanks for holding them accountable.</p>
          )}
          {existingVote === 'reject' && selectedPunishment && (
            <p className="vote-sub">
              Assigned punishment: <strong>{selectedPunishment}</strong>
            </p>
          )}
        </section>
      )}
    </div>
  )
}

export default VotePage
