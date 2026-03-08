import { useState, useEffect } from 'react'
import emailjs from '@emailjs/browser'
import { supabase } from './supabase.js'
import './App.css'

// ── EmailJS config ──────────────────────────────────────────
const EMAILJS_SERVICE_ID       = import.meta.env.VITE_EMAILJS_SERVICE_ID
const EMAILJS_TEMPLATE_ID      = import.meta.env.VITE_EMAILJS_TEMPLATE_ID
const EMAILJS_SHAME_TEMPLATE   = import.meta.env.VITE_EMAILJS_SHAME_TEMPLATE
const EMAILJS_PUBLIC_KEY       = import.meta.env.VITE_EMAILJS_PUBLIC_KEY

// ── Voting base URL ─────────────────────────────────────────
const VOTE_BASE_URL = import.meta.env.VITE_VOTE_BASE_URL

// ── Minimum votes needed to trigger verdict ─────────────────
const MIN_VOTES_FOR_VERDICT = 4

const ACCOUNTABILITY_EMAILS = [
  'Juwonbal@gmail.com',
  'Blackharjay@gmail.com',
  'issababtunde@gmail.com',
  'Joyindamola04@gmail.com',
  'Dammyruth242@gmail.com',
  'Sharuhnjacobs@gmail.com',
]

const STUDY_BLOCKS = ['Problem Solving', 'Python Backend', 'C++ Systems', 'Linux/Git']
const MOOD_LABELS = ['Burnt out', 'Low', 'Okay', 'Focused', 'Locked in']

function getToday() {
  return new Date().toISOString().split('T')[0]
}

function loadData(date) {
  const stored = localStorage.getItem(`checkin-${date}`)
  if (stored) return JSON.parse(stored)
  return {
    blocks: Object.fromEntries(STUDY_BLOCKS.map(b => [b, false])),
    problemsSolved: 0,
    mood: 0,
    learned: '',
    built: '',
    builtLink: '',
    proofUrl: '',
  }
}

function saveData(date, data) {
  localStorage.setItem(`checkin-${date}`, JSON.stringify(data))
}

function getYesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().split('T')[0]
}

function checkMissedYesterday() {
  const yesterday = getYesterday()
  const stored = localStorage.getItem(`checkin-${yesterday}`)
  if (!stored) return yesterday
  const parsed = JSON.parse(stored)
  if (parsed.missedReason) return null
  const hasActivity = parsed.mood > 0
    || parsed.problemsSolved > 0
    || Object.values(parsed.blocks).some(Boolean)
  return hasActivity ? null : yesterday
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function dateOffset(dateStr, offset) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + offset)
  return dt.toISOString().split('T')[0]
}

function isActiveEntry(entry) {
  if (!entry) return false
  if (entry.missedReason) return false
  return entry.mood > 0
    || entry.problemsSolved > 0
    || (entry.blocks && Object.values(entry.blocks).some(Boolean))
}

function getStreak(today) {
  let streak = 0
  const todayEntry = localStorage.getItem(`checkin-${today}`)
  if (todayEntry && isActiveEntry(JSON.parse(todayEntry))) {
    streak = 1
  }
  let date = dateOffset(today, -1)
  while (true) {
    const stored = localStorage.getItem(`checkin-${date}`)
    if (!stored || !isActiveEntry(JSON.parse(stored))) break
    streak++
    date = dateOffset(date, -1)
  }
  return streak
}

function getLast30Days(today) {
  const days = []
  for (let i = 29; i >= 0; i--) {
    const date = dateOffset(today, -i)
    const stored = localStorage.getItem(`checkin-${date}`)
    const entry = stored ? JSON.parse(stored) : null
    let status = 'none'
    if (entry && isActiveEntry(entry)) status = 'completed'
    else if (entry && entry.missedReason) status = 'missed'
    days.push({ date, status })
  }
  return days
}

