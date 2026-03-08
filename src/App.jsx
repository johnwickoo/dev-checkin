import { useState, useEffect, useRef, useCallback } from 'react'
import emailjs from '@emailjs/browser'
import { supabase } from './supabase.js'
import {
  STREAK_MIN_COMPLETION_RATIO,
  hasGoalProof,
  getVerificationStatus,
  buildDailyGoalQuality,
  getQualifiedDateSet,
  getAverageCompletionPct,
} from './streakUtils.js'
import './App.css'

const EMAILJS_SERVICE_ID     = import.meta.env.VITE_EMAILJS_SERVICE_ID
const EMAILJS_TEMPLATE_ID    = import.meta.env.VITE_EMAILJS_TEMPLATE_ID
const EMAILJS_SHAME_TEMPLATE = import.meta.env.VITE_EMAILJS_SHAME_TEMPLATE
const EMAILJS_PUBLIC_KEY     = import.meta.env.VITE_EMAILJS_PUBLIC_KEY
const VOTE_BASE_URL          = import.meta.env.VITE_VOTE_BASE_URL

const MOOD_LABELS = ['Burnt out', 'Low', 'Okay', 'Focused', 'Locked in']
const VERIFICATION_LABELS = {
  verified: 'Verified',
  pending: 'Pending Review',
  failed: 'Failed',
  challenged: 'Challenged',
}

function toDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getToday() { return toDateKey(new Date()) }

function getYesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1)
  return toDateKey(d)
}

function dateOffset(dateStr, offset) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + offset)
  return toDateKey(dt)
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

function formatShortDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function toIsoInHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function getWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - dt.getDay())
  return toDateKey(dt)
}

