import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

function VotePage() {
  const params = new URLSearchParams(window.location.search || window.location.hash.replace('#/vote', '').replace('?', ''))
  const voteToken = params.get('token') || ''
  const requestedVote = params.get('vote') || ''

  const [status, setStatus] = useState('loading')
  const [submitting, setSubmitting] = useState(false)
  const [existingVote, setExistingVote] = useState(null)
  const [missedDate, setMissedDate] = useState('')
  const [excuseText, setExcuseText] = useState('')
  const [autoVoteDone, setAutoVoteDone] = useState(false)

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
      setStatus('voted')
    } else if (row.status === 'already_voted') {
      setExistingVote(row.vote || existingVote || vote)
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

  useEffect(() => {
    if (autoVoteDone) return
    if (status !== 'ready') return
    if (requestedVote !== 'accept' && requestedVote !== 'reject') return
    setAutoVoteDone(true)
    castVote(requestedVote)
  }, [autoVoteDone, status, requestedVote])

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

      {status === 'ready' && (
        <section className="card">
          <h2>Cast Your Vote</h2>
          <p className="vote-prompt">Is this excuse acceptable?</p>
          <div className="vote-buttons">
            <button
              className="vote-btn vote-accept"
              onClick={() => castVote('accept')}
              disabled={submitting}
            >
              {submitting ? '...' : 'Accept'}
            </button>
            <button
              className="vote-btn vote-reject"
              onClick={() => castVote('reject')}
              disabled={submitting}
            >
              {submitting ? '...' : 'Reject'}
            </button>
          </div>
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
        </section>
      )}
    </div>
  )
}

export default VotePage