function getAllEntries(today) {
  const entries = []
  for (let i = 0; i < 365; i++) {
    const date = dateOffset(today, -i)
    const stored = localStorage.getItem(`checkin-${date}`)
    if (!stored) continue
    const entry = JSON.parse(stored)
    if (isActiveEntry(entry) || entry.missedReason) {
      entries.push({ date, ...entry })
    }
  }
  return entries
}

function formatShortDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

async function checkVoteVerdicts() {
  // Scan localStorage for missed entries that have an excuseId but no verdict yet
  const pendingExcuses = []
  for (let i = 1; i <= 30; i++) {
    const date = dateOffset(getToday(), -i)
    const stored = localStorage.getItem(`checkin-${date}`)
    if (!stored) continue
    const entry = JSON.parse(stored)
    if (entry.excuseId && entry.emailSent && !entry.verdict) {
      pendingExcuses.push({ date, excuseId: entry.excuseId, excuse: entry.missedReason })
    }
  }

  for (const { date, excuseId, excuse } of pendingExcuses) {
    const { data: votes, error } = await supabase
      .from('excuse_votes')
      .select('vote')
      .eq('excuse_id', excuseId)

    if (error || !votes) continue
    if (votes.length < MIN_VOTES_FOR_VERDICT) continue

    const rejects = votes.filter(v => v.vote === 'reject').length
    const accepts = votes.filter(v => v.vote === 'accept').length
    const verdict = rejects > accepts ? 'rejected' : 'accepted'

    // Update localStorage with verdict
    const stored = localStorage.getItem(`checkin-${date}`)
    if (!stored) continue
    const entry = JSON.parse(stored)
    entry.verdict = verdict
    entry.voteCount = { accepts, rejects, total: votes.length }
    localStorage.setItem(`checkin-${date}`, JSON.stringify(entry))

    if (verdict === 'rejected' && !entry.shameEmailSent) {
      // Send shame email to each accountability partner
      try {
        for (const email of ACCOUNTABILITY_EMAILS) {
          await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_SHAME_TEMPLATE, {
            to_email: email,
            missed_date: formatDate(date),
            excuse_text: excuse,
            reject_count: rejects,
            total_votes: votes.length,
          }, EMAILJS_PUBLIC_KEY)
        }

        entry.shameEmailSent = true
        localStorage.setItem(`checkin-${date}`, JSON.stringify(entry))
      } catch (err) {
        console.error('Shame email error:', err)
      }
    }
  }
}

function getPendingPunishment() {
  for (let i = 1; i <= 30; i++) {
    const date = dateOffset(getToday(), -i)
    const stored = localStorage.getItem(`checkin-${date}`)
    if (!stored) continue
    const entry = JSON.parse(stored)
    if (entry.verdict === 'rejected' && !entry.punishmentAcknowledged) {
      return { date, excuse: entry.missedReason, voteCount: entry.voteCount }
    }
  }
  return null
}