function hashString(input) {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

function isWeeklyAuditRequired(userId, goalId, dateStr) {
  const weekKey = getWeekKey(dateStr)
  return hashString(`${userId}:${goalId}:${weekKey}`) % 6 === 0
}

function evaluateGoalVerification({ userId, goalId, date, completed, proofUrl, proofImagePath, previousProgress }) {
  const previousStatus = getVerificationStatus(previousProgress)
  const previousVerifiedAt = previousProgress?.verifiedAt || previousProgress?.verified_at || null
  const previousChallengeWindow = previousProgress?.challengeWindowEndsAt || previousProgress?.challenge_window_ends_at || null

  function getStatusTimestamp(status) {
    if (status === 'pending' || status === 'challenged') return null
    if (previousStatus === status && previousVerifiedAt) return previousVerifiedAt
    return new Date().toISOString()
  }

  if (!completed) {
    return {
      verificationStatus: null,
      verificationReason: null,
      verifiedAt: null,
      verifiedBy: null,
      auditRequired: false,
      challengeWindowEndsAt: null,
    }
  }

  const url = proofUrl?.trim() || ''
  const hasImage = Boolean(proofImagePath)
  const hasProof = Boolean(url || hasImage)
  const challengeWindowEndsAt = previousChallengeWindow || toIsoInHours(24)
  if (!hasProof) {
    return {
      verificationStatus: 'failed',
      verificationReason: 'Completed goal is missing proof',
      verifiedAt: getStatusTimestamp('failed'),
      verifiedBy: 'auto:validation',
      auditRequired: false,
      challengeWindowEndsAt,
    }
  }

  if (url) {
    const isGitHub = /^https?:\/\/(www\.)?github\.com\/.+/i.test(url)
    if (isGitHub) {
      const matchesCommit = /\/commit\/[0-9a-f]{7,40}(?:$|[/?#])/i.test(url)
      const matchesPull = /\/pull\/\d+(?:$|[/?#])/i.test(url)
      const matchesActionRun = /\/actions\/runs\/\d+(?:$|[/?#])/i.test(url)
      if (matchesCommit || matchesPull || matchesActionRun) {
        return {
          verificationStatus: 'verified',
          verificationReason: 'Auto-verified from GitHub proof pattern',
          verifiedAt: getStatusTimestamp('verified'),
          verifiedBy: 'auto:github-pattern',
          auditRequired: false,
          challengeWindowEndsAt,
        }
      }
      return {
        verificationStatus: 'failed',
        verificationReason: 'GitHub proof must link to a commit, PR, or action run',
        verifiedAt: getStatusTimestamp('failed'),
        verifiedBy: 'auto:github-pattern',
        auditRequired: false,
        challengeWindowEndsAt,
      }
    }

    const auditRequired = isWeeklyAuditRequired(userId, goalId, date)
    return {
      verificationStatus: 'pending',
      verificationReason: auditRequired
        ? 'Pending review (selected for random weekly audit)'
        : 'Pending manual review for external proof link',
      verifiedAt: null,
      verifiedBy: null,
      auditRequired,
      challengeWindowEndsAt,
    }
  }

  const auditRequired = isWeeklyAuditRequired(userId, goalId, date)
  return {
    verificationStatus: 'pending',
    verificationReason: auditRequired
      ? 'Pending review for image proof (selected for random weekly audit)'
      : 'Pending manual review for image proof',
    verifiedAt: null,
    verifiedBy: null,
    auditRequired,
    challengeWindowEndsAt,
  }
}

// ── Offline queue ──────────────────────────────────────────
function queueOffline(action) {
  const q = JSON.parse(localStorage.getItem('offline_queue') || '[]')
  q.push({ ...action, ts: Date.now() })
  localStorage.setItem('offline_queue', JSON.stringify(q))
}

async function flushOfflineQueue() {
  const q = JSON.parse(localStorage.getItem('offline_queue') || '[]')
  if (q.length === 0) return
  const remaining = []
  for (const item of q) {
    const { error } = item.method === 'upsert'
      ? await supabase.from(item.table).upsert(item.data, item.opts || {})
      : item.method === 'update'
        ? await supabase.from(item.table).update(item.data).match(item.match)
        : await supabase.from(item.table).insert(item.data)
    if (error) remaining.push(item)
  }
  localStorage.setItem('offline_queue', JSON.stringify(remaining))
}

// ── Image resize before upload ─────────────────────────────
function resizeImage(file, maxWidth = 1200) {
  return new Promise(resolve => {
    if (!file.type.startsWith('image/')) { resolve(file); return }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      if (img.width <= maxWidth) { resolve(file); return }
      const canvas = document.createElement('canvas')
      const ratio = maxWidth / img.width
      canvas.width = maxWidth
      canvas.height = Math.round(img.height * ratio)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.85)
    }
    img.onerror = () => resolve(file)
    img.src = url
  })
}

// ── Progress Ring SVG ──────────────────────────────────────
function ProgressRing({ percent, size = 24, stroke = 2.5 }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (percent / 100) * circ
  return (
    <svg width={size} height={size} className="progress-ring">
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1a1a1a" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={percent >= 70 ? '#4ade80' : percent >= 40 ? '#eab308' : '#ef4444'}
        strokeWidth={stroke} strokeDasharray={circ} strokeDashoffset={offset}
        transform={`rotate(-90 ${size/2} ${size/2})`} strokeLinecap="round" />
    </svg>
  )
}

function App({ userId }) {
  const today = getToday()
  const fileInputRef = useRef(null)
  const autoSaveTimer = useRef(null)
  const saveVersion = useRef(0)

  // Core state
  const [goals, setGoals] = useState([])
  const [goalWeeklyPct, setGoalWeeklyPct] = useState({})
  const [partners, setPartners] = useState([])
  const [checkin, setCheckin] = useState(null)
  const [goalProgress, setGoalProgress] = useState({}) // { goalId: { completed, proofUrl, proofImagePath } }
  const [mood, setMoodVal] = useState(0)
  const [learned, setLearned] = useState('')
  const [built, setBuilt] = useState('')
  const [builtLink, setBuiltLink] = useState('')
  const [uploading, setUploading] = useState(null) // null or goalId being uploaded
  const [pendingVotes, setPendingVotes] = useState([]) // vote progress for pending excuses

  // Missed day
  const [missedDate, setMissedDate] = useState(null)
  const [missedReason, setMissedReason] = useState('')
  const [missedAvoidable, setMissedAvoidable] = useState(null)
  const [missedSending, setMissedSending] = useState(false)

  // Punishment
  const [punishment, setPunishment] = useState(null)
  const [punishmentInput, setPunishmentInput] = useState('')

  // UI
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])
  const [historyPage, setHistoryPage] = useState(0)
  const [historyHasMore, setHistoryHasMore] = useState(true)
  const [streak, setStreak] = useState(0)
  const [verifiedStreak, setVerifiedStreak] = useState(0)
  const [completionAvgPct, setCompletionAvgPct] = useState(0)
  const [verifiedAvgPct, setVerifiedAvgPct] = useState(0)
  const [last30, setLast30] = useState([])
  const [collapsed, setCollapsed] = useState({})
  const [postSubmitUiApplied, setPostSubmitUiApplied] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  function showToast(message, type = 'success') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }

  function toggleCollapse(key) {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function openEditSections() {
    setCollapsed(prev => ({ ...prev, goals: false, mood: false, learned: false, built: false }))
  }

  // ── Online/Offline ────────────────────────────────────────
  useEffect(() => {
    function onOnline() { setIsOnline(true); flushOfflineQueue() }
    function onOffline() { setIsOnline(false) }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])

  // ── Load everything ───────────────────────────────────────
  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    if (navigator.onLine) await flushOfflineQueue()

    const [goalsRes, partnersRes, checkinRes, yesterdayRes, missedRes] = await Promise.all([
      supabase.from('goals').select('*').eq('user_id', userId).eq('active', true).order('created_at'),
      supabase.from('accountability_partners').select('*').eq('user_id', userId),
      supabase.from('checkins').select('*').eq('user_id', userId).eq('date', today).maybeSingle(),
      supabase.from('checkins').select('id').eq('user_id', userId).eq('date', getYesterday()).maybeSingle(),
      supabase.from('missed_days').select('*').eq('user_id', userId).order('date', { ascending: false }),
    ])

    const userGoals = goalsRes.data || []
    const userPartners = partnersRes.data || []
    setGoals(userGoals)
    setPartners(userPartners)

    // Load weekly goal completion %
    if (userGoals.length > 0) {
      const weekAgo = dateOffset(today, -7)
      const { data: recentCheckins } = await supabase.from('checkins')
        .select('id').eq('user_id', userId).gte('date', weekAgo)
      if (recentCheckins && recentCheckins.length > 0) {
        const cids = recentCheckins.map(c => c.id)
        const { data: gp } = await supabase.from('goal_progress')
          .select('goal_id, completed').in('checkin_id', cids)
        const pcts = {}
        for (const g of userGoals) {
          const entries = (gp || []).filter(p => p.goal_id === g.id)
          pcts[g.id] = entries.length > 0
            ? Math.round((entries.filter(e => e.completed).length / Math.max(recentCheckins.length, 1)) * 100)
            : 0
        }
        setGoalWeeklyPct(pcts)
      }
    }

    // Today's checkin
    if (checkinRes.data) {
      const c = checkinRes.data
      setCheckin(c)
      setMoodVal(c.mood || 0)
      setLearned(c.learned || '')
      setBuilt(c.built || '')
      setBuiltLink(c.built_link || '')
      setSaveStatus('saved')

      const { data: gp } = await supabase.from('goal_progress')
        .select('goal_id, completed, proof_url, proof_image_path, verification_status, verification_reason, verified_at, verified_by, audit_required, challenge_window_ends_at')
        .eq('checkin_id', c.id)
      const progress = {}
      for (const g of userGoals) {
        progress[g.id] = {
          completed: false,
          proofUrl: '',
          proofImagePath: '',
          verificationStatus: null,
          verificationReason: null,
          verifiedAt: null,
          verifiedBy: null,
          auditRequired: false,
          challengeWindowEndsAt: null,
        }
      }
      if (gp) for (const row of gp) progress[row.goal_id] = {
        completed: row.completed,
        proofUrl: row.proof_url || '',
        proofImagePath: row.proof_image_path || '',
        verificationStatus: row.verification_status || (row.completed ? 'pending' : null),
        verificationReason: row.verification_reason || null,
        verifiedAt: row.verified_at || null,
        verifiedBy: row.verified_by || null,
        auditRequired: !!row.audit_required,
        challengeWindowEndsAt: row.challenge_window_ends_at || null,
      }
      setGoalProgress(progress)
    } else {
      const progress = {}
      for (const g of userGoals) {
        progress[g.id] = {
          completed: false,
          proofUrl: '',
          proofImagePath: '',
          verificationStatus: null,
          verificationReason: null,
          verifiedAt: null,
          verifiedBy: null,
          auditRequired: false,
          challengeWindowEndsAt: null,
        }
      }
      setGoalProgress(progress)
    }

    // Check rest days
    const restDays = JSON.parse(localStorage.getItem(`rest_days_${userId}`) || '[]')
    const yesterdayDow = new Date(getYesterday()).getDay()
    const isRestDay = restDays.includes(yesterdayDow)

    // Check if yesterday was missed
    const missedDays = missedRes.data || []
    const yesterdayMissed = !yesterdayRes.data
      && !missedDays.find(m => m.date === getYesterday())
      && !isRestDay
    if (yesterdayMissed) setMissedDate(getYesterday())

    await checkVerdicts(missedDays, userPartners)
    await loadPendingVotes(missedDays, userPartners)
    await loadStreakAndDots()
    setLoading(false)
  }

  async function loadStreakAndDots() {
    const [checkinsRes, missedRes] = await Promise.all([
      supabase.from('checkins').select('id, date, mood').eq('user_id', userId)
        .gte('date', dateOffset(today, -365)).order('date', { ascending: false }),
      supabase.from('missed_days').select('date').eq('user_id', userId)
        .gte('date', dateOffset(today, -365)),
    ])

    const checkins = checkinsRes.data || []
    let allGoalProgress = []
    if (checkins.length > 0) {
      const checkinIds = checkins.map(c => c.id)
      const { data: gpRows } = await supabase.from('goal_progress')
        .select('checkin_id, completed, proof_url, proof_image_path, verification_status')
        .in('checkin_id', checkinIds)
      allGoalProgress = gpRows || []
    }

    const dailyQuality = buildDailyGoalQuality(checkins, allGoalProgress)
    const verifiedDailyQuality = buildDailyGoalQuality(
      checkins,
      allGoalProgress,
      STREAK_MIN_COMPLETION_RATIO,
      { requireVerified: true },
    )
    const qualifiedDates = getQualifiedDateSet(dailyQuality)
    const verifiedQualifiedDates = getQualifiedDateSet(verifiedDailyQuality)
    const recentQualityFrom = dateOffset(today, -29)
    setCompletionAvgPct(getAverageCompletionPct(dailyQuality, recentQualityFrom))
    setVerifiedAvgPct(getAverageCompletionPct(verifiedDailyQuality, recentQualityFrom))

    const checkinMap = {}
    for (const c of checkins) checkinMap[c.date] = c.mood
    const missedDates = new Set((missedRes.data || []).map(m => m.date))

    // Streak (rest days don't break streaks, partial check-ins don't count)
    const restDays = JSON.parse(localStorage.getItem(`rest_days_${userId}`) || '[]')
    let s = 0
    if (qualifiedDates.has(today)) s = 1
    let d = dateOffset(today, -1)
    while (true) {
      const dow = new Date(d).getDay()
      if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
      if (!qualifiedDates.has(d)) break
      s++; d = dateOffset(d, -1)
    }
    setStreak(s)

    let vs = 0
    if (verifiedQualifiedDates.has(today)) vs = 1
    d = dateOffset(today, -1)
    while (true) {
      const dow = new Date(d).getDay()
      if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
      if (!verifiedQualifiedDates.has(d)) break
      vs++; d = dateOffset(d, -1)
    }
    setVerifiedStreak(vs)

    // Last 30 — color-coded by mood
    const dots = []
    for (let i = 29; i >= 0; i--) {
      const date = dateOffset(today, -i)
      const dow = new Date(date).getDay()
      const isRest = restDays.includes(dow)
      const moodVal = checkinMap[date]
      const dayQuality = dailyQuality[date]
      const verifiedDayQuality = verifiedDailyQuality[date]
      let status = 'none'
      let moodLevel = 0
      if (verifiedDayQuality?.qualifies) { status = 'completed'; moodLevel = moodVal }
      else if (dayQuality?.qualifies) { status = 'partial'; moodLevel = moodVal }
      else if (moodVal !== undefined) { status = 'partial'; moodLevel = moodVal }
      else if (missedDates.has(date)) status = 'missed'
      else if (isRest) status = 'rest'
      dots.push({ date, status, moodLevel })
    }
    setLast30(dots)
  }

  async function checkVerdicts(missedDays, userPartners) {
    const minVotes = Math.max(Math.ceil(userPartners.length / 2), 2)
    for (const missed of missedDays) {
      if (missed.verdict) {
        if (missed.verdict === 'rejected' && !missed.punishment_acknowledged) {
          setPunishment({ date: missed.date, excuse: missed.excuse, voteCount: { accepts: missed.vote_accepts, rejects: missed.vote_rejects } })
          return
        }
        continue
      }
      if (!missed.excuse_id || !missed.email_sent) continue
      const { data: votes } = await supabase.from('excuse_votes').select('vote').eq('excuse_id', missed.excuse_id)
      if (!votes || votes.length < minVotes) continue
      const rejects = votes.filter(v => v.vote === 'reject').length
      const accepts = votes.filter(v => v.vote === 'accept').length
      const verdict = rejects > accepts ? 'rejected' : 'accepted'
      await supabase.from('missed_days').update({ verdict, vote_accepts: accepts, vote_rejects: rejects, vote_total: votes.length }).eq('id', missed.id)
      if (verdict === 'rejected' && !missed.shame_email_sent) {
        try {
          for (const p of userPartners) {
            await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_SHAME_TEMPLATE, {
              to_email: p.email, missed_date: formatDate(missed.date), excuse_text: missed.excuse, reject_count: rejects, total_votes: votes.length,
            }, EMAILJS_PUBLIC_KEY)
          }
          await supabase.from('missed_days').update({ shame_email_sent: true }).eq('id', missed.id)
        } catch (err) { console.error('Shame email error:', err) }
        setPunishment({ date: missed.date, excuse: missed.excuse, voteCount: { accepts, rejects } })
        return
      }
    }
  }

  // ── Load pending vote progress ───────────────────────────
  async function loadPendingVotes(missedDays, userPartners) {
    const pending = missedDays.filter(m => m.excuse_id && m.email_sent && !m.verdict)
    if (pending.length === 0) { setPendingVotes([]); return }

    const results = []
    for (const m of pending) {
      const { data: votes } = await supabase.from('excuse_votes')
        .select('voter_email, vote').eq('excuse_id', m.excuse_id)
      const voteMap = {}
      if (votes) for (const v of votes) voteMap[v.voter_email] = v.vote

      const partnerVotes = userPartners.map(p => ({
        email: p.email,
        voted: !!voteMap[p.email],
        vote: voteMap[p.email] || null,
      }))
      const accepts = (votes || []).filter(v => v.vote === 'accept').length
      const rejects = (votes || []).filter(v => v.vote === 'reject').length

      results.push({
        date: m.date,
        excuse: m.excuse,
        excuseId: m.excuse_id,
        partnerVotes,
        accepts,
        rejects,
        totalVoted: (votes || []).length,
        totalPartners: userPartners.length,
      })
    }
    setPendingVotes(results)
  }

  // ── Auto-save with debounce ───────────────────────────────
  const doSave = useCallback(async () => {
    const version = ++saveVersion.current
    setSaveStatus('saving')

    const checkinData = {
      user_id: userId, date: today, mood,
      learned: learned.trim(), built: built.trim(),
      built_link: builtLink.trim() || null,
    }

    if (!navigator.onLine) {
      queueOffline({ table: 'checkins', method: 'upsert', data: checkinData, opts: { onConflict: 'user_id,date' } })
      setSaveStatus('saved')
      showToast('Saved offline — will sync when back online')
      return
    }

    let checkinId = checkin?.id
    try {
      if (checkin) {
        const { error } = await supabase.from('checkins').update(checkinData).eq('id', checkin.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('checkins').insert(checkinData).select().single()
        if (error) throw error
        checkinId = data.id
        setCheckin(data)
      }

      // Batch upsert goal progress with per-goal proofs
      const nextGoalProgress = { ...goalProgress }
      const verificationLogs = []
      const gpRows = Object.entries(goalProgress).map(([goalId, gp]) => {
        const proofUrl = gp.proofUrl?.trim() || ''
        const proofImagePath = gp.proofImagePath || null
        const verification = evaluateGoalVerification({
          userId,
          goalId,
          date: today,
          completed: gp.completed,
          proofUrl,
          proofImagePath,
          previousProgress: gp,
        })

        nextGoalProgress[goalId] = {
          ...gp,
          proofUrl,
          proofImagePath: proofImagePath || '',
          verificationStatus: verification.verificationStatus,
          verificationReason: verification.verificationReason,
          verifiedAt: verification.verifiedAt,
          verifiedBy: verification.verifiedBy,
          auditRequired: verification.auditRequired,
          challengeWindowEndsAt: verification.challengeWindowEndsAt,
        }

        if (gp.completed && verification.verificationStatus) {
          verificationLogs.push({
            user_id: userId,
            checkin_id: checkinId,
            goal_id: goalId,
            verification_status: verification.verificationStatus,
            verification_reason: verification.verificationReason,
            proof_url: proofUrl || null,
            proof_image_path: proofImagePath || null,
            source: verification.verifiedBy || 'auto:pending-review',
            audit_required: verification.auditRequired,
          })
        }

        return {
          checkin_id: checkinId,
          goal_id: goalId,
          completed: gp.completed,
          proof_url: proofUrl || null,
          proof_image_path: proofImagePath || null,
          verification_status: verification.verificationStatus,
          verification_reason: verification.verificationReason,
          verified_at: verification.verifiedAt,
          verified_by: verification.verifiedBy,
          audit_required: verification.auditRequired,
          challenge_window_ends_at: verification.challengeWindowEndsAt,
        }
      })
      if (gpRows.length > 0) {
        const { error: gpError } = await supabase.from('goal_progress').upsert(gpRows, { onConflict: 'checkin_id,goal_id' })
        if (gpError) throw gpError
        const progressChanged = Object.keys(nextGoalProgress).some(goalId => {
          const prev = goalProgress[goalId] || {}
          const next = nextGoalProgress[goalId] || {}
          return (prev.proofUrl || '').trim() !== (next.proofUrl || '').trim()
            || (prev.proofImagePath || '') !== (next.proofImagePath || '')
            || (prev.verificationStatus || null) !== (next.verificationStatus || null)
            || (prev.verificationReason || null) !== (next.verificationReason || null)
            || (prev.verifiedAt || null) !== (next.verifiedAt || null)
            || (prev.verifiedBy || null) !== (next.verifiedBy || null)
            || !!prev.auditRequired !== !!next.auditRequired
            || (prev.challengeWindowEndsAt || null) !== (next.challengeWindowEndsAt || null)
        })
        if (progressChanged) setGoalProgress(nextGoalProgress)
      }

      if (verificationLogs.length > 0) {
        const { error: verError } = await supabase.from('proof_verifications').insert(verificationLogs)
        if (verError) console.error('Verification log insert failed:', verError)
      }

      if (version === saveVersion.current) {
        setSaveStatus('saved')
        loadStreakAndDots()
      }
    } catch (err) {
      if (version === saveVersion.current) setSaveStatus('error')
      const msg = String(err?.message || '')
      if (msg.includes('column') || msg.includes('proof_verifications')) {
        showToast('Database schema outdated. Run the latest SQL setup.', 'error')
      }
      console.error('Check-in save error:', err)
    }
  }, [userId, today, mood, learned, built, builtLink, goalProgress, checkin])

  // Trigger auto-save on field changes (debounced 2s)
  const completedGoalEntries = Object.values(goalProgress).filter(gp => gp.completed)
  const completedGoalsWithProof = completedGoalEntries.filter(gp => hasGoalProof(gp)).length
  const hasCompletedWithoutProof = completedGoalEntries.some(gp => !hasGoalProof(gp))
  const verifiedTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'verified').length
  const pendingTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'pending').length
  const failedTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'failed').length
  const challengedTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'challenged').length
  const auditTodayGoals = completedGoalEntries.filter(gp => gp.auditRequired).length
  const dayCompletionRatio = goals.length > 0 ? completedGoalsWithProof / goals.length : 0
  const dayCompletionPct = Math.round(dayCompletionRatio * 100)
  const dayVerifiedRatio = goals.length > 0 ? verifiedTodayGoals / goals.length : 0
  const dayVerifiedPct = Math.round(dayVerifiedRatio * 100)
  const hasFailedVerificationToday = failedTodayGoals > 0
  const meetsStreakThreshold = goals.length > 0 && dayCompletionRatio >= STREAK_MIN_COMPLETION_RATIO
  const isComplete = learned.trim().length >= 50
    && built.trim().length > 0
    && completedGoalsWithProof > 0
    && !hasCompletedWithoutProof
  const doneForToday = saveStatus === 'saved' && isComplete && failedTodayGoals === 0

  useEffect(() => {
    if (!doneForToday || postSubmitUiApplied) return
    setCollapsed(prev => ({ ...prev, goals: true, mood: true, learned: true, built: true }))
    setPostSubmitUiApplied(true)
  }, [doneForToday, postSubmitUiApplied])

  useEffect(() => {
    if (loading) return
    if (!isComplete) { setSaveStatus('idle'); return }
    setSaveStatus('idle')
    clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(doSave, 2000)
    return () => clearTimeout(autoSaveTimer.current)
  }, [mood, learned, built, builtLink, goalProgress, isComplete, loading, doSave])

  // ── Punishment ────────────────────────────────────────────
  async function acknowledgePunishment() {
    if (punishmentInput !== 'I will do better') return
    await supabase.from('missed_days').update({ punishment_acknowledged: true })
      .eq('user_id', userId).eq('date', punishment.date)
    setPunishment(null)
    setPunishmentInput('')
  }

  // ── Missed day submit ─────────────────────────────────────
  async function handleMissedSubmit() {
    const excuse = missedReason.trim()
    if (excuse.length < 80 || missedAvoidable === null) return
    setMissedSending(true)

    const excuseId = `${missedDate}-${Date.now()}`
    const encodedExcuse = encodeURIComponent(excuse)

    const { error: insertErr } = await supabase.from('missed_days').insert({
      user_id: userId, date: missedDate, excuse, was_avoidable: missedAvoidable, excuse_id: excuseId, email_sent: false,
    })
    if (insertErr) { showToast('Failed to save excuse', 'error'); setMissedSending(false); return }

    const { data: recentCheckins } = await supabase.from('checkins').select('id, date')
      .eq('user_id', userId).lt('date', missedDate).order('date', { ascending: false }).limit(365)

    let streakBefore = 0
    if (recentCheckins && recentCheckins.length > 0) {
      const checkinIds = recentCheckins.map(c => c.id)
      const { data: gpRows } = await supabase.from('goal_progress')
        .select('checkin_id, completed, proof_url, proof_image_path, verification_status')
        .in('checkin_id', checkinIds)
      const dailyQuality = buildDailyGoalQuality(recentCheckins, gpRows || [])
      const qualifiedDates = getQualifiedDateSet(dailyQuality)
      const restDays = JSON.parse(localStorage.getItem(`rest_days_${userId}`) || '[]')
      let d = dateOffset(missedDate, -1)
      while (true) {
        const dow = new Date(d).getDay()
        if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
        if (!qualifiedDates.has(d)) break
        streakBefore++
        d = dateOffset(d, -1)
      }
    }

    try {
      for (const p of partners) {
        const base = `${VOTE_BASE_URL}?id=${excuseId}&email=${encodeURIComponent(p.email)}&date=${missedDate}&excuse=${encodedExcuse}`
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
          to_email: p.email, missed_date: formatDate(missedDate), excuse_text: excuse,
          was_avoidable: missedAvoidable ? 'Yes' : 'No', streak: streakBefore,
          accept_url: base + '&vote=accept', reject_url: base + '&vote=reject',
        }, EMAILJS_PUBLIC_KEY)
      }
      await supabase.from('missed_days').update({ email_sent: true }).eq('user_id', userId).eq('date', missedDate)
      showToast(`Excuse sent to ${partners.length} accountability partners`)
    } catch (err) { showToast('Failed to send emails', 'error'); console.error('EmailJS error:', err) }

    setMissedDate(null); setMissedReason(''); setMissedAvoidable(null); setMissedSending(false)
    await loadStreakAndDots()
  }

  // ── Image upload per goal (with resize) ──────────────────
  const uploadGoalRef = useRef(null) // which goalId triggered upload
  async function handleGoalImageUpload(e) {
    const file = e.target.files?.[0]
    const goalId = uploadGoalRef.current
    if (!file || !goalId) return
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5MB', 'error'); return }
    setUploading(goalId)
    const resized = await resizeImage(file)
    const ext = file.name.split('.').pop()
    const path = `${userId}/${today}-${goalId}-${Date.now()}.${ext}`
    const { error: uploadErr } = await supabase.storage.from('proof-images').upload(path, resized)
    if (uploadErr) { showToast('Upload failed: ' + uploadErr.message, 'error'); setUploading(null); return }
    const { data: urlData } = supabase.storage.from('proof-images').getPublicUrl(path)
    setGoalProgress(prev => ({
      ...prev,
      [goalId]: {
        ...prev[goalId],
        proofImagePath: urlData.publicUrl,
        verificationStatus: prev[goalId]?.completed ? 'pending' : null,
        verificationReason: prev[goalId]?.completed ? 'Will verify on save' : null,
        verifiedAt: null,
        verifiedBy: null,
        auditRequired: false,
        challengeWindowEndsAt: null,
      },
    }))
    setUploading(null)
    showToast('Image uploaded')
    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Force save (manual trigger) ───────────────────────────
  function handleForceSave() {
    clearTimeout(autoSaveTimer.current)
    doSave()
  }

  // ── Load history (paginated) ──────────────────────────────
  async function loadHistory(page = 0) {
    const pageSize = 10
    const offset = page * pageSize
    const [checkinsRes, missedRes] = await Promise.all([
      supabase.from('checkins').select('*').eq('user_id', userId)
        .order('date', { ascending: false }).range(offset, offset + pageSize - 1),
      page === 0
        ? supabase.from('missed_days').select('*').eq('user_id', userId).order('date', { ascending: false }).limit(30)
        : Promise.resolve({ data: [] }),
    ])

    const newEntries = []
    const checkins = checkinsRes.data || []
    if (checkins.length > 0) {
      const cids = checkins.map(c => c.id)
      const { data: allGp } = await supabase.from('goal_progress')
        .select('checkin_id, goal_id, completed, verification_status').in('checkin_id', cids)
      for (const c of checkins) {
        const gp = (allGp || []).filter(g => g.checkin_id === c.id)
        newEntries.push({ ...c, type: 'checkin', goalProgress: gp })
      }
    }
    if (page === 0) {
      for (const m of (missedRes.data || [])) {
        newEntries.push({ ...m, type: 'missed', date: m.date })
      }
    }
    newEntries.sort((a, b) => b.date.localeCompare(a.date))

    if (page === 0) setHistory(newEntries)
    else setHistory(prev => [...prev, ...newEntries])

    setHistoryHasMore(checkins.length === pageSize)
    setHistoryPage(page)
    setShowHistory(true)
  }

  function toggleHistory() {
    if (showHistory) { setShowHistory(false); return }
    loadHistory(0)
  }

  // ── Derived ───────────────────────────────────────────────
  const dateDisplay = formatDate(today)
  const streakThresholdPct = Math.round(STREAK_MIN_COMPLETION_RATIO * 100)
  const tomorrowDisplay = formatShortDate(dateOffset(today, 1))

  // ── Auto-save status label ────────────────────────────────
  const saveLabel = saveStatus === 'saving' ? 'Saving...'
    : saveStatus === 'saved' ? (doneForToday ? 'All set for today' : hasFailedVerificationToday ? 'Saved - fix failed proof' : 'Saved')
    : saveStatus === 'error' ? 'Save failed'
    : isComplete ? 'Will auto-save' : 'Complete all fields to save'

  // ── Loading ───────────────────────────────────────────────
  if (loading) {
    return (
      <div className="app">
        <header><h1>Daily Check-in</h1><p className="date">{dateDisplay}</p></header>
        <section className="card"><p className="vote-status">Loading...</p></section>
      </div>
    )
  }

  // ── Punishment ────────────────────────────────────────────
  if (punishment) {
    const inputMatch = punishmentInput === 'I will do better'
    return (
      <div className="app">
        <header><h1>Daily Check-in</h1><p className="date">{dateDisplay}</p></header>
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
            <p>Your partners have been notified.</p>
            <p>You owe a task — check your email.</p>
          </div>
          <div className="punishment-gate">
            <p className="punishment-instruction">Type <strong>I will do better</strong> exactly to continue.</p>
            <input type="text" className={`field-input punishment-input ${inputMatch ? 'punishment-match' : ''}`}
              value={punishmentInput} onChange={e => setPunishmentInput(e.target.value)}
              placeholder="I will do better" spellCheck={false} autoComplete="off" />
            <button className="save-btn" onClick={acknowledgePunishment} disabled={!inputMatch}>Acknowledge & Continue</button>
          </div>
        </section>
      </div>
    )
  }

  // ── Missed day ────────────────────────────────────────────
  if (missedDate) {
    const charCount = missedReason.trim().length
    const canSubmit = charCount >= 80 && missedAvoidable !== null && !missedSending
    return (
      <div className="app">
        <header><h1>Daily Check-in</h1><p className="date">{dateDisplay}</p></header>
        <section className="card missed-card">
          <h2>Missed Day</h2>
          <p className="missed-date">{formatDate(missedDate)}</p>
          <p className="missed-prompt">You didn't check in yesterday. Write your excuse below. This will be emailed to {partners.length} people who will vote on whether it's acceptable.</p>
          <textarea className="missed-textarea" placeholder="Be honest. What happened? (at least 80 characters)"
            value={missedReason} onChange={e => setMissedReason(e.target.value)} rows={5} />
          <p className={`char-count ${charCount >= 80 ? 'met' : ''}`}>{charCount}/80 characters</p>
          <div className="avoidable-section">
            <p className="avoidable-label">Was this avoidable?</p>
            <div className="avoidable-toggle">
              <button className={`toggle-btn ${missedAvoidable === true ? 'toggle-active toggle-yes' : ''}`} onClick={() => setMissedAvoidable(true)}>Yes</button>
              <button className={`toggle-btn ${missedAvoidable === false ? 'toggle-active toggle-no' : ''}`} onClick={() => setMissedAvoidable(false)}>No</button>
            </div>
          </div>
          <button className="save-btn" onClick={handleMissedSubmit} disabled={!canSubmit}>
            {missedSending ? 'Sending...' : 'Submit Excuse & Notify Group'}
          </button>
        </section>
        {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
      </div>
    )
  }

  // ── Normal check-in ───────────────────────────────────────
  return (
    <div className="app">
      {!isOnline && <div className="offline-bar">Offline — changes will sync when reconnected</div>}

      <header>
        <h1>Daily Check-in</h1>
        <p className="date">{dateDisplay}</p>
        {streak > 0 && (
          <p className="streak">
            {streak} day streak
            <span className="streak-verified"> ({verifiedStreak} verified)</span>
          </p>
        )}
        <p className="streak-quality">
          Quality: {completionAvgPct}% submitted / {verifiedAvgPct}% verified (30d)
          {' '}| Today: {dayCompletionPct}% submitted, {dayVerifiedPct}% verified
          {' '}({meetsStreakThreshold ? 'submission eligible' : `needs ${streakThresholdPct}% submitted`})
        </p>
      </header>

      {/* Auto-save indicator */}
      <div className={`autosave-indicator autosave-${saveStatus}`}>{saveLabel}</div>

      {doneForToday && (
        <section className="card day-done-card">
          <h2>All Set For Today</h2>
          <p className="day-done-text">Everything is submitted. Nothing left to do until tomorrow ({tomorrowDisplay}).</p>
          <p className="day-done-sub">
            Verification: {verifiedTodayGoals} verified, {pendingTodayGoals} pending
            {auditTodayGoals > 0 ? `, ${auditTodayGoals} audit` : ''}
          </p>
          <button className="history-toggle day-done-edit" onClick={openEditSections}>Edit Today&apos;s Check-in</button>
        </section>
      )}

      {completedGoalEntries.length > 0 && (
        <section className="card verification-summary-card">
          <h2>Proof Verification</h2>
          <p className="verification-summary-line">
            {verifiedTodayGoals} verified | {pendingTodayGoals} pending | {challengedTodayGoals} challenged | {failedTodayGoals} failed
          </p>
          {auditTodayGoals > 0 && (
            <p className="verification-summary-sub">Random weekly audit queue: {auditTodayGoals} goal(s)</p>
          )}
        </section>
      )}

      {/* 30-Day Dots */}
      <section className="card">
        <h2 className="card-header" onClick={() => toggleCollapse('dots')}>
          Last 30 Days {collapsed.dots ? '+' : ''}
        </h2>
        {!collapsed.dots && (<>
          <div className="dot-grid">
            {last30.map(({ date, status, moodLevel }) => (
              <div key={date}
                className={`dot ${status === 'completed' ? (moodLevel >= 4 ? 'dot-mood-high' : moodLevel === 3 ? 'dot-mood-mid' : moodLevel >= 1 ? 'dot-mood-low' : 'dot-completed') : `dot-${status}`}`}
                title={`${formatShortDate(date)}: ${status}${moodLevel ? ` (mood ${moodLevel})` : ''}`} />
            ))}
          </div>
          <div className="dot-legend">
            <span><span className="dot dot-mood-high dot-inline" /> Good</span>
            <span><span className="dot dot-mood-mid dot-inline" /> Okay</span>
            <span><span className="dot dot-mood-low dot-inline" /> Low</span>
            <span><span className="dot dot-partial dot-inline" /> Partial</span>
            <span><span className="dot dot-missed dot-inline" /> Missed</span>
            <span><span className="dot dot-none dot-inline" /> No data</span>
          </div>
        </>)}
      </section>

      {/* Goals with per-goal proof */}
      <section className="card card-accent-green">
        <h2 className="card-header" onClick={() => toggleCollapse('goals')}>
          Goals <span className="card-header-count">{completedGoalsWithProof}/{goals.length}</span> {collapsed.goals ? '+' : ''}
        </h2>
        {!collapsed.goals && (<>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleGoalImageUpload} style={{ display: 'none' }} />
          {goals.length === 0 ? (
            <p className="empty-state">No goals yet. Add some in Settings to start tracking.</p>
          ) : (
            <div className="blocks">
              {goals.map(goal => {
                const gp = goalProgress[goal.id] || {
                  completed: false,
                  proofUrl: '',
                  proofImagePath: '',
                  verificationStatus: null,
                  verificationReason: null,
                  auditRequired: false,
                }
                const verificationStatus = gp.completed ? (getVerificationStatus(gp) || 'pending') : null
                const verificationLabel = verificationStatus ? (VERIFICATION_LABELS[verificationStatus] || verificationStatus) : ''
                return (
                  <div key={goal.id} className="goal-block">
                    <label className={`block ${gp.completed ? 'done' : ''}`}>
                      <input type="checkbox" checked={gp.completed}
                        onChange={() => setGoalProgress(prev => {
                          const nextCompleted = !prev[goal.id]?.completed
                          return {
                            ...prev,
                            [goal.id]: {
                              ...prev[goal.id],
                              completed: nextCompleted,
                              verificationStatus: nextCompleted ? 'pending' : null,
                              verificationReason: nextCompleted ? 'Will verify on save' : null,
                              verifiedAt: null,
                              verifiedBy: null,
                              auditRequired: false,
                              challengeWindowEndsAt: null,
                            },
                          }
                        })} />
                      <span className="checkmark" />
                      <span className="block-name">
                        {goal.title}
                        {goal.deadline && <span className="goal-deadline"> (due {goal.deadline})</span>}
                        {verificationStatus && (
                          <span className={`verification-chip verification-${verificationStatus}`}>
                            {verificationLabel}
                          </span>
                        )}
                      </span>
                      {goalWeeklyPct[goal.id] !== undefined && (
                        <ProgressRing percent={goalWeeklyPct[goal.id]} />
                      )}
                    </label>
                    {gp.completed && (
                      <div className="goal-proof">
                        <input type="url" className="field-input goal-proof-input"
                          placeholder="Proof URL (commit, deploy, screenshot...)"
                          value={gp.proofUrl || ''}
                          onChange={e => setGoalProgress(prev => ({
                            ...prev,
                            [goal.id]: {
                              ...prev[goal.id],
                              proofUrl: e.target.value,
                              verificationStatus: prev[goal.id]?.completed ? 'pending' : null,
                              verificationReason: prev[goal.id]?.completed ? 'Will verify on save' : null,
                              verifiedAt: null,
                              verifiedBy: null,
                              auditRequired: false,
                              challengeWindowEndsAt: null,
                            },
                          }))} />
                        <div className="goal-proof-actions">
                          <button className="history-toggle goal-proof-upload"
                            onClick={() => { uploadGoalRef.current = goal.id; fileInputRef.current?.click() }}
                            disabled={uploading === goal.id}>
                            {uploading === goal.id ? 'Uploading...' : gp.proofImagePath ? 'Change Image' : 'Upload Image'}
                          </button>
                          {!gp.proofUrl?.trim() && !gp.proofImagePath && (
                            <span className="goal-proof-hint">Proof required</span>
                          )}
                        </div>
                        {verificationStatus && (
                          <div className="verification-meta">
                            <span className={`verification-chip verification-${verificationStatus}`}>{verificationLabel}</span>
                            {gp.auditRequired && <span className="verification-audit-flag">Random audit</span>}
                          </div>
                        )}
                        {gp.verificationReason && (
                          <p className="verification-reason">{gp.verificationReason}</p>
                        )}
                        {gp.proofImagePath && (
                          <div className="proof-preview">
                            <img src={gp.proofImagePath} alt="Proof" className="proof-img" />
                            <button className="settings-remove proof-remove"
                              onClick={() => setGoalProgress(prev => ({
                                ...prev,
                                [goal.id]: {
                                  ...prev[goal.id],
                                  proofImagePath: '',
                                  verificationStatus: prev[goal.id]?.completed ? 'pending' : null,
                                  verificationReason: prev[goal.id]?.completed ? 'Will verify on save' : null,
                                  verifiedAt: null,
                                  verifiedBy: null,
                                  auditRequired: false,
                                  challengeWindowEndsAt: null,
                                },
                              }))}>x</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>)}
      </section>

      {/* Mood */}
      <section className="card card-accent-purple">
        <h2 className="card-header" onClick={() => toggleCollapse('mood')}>
          Mood / Energy {mood > 0 && <span className="card-header-val">{MOOD_LABELS[mood - 1]}</span>} {collapsed.mood ? '+' : ''}
        </h2>
        {!collapsed.mood && (
          <div className="mood-scale">
            {MOOD_LABELS.map((label, i) => {
              const level = i + 1
              return (
                <button key={level} className={`mood-btn ${mood === level ? 'active' : ''}`}
                  onClick={() => setMoodVal(level)} title={label}>
                  <span className="mood-num">{level}</span>
                  <span className="mood-label">{label}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* What I Learned */}
      <section className="card">
        <h2 className="card-header" onClick={() => toggleCollapse('learned')}>
          What I Learned Today {collapsed.learned ? '+' : ''}
        </h2>
        {!collapsed.learned && (<>
          <textarea className="field-textarea"
            placeholder={goals.length === 0 ? 'Start by adding goals in Settings, then describe what you learned here...' : 'What did you learn today? (at least 50 characters)'}
            value={learned} onChange={e => setLearned(e.target.value)} rows={3} />
          <p className={`char-count ${learned.trim().length >= 50 ? 'met' : ''}`}>{learned.trim().length}/50 characters</p>
        </>)}
      </section>

      {/* What I Built */}
      <section className="card">
        <h2 className="card-header" onClick={() => toggleCollapse('built')}>
          What I Built / Wrote {collapsed.built ? '+' : ''}
        </h2>
        {!collapsed.built && (<>
          <textarea className="field-textarea" placeholder="Describe what you built or wrote today..."
            value={built} onChange={e => setBuilt(e.target.value)} rows={3} />
          <input type="url" className="field-input" placeholder="GitHub link (optional)"
            value={builtLink} onChange={e => setBuiltLink(e.target.value)} />
        </>)}
      </section>

      {/* Vote Progress */}
      {pendingVotes.length > 0 && (
        <section className="card card-accent-vote">
          <h2 className="card-header" onClick={() => toggleCollapse('votes')}>
            Pending Votes ({pendingVotes.length}) {collapsed.votes ? '+' : ''}
          </h2>
          {!collapsed.votes && (
            <div className="vote-progress-list">
              {pendingVotes.map(pv => (
                <div key={pv.excuseId} className="vote-progress-item">
                  <div className="vote-progress-header">
                    <span className="vote-progress-date">{formatShortDate(pv.date)}</span>
                    <span className="vote-progress-tally">
                      <span className="vote-tally-accept">{pv.accepts}</span>
                      <span className="vote-tally-sep">/</span>
                      <span className="vote-tally-reject">{pv.rejects}</span>
                      <span className="vote-tally-total">({pv.totalVoted}/{pv.totalPartners} voted)</span>
                    </span>
                  </div>
                  <p className="vote-progress-excuse">"{pv.excuse.length > 100 ? pv.excuse.slice(0, 100) + '...' : pv.excuse}"</p>
                  <div className="vote-progress-partners">
                    {pv.partnerVotes.map(p => (
                      <span key={p.email} className={`vote-partner-chip ${p.voted ? (p.vote === 'accept' ? 'chip-accept' : 'chip-reject') : 'chip-waiting'}`}>
                        {p.email.split('@')[0]}
                        {p.voted ? (p.vote === 'accept' ? ' ✓' : ' ✗') : ' ...'}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Manual save fallback */}
      {isComplete && saveStatus !== 'saved' && saveStatus !== 'saving' && (
        <button className="save-btn" onClick={handleForceSave}>Save Now</button>
      )}

      {/* History */}
      <button className="history-toggle" onClick={toggleHistory}>
        {showHistory ? 'Hide History' : 'View History'}
      </button>

      {showHistory && (
        <section className="card history-card">
          <h2>History</h2>
          {history.length === 0 && <p className="empty-state">No entries yet. Complete your first check-in to start building history.</p>}
          {history.map(entry => (
            <div key={`${entry.type}-${entry.date}`} className={`history-entry ${entry.type === 'missed' ? 'history-missed' : ''}`}>
              <div className="history-header">
                <span className="history-date">{formatDate(entry.date)}</span>
                {entry.type === 'missed'
                  ? <span className="history-badge badge-missed">Missed</span>
                  : <span className="history-badge badge-done">Completed</span>}
              </div>
              {entry.type === 'missed' ? (
                <p className="history-reason">{entry.excuse}</p>
              ) : (
                <div className="history-details">
                  {entry.goalProgress && entry.goalProgress.length > 0 && (
                    <span>
                      {entry.goalProgress.filter(g => g.completed).length}/{entry.goalProgress.length} goals
                      {' '}({entry.goalProgress.filter(g => g.completed && g.verification_status === 'verified').length} verified)
                    </span>
                  )}
                  <span>{entry.mood > 0 ? MOOD_LABELS[entry.mood - 1] : 'No mood'}</span>
                  {entry.learned && <span className="history-learned">{entry.learned}</span>}
                  {entry.built && <span className="history-built">{entry.built}</span>}
                  {entry.proof_url && <a className="history-link" href={entry.proof_url} target="_blank" rel="noopener noreferrer">{entry.proof_url}</a>}
                  {entry.proof_image_path && <img src={entry.proof_image_path} alt="Proof" className="history-proof-img" />}
                </div>
              )}
            </div>
          ))}
          {historyHasMore && (
            <button className="history-toggle" style={{ marginTop: '0.5rem' }} onClick={() => loadHistory(historyPage + 1)}>
              Load More
            </button>
          )}
        </section>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
    </div>
  )
}

export default App
