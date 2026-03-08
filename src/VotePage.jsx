import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

function VotePage() {
  const params = new URLSearchParams(window.location.search || window.location.hash.replace('#/vote', '').replace('?', ''))
  const excuseId   = params.get('id') || ''
  const voterEmail = params.get('email') || ''
  const missedDate = params.get('date') || ''
  const excuseText = params.get('excuse') || ''

  const [status, setStatus] = useState('loading')
  const [submitting, setSubmitting] = useState(false)
  const [existingVote, setExistingVote] = useState(null)

  useEffect(() => {
    if (!excuseId || !voterEmail) {
      setStatus('invalid')
      return
    }
    checkExistingVote()
  }, [])

  async function checkExistingVote() {
    const { data, error } = await supabase
      .from('excuse_votes')
      .select('vote')
      .eq('excuse_id', excuseId)
      .eq('voter_email', voterEmail)
      .maybeSingle()

    if (error) {
      console.error('Supabase read error:', error)
      setStatus('error')
      return
    }

    if (data) {
      setExistingVote(data.vote)
      setStatus('already_voted')
    } else {
      setStatus('ready')
    }
  }

  async function castVote(vote) {
    setSubmitting(true)

    const { error } = await supabase
      .from('excuse_votes')
      .insert({
        excuse_id: excuseId,
        missed_date: missedDate,
        voter_email: voterEmail,
        vote,
        excuse_text: excuseText || null,
      })

    if (error) {
      if (error.code === '23505') {
        setExistingVote(vote)
        setStatus('already_voted')
      } else {
        console.error('Supabase insert error:', error)
        setStatus('error')
      }
    } else {
      setExistingVote(vote)
      setStatus('voted')
    }

    setSubmitting(false)
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
          <p className="vote-status">Invalid voting link. Missing required parameters (id, email).</p>
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