function App() {
  const today = getToday()
  const [data, setData] = useState(() => loadData(today))
  const [saved, setSaved] = useState(false)
  const [missedDate, setMissedDate] = useState(() => checkMissedYesterday())
  const [missedReason, setMissedReason] = useState('')
  const [missedAvoidable, setMissedAvoidable] = useState(null)
  const [missedSending, setMissedSending] = useState(false)
  const [missedError, setMissedError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [punishment, setPunishment] = useState(null)
  const [punishmentInput, setPunishmentInput] = useState('')
  const [verdictChecked, setVerdictChecked] = useState(false)

  // Check vote verdicts on load
  useEffect(() => {
    checkVoteVerdicts().then(() => {
      setPunishment(getPendingPunishment())
      setVerdictChecked(true)
    }).catch(() => {
      setVerdictChecked(true)
    })
  }, [])

  useEffect(() => {
    saveData(today, data)
  }, [data, today])

  function acknowledgePunishment() {
    if (punishmentInput !== 'I will do better') return
    const stored = localStorage.getItem(`checkin-${punishment.date}`)
    if (stored) {
      const entry = JSON.parse(stored)
      entry.punishmentAcknowledged = true
      localStorage.setItem(`checkin-${punishment.date}`, JSON.stringify(entry))
    }
    setPunishment(null)
    setPunishmentInput('')
  }

  function getStreakBefore(date) {
    let count = 0
    let d = dateOffset(date, -1)
    while (true) {
      const stored = localStorage.getItem(`checkin-${d}`)
      if (!stored || !isActiveEntry(JSON.parse(stored))) break
      count++
      d = dateOffset(d, -1)
    }
    return count
  }

  async function handleMissedSubmit() {
    const excuse = missedReason.trim()
    if (excuse.length < 80 || missedAvoidable === null) return

    setMissedSending(true)
    setMissedError('')

    const streakBefore = getStreakBefore(missedDate)
    const excuseId = `${missedDate}-${Date.now()}`
    const encodedExcuse = encodeURIComponent(excuse)
    const voteLinks = ACCOUNTABILITY_EMAILS.map(email => ({
      email,
      accept: `${VOTE_BASE_URL}?id=${excuseId}&email=${encodeURIComponent(email)}&date=${missedDate}&excuse=${encodedExcuse}&vote=accept`,
      reject: `${VOTE_BASE_URL}?id=${excuseId}&email=${encodeURIComponent(email)}&date=${missedDate}&excuse=${encodedExcuse}&vote=reject`,
    }))

    try {
      // Send one email per accountability partner (with personalized vote links)
      for (const link of voteLinks) {
        await emailjs.send(
          EMAILJS_SERVICE_ID,
          EMAILJS_TEMPLATE_ID,
          {
            to_email: link.email,
            missed_date: formatDate(missedDate),
            excuse_text: excuse,
            was_avoidable: missedAvoidable ? 'Yes' : 'No',
            streak: streakBefore,
            accept_url: link.accept,
            reject_url: link.reject,
          },
          EMAILJS_PUBLIC_KEY,
        )
      }
      saveData(missedDate, {
        missedReason: excuse,
        wasAvoidable: missedAvoidable,
        excuseId,
        emailSent: true,
      })
      setMissedDate(null)
      setMissedReason('')
      setMissedAvoidable(null)
    } catch (err) {
      setMissedError('Failed to send email. Check your EmailJS config.')
      console.error('EmailJS error:', err)
    } finally {
      setMissedSending(false)
    }
  }

  function toggleBlock(name) {
    setData(prev => ({
      ...prev,
      blocks: { ...prev.blocks, [name]: !prev.blocks[name] },
    }))
    setSaved(false)
  }

  function setProblems(val) {
    const n = Math.max(0, parseInt(val) || 0)
    setData(prev => ({ ...prev, problemsSolved: n }))
    setSaved(false)
  }

  function setMood(level) {
    setData(prev => ({ ...prev, mood: level }))
    setSaved(false)
  }

  function updateField(field, value) {
    setData(prev => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  const canSave = (data.learned || '').trim().length >= 50
    && (data.built || '').trim().length > 0
    && (data.proofUrl || '').trim().length > 0

  function handleSave() {
    if (!canSave) return
    saveData(today, data)
    setSaved(true)
  }

  const completedBlocks = Object.values(data.blocks).filter(Boolean).length
  const dateDisplay = formatDate(today)

  // Punishment screen blocks everything until acknowledged
  if (!verdictChecked) {
    return (
      <div className="app">
        <header>
          <h1>Daily Dev Check-in</h1>
          <p className="date">{dateDisplay}</p>
        </header>
        <section className="card">
          <p className="vote-status">Checking accountability verdicts...</p>
        </section>
      </div>
    )
  }

  if (punishment) {
    const inputMatch = punishmentInput === 'I will do better'
    return (
      <div className="app">
        <header>
          <h1>Daily Dev Check-in</h1>
          <p className="date">{dateDisplay}</p>
        </header>

        <section className="card punishment-card">
          <h2>Excuse Rejected</h2>
          <p className="punishment-date">{formatDate(punishment.date)}</p>

          <div className="punishment-verdict">
            <span className="verdict-reject">{punishment.voteCount?.rejects || 0} Reject</span>
            <span className="verdict-sep">/</span>
            <span className="verdict-accept">{punishment.voteCount?.accepts || 0} Accept</span>
          </div>

          <p className="punishment-excuse">"{punishment.excuse}"</p>

          <div className="punishment-message">
            <p>Your excuse was rejected by the group.</p>
            <p>Your friends have been notified.</p>
            <p>You owe a task — check your email.</p>
          </div>

          <div className="punishment-gate">
            <p className="punishment-instruction">
              Type <strong>I will do better</strong> exactly to continue.
            </p>
            <input
              type="text"
              className={`field-input punishment-input ${inputMatch ? 'punishment-match' : ''}`}
              value={punishmentInput}
              onChange={e => setPunishmentInput(e.target.value)}
              placeholder="I will do better"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="save-btn"
              onClick={acknowledgePunishment}
              disabled={!inputMatch}
            >
              Acknowledge & Continue
            </button>
          </div>
        </section>
      </div>
    )
  }

  if (missedDate) {
    const charCount = missedReason.trim().length
    const canSubmitExcuse = charCount >= 80 && missedAvoidable !== null && !missedSending
    return (
      <div className="app">
        <header>
          <h1>Daily Dev Check-in</h1>
          <p className="date">{dateDisplay}</p>
        </header>

        <section className="card missed-card">
          <h2>Missed Day</h2>
          <p className="missed-date">{formatDate(missedDate)}</p>
          <p className="missed-prompt">
            You didn't check in yesterday. Write your excuse below.
            This will be emailed to 6 people who will vote on whether it's acceptable.
          </p>
          <textarea
            className="missed-textarea"
            placeholder="Be honest. What happened? (at least 80 characters)"
            value={missedReason}
            onChange={e => setMissedReason(e.target.value)}
            rows={5}
          />
          <p className={`char-count ${charCount >= 80 ? 'met' : ''}`}>
            {charCount}/80 characters
          </p>

          <div className="avoidable-section">
            <p className="avoidable-label">Was this avoidable?</p>
            <div className="avoidable-toggle">
              <button
                className={`toggle-btn ${missedAvoidable === true ? 'toggle-active toggle-yes' : ''}`}
                onClick={() => setMissedAvoidable(true)}
              >
                Yes
              </button>
              <button
                className={`toggle-btn ${missedAvoidable === false ? 'toggle-active toggle-no' : ''}`}
                onClick={() => setMissedAvoidable(false)}
              >
                No
              </button>
            </div>
          </div>

          {missedError && <p className="missed-error">{missedError}</p>}

          <button
            className="save-btn"
            onClick={handleMissedSubmit}
            disabled={!canSubmitExcuse}
          >
            {missedSending ? 'Sending...' : 'Submit Excuse & Notify Group'}
          </button>
        </section>
      </div>
    )
  }

  const streak = getStreak(today)
  const last30 = getLast30Days(today)
  const history = showHistory ? getAllEntries(today) : []

  return (
    <div className="app">
      <header>
        <h1>Daily Dev Check-in</h1>
        <p className="date">{dateDisplay}</p>
        {streak > 0 && (
          <p className="streak">{streak} day streak</p>
        )}
      </header>

      <section className="card">
        <h2>Last 30 Days</h2>
        <div className="dot-grid">
          {last30.map(({ date, status }) => (
            <div
              key={date}
              className={`dot dot-${status}`}
              title={`${formatShortDate(date)}: ${status}`}
            />
          ))}
        </div>
        <div className="dot-legend">
          <span><span className="dot dot-completed dot-inline" /> Completed</span>
          <span><span className="dot dot-missed dot-inline" /> Missed</span>
          <span><span className="dot dot-none dot-inline" /> No data</span>
        </div>
      </section>

      <section className="card">
        <h2>Study Blocks</h2>
        <p className="subtitle">{completedBlocks}/{STUDY_BLOCKS.length} completed</p>
        <div className="blocks">
          {STUDY_BLOCKS.map(name => (
            <label key={name} className={`block ${data.blocks[name] ? 'done' : ''}`}>
              <input
                type="checkbox"
                checked={data.blocks[name]}
                onChange={() => toggleBlock(name)}
              />
              <span className="checkmark" />
              <span className="block-name">{name}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Problems Solved</h2>
        <div className="problems">
          <button
            className="pm-btn"
            onClick={() => setProblems(data.problemsSolved - 1)}
            disabled={data.problemsSolved <= 0}
          >
            &minus;
          </button>
          <input
            type="number"
            min="0"
            value={data.problemsSolved}
            onChange={e => setProblems(e.target.value)}
            className="problems-input"
          />
          <button
            className="pm-btn"
            onClick={() => setProblems(data.problemsSolved + 1)}
          >
            +
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Mood / Energy</h2>
        {data.mood > 0 && (
          <p className="mood-current">{MOOD_LABELS[data.mood - 1]}</p>
        )}
        <div className="mood-scale">
          {MOOD_LABELS.map((label, i) => {
            const level = i + 1
            return (
              <button
                key={level}
                className={`mood-btn ${data.mood === level ? 'active' : ''}`}
                onClick={() => setMood(level)}
                title={label}
              >
                <span className="mood-num">{level}</span>
                <span className="mood-label">{label}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="card">
        <h2>What I Learned Today</h2>
        <textarea
          className="field-textarea"
          placeholder="What did you learn today? (at least 50 characters)"
          value={data.learned || ''}
          onChange={e => updateField('learned', e.target.value)}
          rows={3}
        />
        <p className={`char-count ${(data.learned || '').trim().length >= 50 ? 'met' : ''}`}>
          {(data.learned || '').trim().length}/50 characters
        </p>
      </section>

      <section className="card">
        <h2>What I Built / Wrote</h2>
        <textarea
          className="field-textarea"
          placeholder="Describe what you built or wrote today..."
          value={data.built || ''}
          onChange={e => updateField('built', e.target.value)}
          rows={3}
        />
        <input
          type="url"
          className="field-input"
          placeholder="GitHub link (optional)"
          value={data.builtLink || ''}
          onChange={e => updateField('builtLink', e.target.value)}
        />
      </section>

      <section className="card">
        <h2>Proof of Work</h2>
        <input
          type="url"
          className="field-input"
          placeholder="Commit URL, deployed link, or any proof..."
          value={data.proofUrl || ''}
          onChange={e => updateField('proofUrl', e.target.value)}
        />
      </section>

      <button className="save-btn" onClick={handleSave} disabled={!canSave}>
        {saved ? 'Saved!' : 'Save Check-in'}
      </button>

      <button
        className="history-toggle"
        onClick={() => setShowHistory(v => !v)}
      >
        {showHistory ? 'Hide History' : 'View History'}
      </button>

      {showHistory && (
        <section className="card history-card">
          <h2>History</h2>
          {history.length === 0 && (
            <p className="history-empty">No entries yet.</p>
          )}
          {history.map(entry => (
            <div key={entry.date} className={`history-entry ${entry.missedReason ? 'history-missed' : ''}`}>
              <div className="history-header">
                <span className="history-date">{formatDate(entry.date)}</span>
                {entry.missedReason && <span className="history-badge badge-missed">Missed</span>}
                {!entry.missedReason && <span className="history-badge badge-done">Completed</span>}
              </div>
              {entry.missedReason ? (
                <p className="history-reason">{entry.missedReason}</p>
              ) : (
                <div className="history-details">
                  <span>
                    {entry.blocks ? Object.entries(entry.blocks).filter(([, v]) => v).map(([k]) => k).join(', ') || 'No blocks' : 'No blocks'}
                  </span>
                  <span>{entry.problemsSolved || 0} problems</span>
                  <span>{entry.mood > 0 ? MOOD_LABELS[entry.mood - 1] : 'No mood'}</span>
                  {entry.learned && <span className="history-learned">{entry.learned}</span>}
                  {entry.built && <span className="history-built">{entry.built}</span>}
                  {entry.proofUrl && <a className="history-link" href={entry.proofUrl} target="_blank" rel="noopener noreferrer">{entry.proofUrl}</a>}
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

export default App
