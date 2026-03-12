import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { supabase } from './supabase.js'
import {
  STREAK_MIN_COMPLETION_RATIO,
  hasGoalProof,
  getVerificationStatus,
  buildDailyGoalQuality,
  getQualifiedDateSet,
  getLatestDate,
  getConsecutiveStreakFromDate,
} from './streakUtils.js'
import './App.css'

const VOTE_BASE_URL          = import.meta.env.VITE_VOTE_BASE_URL

const MOOD_LABELS = ['Burnt out', 'Low', 'Okay', 'Focused', 'Locked in']
const VERIFICATION_LABELS = {
  verified: 'Verified',
  pending: 'Pending Review',
  failed: 'Failed',
  challenged: 'Challenged',
}
const PUNISHMENT_LABELS = {
  deep_work_2h: 'Do a focused 2-hour deep work block and share proof',
  no_social_24h: 'No social media for 24 hours',
  donate_20: 'Donate $20 and share receipt',
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

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return toDateKey(dt) === value
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

function formatGoalDeadlineLabel(goalTitle, deadline) {
  return `Missed goal deadline: "${goalTitle}" (due ${formatDate(deadline)})`
}

function getMajorityVoteThreshold(partnerCount) {
  const count = Math.max(Number(partnerCount) || 0, 1)
  return Math.floor(count / 2) + 1
}

function formatPunishmentChoice(choice) {
  return PUNISHMENT_LABELS[choice] || PUNISHMENT_LABELS.deep_work_2h
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

function buildEditableSnapshot({ mood, learned, built, builtLink, goalProgress, goals }) {
  const goalSnapshot = {}
  for (const goal of (goals || [])) {
    const goalId = String(goal?.id || '')
    if (!goalId) continue
    const gp = goalProgress?.[goalId] || {}
    goalSnapshot[goalId] = {
      completed: !!gp.completed,
      proofUrl: String(gp.proofUrl || '').trim(),
      proofImagePath: String(gp.proofImagePath || ''),
    }
  }

  return {
    mood: Number(mood) || 0,
    learned: String(learned || '').trim(),
    built: String(built || '').trim(),
    builtLink: String(builtLink || '').trim(),
    goals: goalSnapshot,
  }
}

function areEditableSnapshotsEqual(a, b) {
  if (!a || !b) return false
  if (a.mood !== b.mood) return false
  if (a.learned !== b.learned) return false
  if (a.built !== b.built) return false
  if (a.builtLink !== b.builtLink) return false

  const aGoals = a.goals || {}
  const bGoals = b.goals || {}
  const aKeys = Object.keys(aGoals)
  const bKeys = Object.keys(bGoals)
  if (aKeys.length !== bKeys.length) return false

  for (const key of aKeys) {
    const aGoal = aGoals[key]
    const bGoal = bGoals[key]
    if (!bGoal) return false
    if (!!aGoal.completed !== !!bGoal.completed) return false
    if (aGoal.proofUrl !== bGoal.proofUrl) return false
    if (aGoal.proofImagePath !== bGoal.proofImagePath) return false
  }

  return true
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

function App({ userId, active }) {
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
  const [deadlineIssue, setDeadlineIssue] = useState(null)
  const [deadlineReason, setDeadlineReason] = useState('')
  const [deadlineAvoidable, setDeadlineAvoidable] = useState(null)
  const [deadlineExtensionDate, setDeadlineExtensionDate] = useState('')
  const [deadlineSending, setDeadlineSending] = useState(false)

  // Punishment
  const [punishment, setPunishment] = useState(null)
  const [punishmentInput, setPunishmentInput] = useState('')

  // Punishment tasks (assigned daily tasks from rejected excuses)
  const [punishmentTasks, setPunishmentTasks] = useState([])
  const [punishmentTaskProof, setPunishmentTaskProof] = useState({})

  // Encouragements from partners
  const [encouragements, setEncouragements] = useState([])

  // UI
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => localStorage.getItem('accountabuddy_autosave') === 'true')
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])
  const [historyPage, setHistoryPage] = useState(0)
  const [historyHasMore, setHistoryHasMore] = useState(true)
  const [restDaysState, setRestDaysState] = useState([])
  const [streak, setStreak] = useState(0)
  const [verifiedStreak, setVerifiedStreak] = useState(0)
  const [streakPaused, setStreakPaused] = useState(false)
  const [last30, setLast30] = useState([])
  const [collapsed, setCollapsed] = useState({
    dots: true,
    votes: true,
    mood: false,
    learned: false,
    built: false,
    goals: false,
  })
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

  function getSuggestedExtensionDate(deadline) {
    const minDate = dateOffset(today, 1)
    if (!deadline) return minDate
    const oneWeekAfterDeadline = dateOffset(deadline, 7)
    return oneWeekAfterDeadline > minDate ? oneWeekAfterDeadline : minDate
  }

  async function createVoteInviteLinks({ sourceType, sourceId, excuseId, missedDate, excuseText, emails }) {
    const normalizedEmails = [...new Set(
      (emails || [])
        .map(email => String(email || '').trim().toLowerCase())
        .filter(Boolean),
    )]
    if (normalizedEmails.length === 0) return {}

    const { data, error } = await supabase.rpc('create_excuse_vote_invites', {
      p_source_type: sourceType,
      p_source_id: sourceId,
      p_excuse_id: excuseId,
      p_missed_date: missedDate,
      p_excuse_text: excuseText,
      p_voter_emails: normalizedEmails,
    })
    if (error) throw error

    const tokenByEmail = {}
    for (const row of (data || [])) {
      const email = String(row?.voter_email || '').trim().toLowerCase()
      const token = String(row?.token || '').trim()
      if (email && token) tokenByEmail[email] = token
    }
    return tokenByEmail
  }

  async function sendAccountabilityEmails({ mode, messages }) {
    if (!Array.isArray(messages) || messages.length === 0) return { sent: 0, failed: 0, failures: [] }
    const { data: { user }, error: userErr } = await supabase.auth.getUser()
    if (userErr || !user) {
      throw new Error('You are not authenticated. Please sign in again.')
    }
    const { data, error } = await supabase.functions.invoke('send-accountability-email', {
      body: { mode, messages },
    })
    if (error) throw error
    if (!data?.success) {
      const details = Array.isArray(data?.failures) && data.failures.length > 0
        ? ` (${data.failures.map(f => `${f.to_email}: ${f.error}`).join('; ')})`
        : ''
      throw new Error(`Email sending failed${details}`)
    }
    return data
  }

  // ── Online/Offline ────────────────────────────────────────
  useEffect(() => {
    function onOnline() { setIsOnline(true); flushOfflineQueue() }
    function onOffline() { setIsOnline(false) }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])

  useEffect(() => {
    function syncAutoSaveSetting() {
      setAutoSaveEnabled(localStorage.getItem('accountabuddy_autosave') === 'true')
    }

    function onAutoSaveChanged(event) {
      if (typeof event?.detail?.enabled === 'boolean') {
        setAutoSaveEnabled(event.detail.enabled)
        return
      }
      syncAutoSaveSetting()
    }

    window.addEventListener('focus', syncAutoSaveSetting)
    window.addEventListener('accountabuddy:autosave-changed', onAutoSaveChanged)
    return () => {
      window.removeEventListener('focus', syncAutoSaveSetting)
      window.removeEventListener('accountabuddy:autosave-changed', onAutoSaveChanged)
    }
  }, [])

  // ── Load everything ───────────────────────────────────────
  useEffect(() => { loadAll() }, [])

  // Reload when switching back to checkin tab (e.g. after adding a goal in Settings)
  const hasLoadedOnce = useRef(false)
  useEffect(() => {
    if (!hasLoadedOnce.current) { hasLoadedOnce.current = true; return }
    if (active) loadAll()
  }, [active])

  async function loadAll() {
    setLoading(true)
    if (navigator.onLine) await flushOfflineQueue()

    const [goalsRes, partnersRes, checkinRes, checkinDatesRes, missedRes, deadlineMissRes, settingsRes] = await Promise.all([
      supabase.from('goals').select('*').eq('user_id', userId).eq('active', true).order('created_at'),
      supabase.from('accountability_partners').select('*').eq('user_id', userId),
      supabase.from('checkins').select('*').eq('user_id', userId).eq('date', today).maybeSingle(),
      supabase.from('checkins').select('date').eq('user_id', userId).lt('date', today).order('date', { ascending: true }),
      supabase.from('missed_days').select('*').eq('user_id', userId).order('date', { ascending: false }),
      supabase.from('missed_goal_deadlines').select('*').eq('user_id', userId).order('deadline', { ascending: false }),
      supabase.from('user_settings').select('rest_days').eq('user_id', userId).maybeSingle(),
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
      setLastSavedSnapshot(buildEditableSnapshot({
        mood: c.mood || 0,
        learned: c.learned || '',
        built: c.built || '',
        builtLink: c.built_link || '',
        goalProgress: progress,
        goals: userGoals,
      }))
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
      setCheckin(null)
      setMoodVal(0)
      setLearned('')
      setBuilt('')
      setBuiltLink('')
      setSaveStatus('idle')
      setGoalProgress(progress)
      setLastSavedSnapshot(buildEditableSnapshot({
        mood: 0,
        learned: '',
        built: '',
        builtLink: '',
        goalProgress: progress,
        goals: userGoals,
      }))
    }

    // Check rest days (server-side)
    const restDays = settingsRes.data?.rest_days || []
    setRestDaysState(restDays)
    const checkinDateSet = new Set((checkinDatesRes.data || []).map(c => c.date))
    const missedDays = missedRes.data || []
    const deadlineMisses = deadlineMissRes.data || []
    const missedDaySet = new Set(missedDays.map(m => m.date))
    const oldestScanDate = dateOffset(today, -365)
    const goalStartCandidates = userGoals
      .map(g => (g.created_at ? toDateKey(new Date(g.created_at)) : null))
      .filter(Boolean)
      .sort()
    const scanStart = goalStartCandidates[0] && goalStartCandidates[0] > oldestScanDate
      ? goalStartCandidates[0]
      : oldestScanDate
    const yesterday = getYesterday()

    let nextMissingDate = null
    if (userGoals.length > 0 && scanStart <= yesterday) {
      let d = scanStart
      while (d <= yesterday) {
        const dow = new Date(d).getDay()
        const isRestDay = restDays.includes(dow)
        if (!isRestDay && !checkinDateSet.has(d) && !missedDaySet.has(d)) {
          nextMissingDate = d
          break
        }
        d = dateOffset(d, 1)
      }
    }

    const nextPendingMissedDay = [...missedDays]
      .filter(m => !m.email_sent && !m.verdict)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null

    if (nextPendingMissedDay) {
      setMissedDate(nextPendingMissedDay.date)
      setMissedReason(nextPendingMissedDay.excuse || '')
      setMissedAvoidable(nextPendingMissedDay.was_avoidable === null ? null : !!nextPendingMissedDay.was_avoidable)
      setMissedSending(false)
    } else if (nextMissingDate) {
      setMissedDate(nextMissingDate)
      setMissedReason('')
      setMissedAvoidable(null)
      setMissedSending(false)
    } else {
      setMissedDate(null)
      setMissedReason('')
      setMissedAvoidable(null)
      setMissedSending(false)
    }

    const overdueGoals = userGoals
      .filter(g => g.deadline && g.deadline < today)
      .sort((a, b) => a.deadline.localeCompare(b.deadline))
    const deadlineMissedKeys = new Set(deadlineMisses.map(m => `${m.goal_id}:${m.deadline}`))
    const nextDeadlineIssue = overdueGoals.find(g => !deadlineMissedKeys.has(`${g.id}:${g.deadline}`))
    const nextPendingDeadline = [...deadlineMisses]
      .filter(m => !m.email_sent && !m.verdict)
      .sort((a, b) => a.deadline.localeCompare(b.deadline))[0] || null

    const hasDeadlinePunishment = await checkDeadlineVerdicts(deadlineMisses, userPartners, userGoals)
    const hasMissedDayPunishment = hasDeadlinePunishment ? false : await checkVerdicts(missedDays, userPartners)

    if (!hasDeadlinePunishment && !hasMissedDayPunishment) setPunishment(null)

    if (!hasDeadlinePunishment && nextPendingDeadline) {
      const matchingGoal = userGoals.find(g => g.id === nextPendingDeadline.goal_id)
      setDeadlineIssue({
        goalId: nextPendingDeadline.goal_id,
        title: matchingGoal?.title || 'Goal',
        deadline: nextPendingDeadline.deadline,
      })
      setDeadlineReason(nextPendingDeadline.excuse || '')
      setDeadlineAvoidable(nextPendingDeadline.was_avoidable === null ? null : !!nextPendingDeadline.was_avoidable)
      setDeadlineExtensionDate(
        nextPendingDeadline.requested_deadline || getSuggestedExtensionDate(nextPendingDeadline.deadline),
      )
      setDeadlineSending(false)
    } else if (nextDeadlineIssue && !hasDeadlinePunishment) {
      setDeadlineIssue({ goalId: nextDeadlineIssue.id, title: nextDeadlineIssue.title, deadline: nextDeadlineIssue.deadline })
      setDeadlineReason('')
      setDeadlineAvoidable(null)
      setDeadlineExtensionDate(getSuggestedExtensionDate(nextDeadlineIssue.deadline))
      setDeadlineSending(false)
    } else {
      setDeadlineIssue(null)
      setDeadlineReason('')
      setDeadlineAvoidable(null)
      setDeadlineExtensionDate('')
      setDeadlineSending(false)
    }

    // Load active punishment tasks
    const { data: pTasks } = await supabase.from('punishment_tasks')
      .select('*').eq('user_id', userId).eq('completed', false)
      .order('due_date', { ascending: true })
    setPunishmentTasks(pTasks || [])
    const proofState = {}
    for (const t of (pTasks || [])) proofState[t.id] = t.proof_url || ''
    setPunishmentTaskProof(proofState)

    // Load encouragements (most recent 5)
    const { data: cheerData } = await supabase.from('encouragements')
      .select('id, sender_name, sender_email, message, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5)
    setEncouragements(cheerData || [])

    // Check for stale abandoned goals (30+ days, no email sent yet)
    await checkAbandonedGoals(userPartners)

    await loadPendingVotes(missedDays, deadlineMisses, userPartners, userGoals)
    await loadStreakAndDots(userGoals.length)
    setLoading(false)
  }

  async function checkAbandonedGoals(partnersList) {
    try {
      const { data: staleGoals } = await supabase.from('goals')
        .select('id, title, abandoned_at')
        .eq('user_id', userId)
        .eq('active', false)
        .is('completed_at', null)
        .not('abandoned_at', 'is', null)
        .eq('abandonment_email_sent', false)
      if (!staleGoals || staleGoals.length === 0) return

      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
      const overdue = staleGoals.filter(g => g.abandoned_at && g.abandoned_at < thirtyDaysAgo)
      if (overdue.length === 0 || !partnersList || partnersList.length === 0) return

      // Send accountability email for abandoned goals
      const messages = partnersList.map(p => ({
        to_email: p.email,
        from_name: 'Accountabuddy',
        abandoned_goals: overdue.map(g => g.title).join(', '),
        goal_count: overdue.length,
      }))

      try {
        await sendAccountabilityEmails({ mode: 'abandoned', messages })
        // Mark as sent
        for (const goal of overdue) {
          await supabase.rpc('mark_abandonment_email_sent', { p_goal_id: goal.id })
        }
      } catch (err) {
        console.error('Failed to send abandoned goal emails:', err)
      }
    } catch (err) {
      console.error('Abandoned goals check failed:', err)
    }
  }

  async function loadStreakAndDots(activeGoalCount = goals.length) {
    const [checkinsRes, missedRes, deadlineMissRes] = await Promise.all([
      supabase.from('checkins').select('id, date, mood').eq('user_id', userId)
        .gte('date', dateOffset(today, -365)).order('date', { ascending: false }),
      supabase.from('missed_days').select('date').eq('user_id', userId)
        .gte('date', dateOffset(today, -365)),
      supabase.from('missed_goal_deadlines').select('deadline, verdict').eq('user_id', userId)
        .gte('deadline', dateOffset(today, -365)),
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
    const checkinMap = {}
    for (const c of checkins) checkinMap[c.date] = c.mood
    const missedDates = new Set((missedRes.data || []).map(m => m.date))
    const deadlinePenaltyDates = new Set(
      (deadlineMissRes.data || [])
        .filter(m => m.verdict !== 'accepted')
        .map(m => m.deadline),
    )
    for (const d of deadlinePenaltyDates) missedDates.add(d)

    // Streak (rest days don't break streaks, partial check-ins don't count)
    const restDays = restDaysState
    const noActiveGoals = activeGoalCount === 0
    setStreakPaused(noActiveGoals)

    if (noActiveGoals) {
      const lastQualified = getLatestDate(qualifiedDates)
      const lastVerifiedQualified = getLatestDate(verifiedQualifiedDates)
      setStreak(getConsecutiveStreakFromDate(qualifiedDates, lastQualified, dateOffset, restDays))
      setVerifiedStreak(getConsecutiveStreakFromDate(verifiedQualifiedDates, lastVerifiedQualified, dateOffset, restDays))
    } else {
      let s = 0
      if (!deadlinePenaltyDates.has(today) && qualifiedDates.has(today)) s = 1
      let d = dateOffset(today, -1)
      while (true) {
        const dow = new Date(d).getDay()
        if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
        if (deadlinePenaltyDates.has(d)) break
        if (!qualifiedDates.has(d)) break
        s++; d = dateOffset(d, -1)
      }
      setStreak(s)

      let vs = 0
      if (!deadlinePenaltyDates.has(today) && verifiedQualifiedDates.has(today)) vs = 1
      d = dateOffset(today, -1)
      while (true) {
        const dow = new Date(d).getDay()
        if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
        if (deadlinePenaltyDates.has(d)) break
        if (!verifiedQualifiedDates.has(d)) break
        vs++; d = dateOffset(d, -1)
      }
      setVerifiedStreak(vs)
    }

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

  async function checkDeadlineVerdicts(deadlineMisses, userPartners, userGoals) {
    const goalTitleById = {}
    for (const goal of (userGoals || [])) goalTitleById[goal.id] = goal.title

    for (const missed of deadlineMisses) {
      const goalTitle = goalTitleById[missed.goal_id] || 'Goal'
      const requestedExtensionText = missed.requested_deadline
        ? ` Requested extension to ${formatDate(missed.requested_deadline)}.`
        : ''
      if (missed.verdict !== 'rejected') continue
      if (!missed.shame_email_sent) {
        try {
          const excuseText = `${formatGoalDeadlineLabel(goalTitle, missed.deadline)} — ${missed.excuse}${requestedExtensionText}`
          const messages = userPartners.map(p => ({
            to_email: p.email,
            from_name: 'Accountabuddy user',
            missed_date: formatDate(missed.deadline),
            excuse: excuseText,
            excuse_text: excuseText,
            accept_count: missed.vote_accepts,
            reject_count: missed.vote_rejects,
            total_votes: missed.vote_total,
            punishment: formatPunishmentChoice(missed.selected_punishment),
          }))
          await sendAccountabilityEmails({ mode: 'shame', messages })
          await supabase.rpc('mark_shame_email_sent', { p_source_type: 'deadline', p_source_id: missed.id })
        } catch (err) { console.error('Deadline shame email error:', err) }
      }
      if (!missed.punishment_acknowledged) {
        setPunishment({
          id: missed.id,
          source: 'deadline',
          date: missed.deadline,
          excuse: `${formatGoalDeadlineLabel(goalTitle, missed.deadline)} — ${missed.excuse}${requestedExtensionText}`,
          voteCount: { accepts: missed.vote_accepts, rejects: missed.vote_rejects },
          punishmentChoice: missed.selected_punishment,
          punishmentChoiceVotes: missed.selected_punishment_votes || 0,
        })
        return true
      }
    }

    return false
  }

  async function checkVerdicts(missedDays, userPartners) {
    for (const missed of missedDays) {
      if (missed.verdict !== 'rejected') continue
      if (!missed.shame_email_sent) {
        try {
          const messages = userPartners.map(p => ({
              to_email: p.email,
              from_name: 'Accountabuddy user',
              missed_date: formatDate(missed.date),
              excuse: missed.excuse,
              excuse_text: missed.excuse,
              accept_count: missed.vote_accepts,
              reject_count: missed.vote_rejects,
              total_votes: missed.vote_total,
              punishment: formatPunishmentChoice(missed.selected_punishment),
            }))
          await sendAccountabilityEmails({ mode: 'shame', messages })
          await supabase.rpc('mark_shame_email_sent', { p_source_type: 'missed_day', p_source_id: missed.id })
        } catch (err) { console.error('Shame email error:', err) }
      }
      if (!missed.punishment_acknowledged) {
        setPunishment({
          id: missed.id,
          source: 'missed_day',
          date: missed.date,
          excuse: missed.excuse,
          voteCount: { accepts: missed.vote_accepts, rejects: missed.vote_rejects },
          punishmentChoice: missed.selected_punishment,
          punishmentChoiceVotes: missed.selected_punishment_votes || 0,
        })
        return true
      }
    }

    return false
  }

  // ── Load pending vote progress ───────────────────────────
  async function loadPendingVotes(missedDays, deadlineMisses, userPartners, userGoals) {
    const goalTitleById = {}
    for (const goal of (userGoals || [])) goalTitleById[goal.id] = goal.title
    const currentPartnerEmails = userPartners
      .map(p => String(p.email || '').trim().toLowerCase())
      .filter(Boolean)

    const pendingMissedDays = (missedDays || [])
      .filter(m => m.excuse_id && m.email_sent && !m.verdict)
      .map(m => ({
        date: m.date,
        excuse: m.excuse,
        excuseId: m.excuse_id,
        requiredVotes: m.required_votes || getMajorityVoteThreshold(m.partner_count_snapshot || currentPartnerEmails.length),
        partnerCountSnapshot: m.partner_count_snapshot || currentPartnerEmails.length,
      }))

    const pendingDeadlines = (deadlineMisses || [])
      .filter(m => m.excuse_id && m.email_sent && !m.verdict)
      .map(m => {
        const goalTitle = goalTitleById[m.goal_id] || 'Goal'
        const requestedExtensionText = m.requested_deadline
          ? ` Requested extension to ${formatDate(m.requested_deadline)}.`
          : ''
        return {
          date: m.deadline,
          excuse: `${formatGoalDeadlineLabel(goalTitle, m.deadline)} — ${m.excuse}${requestedExtensionText}`,
          excuseId: m.excuse_id,
          requiredVotes: m.required_votes || getMajorityVoteThreshold(m.partner_count_snapshot || currentPartnerEmails.length),
          partnerCountSnapshot: m.partner_count_snapshot || currentPartnerEmails.length,
        }
      })

    const pending = [...pendingMissedDays, ...pendingDeadlines]
    if (pending.length === 0) { setPendingVotes([]); return }

    const results = []
    for (const m of pending) {
      const [votesRes, invitesRes] = await Promise.all([
        supabase.from('excuse_votes')
          .select('voter_email, vote')
          .eq('excuse_id', m.excuseId)
          .eq('owner_user_id', userId),
        supabase.from('excuse_vote_invites')
          .select('voter_email')
          .eq('excuse_id', m.excuseId)
          .eq('user_id', userId),
      ])

      const votes = votesRes.data || []
      const rosterEmails = [...new Set(
        (invitesRes.data || [])
          .map(row => String(row.voter_email || '').trim().toLowerCase())
          .filter(Boolean),
      )]
      const partnerEmails = rosterEmails.length > 0 ? rosterEmails : currentPartnerEmails

      const voteMap = {}
      if (votes) {
        for (const v of votes) {
          const emailKey = String(v.voter_email || '').trim().toLowerCase()
          if (emailKey) voteMap[emailKey] = v.vote
        }
      }

      const partnerVotes = partnerEmails.map(email => ({
        email,
        voted: !!voteMap[email],
        vote: voteMap[email] || null,
      }))
      const accepts = (votes || []).filter(v => v.vote === 'accept').length
      const rejects = (votes || []).filter(v => v.vote === 'reject').length

      results.push({
        date: m.date,
        excuse: m.excuse,
        excuseId: m.excuseId,
        partnerVotes,
        accepts,
        rejects,
        totalVoted: (votes || []).length,
        totalPartners: m.partnerCountSnapshot || partnerEmails.length,
        requiredVotes: m.requiredVotes,
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
      setLastSavedSnapshot(buildEditableSnapshot({
        mood: checkinData.mood,
        learned: checkinData.learned,
        built: checkinData.built,
        builtLink: checkinData.built_link || '',
        goalProgress,
        goals,
      }))
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
        setLastSavedSnapshot(buildEditableSnapshot({
          mood: checkinData.mood,
          learned: checkinData.learned,
          built: checkinData.built,
          builtLink: checkinData.built_link || '',
          goalProgress: nextGoalProgress,
          goals,
        }))
        setSaveStatus('saved')
        loadStreakAndDots()
      }
    } catch (err) {
      if (version === saveVersion.current) setSaveStatus('error')
      const msg = String(err?.message || '')
      if (msg.includes('column') || msg.includes('proof_verifications')) {
        showToast('Database schema outdated. Run the latest SQL setup.', 'error')
      } else if (msg) {
        showToast(msg, 'error')
      } else {
        showToast('Failed to save check-in', 'error')
      }
      console.error('Check-in save error:', err)
    }
  }, [userId, today, mood, learned, built, builtLink, goalProgress, checkin, goals])

  // Derived state
  const completedGoalEntries = Object.values(goalProgress).filter(gp => gp.completed)
  const hasSelectedGoal = completedGoalEntries.length > 0
  const completedGoalsWithProof = completedGoalEntries.filter(gp => hasGoalProof(gp)).length
  const hasCompletedWithoutProof = completedGoalEntries.some(gp => !hasGoalProof(gp))
  const verifiedTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'verified').length
  const pendingTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'pending').length
  const failedTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'failed').length
  const challengedTodayGoals = completedGoalEntries.filter(gp => getVerificationStatus(gp) === 'challenged').length
  const auditTodayGoals = completedGoalEntries.filter(gp => gp.auditRequired).length
  const hasFailedVerificationToday = failedTodayGoals > 0
  const noActiveGoals = goals.length === 0
  const isComplete = !noActiveGoals
    && learned.trim().length >= 50
    && completedGoalsWithProof > 0
    && !hasCompletedWithoutProof
  const currentInputSnapshot = useMemo(() => buildEditableSnapshot({
    mood,
    learned,
    built,
    builtLink,
    goalProgress,
    goals,
  }), [mood, learned, built, builtLink, goalProgress, goals])
  const hasUnsavedChanges = useMemo(
    () => !areEditableSnapshotsEqual(currentInputSnapshot, lastSavedSnapshot),
    [currentInputSnapshot, lastSavedSnapshot],
  )
  const doneForToday = !noActiveGoals
    && saveStatus === 'saved'
    && isComplete
    && failedTodayGoals === 0
    && !hasUnsavedChanges

  useEffect(() => {
    if (!doneForToday || postSubmitUiApplied) return
    setCollapsed(prev => ({ ...prev, goals: true, mood: true, learned: true, built: true }))
    setPostSubmitUiApplied(true)
    import('canvas-confetti').then(({ default: confetti }) => {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } })
    }).catch(() => {})
  }, [doneForToday, postSubmitUiApplied])

  // Auto-save (only if enabled in settings)
  useEffect(() => {
    if (!autoSaveEnabled) {
      clearTimeout(autoSaveTimer.current)
      return
    }
    if (!hasUnsavedChanges) return
    if (loading) return
    if (noActiveGoals) { setSaveStatus('idle'); return }
    if (!isComplete) { setSaveStatus('idle'); return }
    setSaveStatus('idle')
    clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(doSave, 2000)
    return () => clearTimeout(autoSaveTimer.current)
  }, [mood, learned, built, builtLink, goalProgress, isComplete, loading, doSave, noActiveGoals, autoSaveEnabled, hasUnsavedChanges])

  // ── Punishment ────────────────────────────────────────────
  async function acknowledgePunishment() {
    if (punishmentInput !== 'I will do better') return
    const table = punishment?.source === 'deadline' ? 'missed_goal_deadlines' : 'missed_days'
    const query = supabase.from(table).update({ punishment_acknowledged: true }).eq('user_id', userId)
    if (punishment?.id) await query.eq('id', punishment.id)
    else if (table === 'missed_goal_deadlines') await query.eq('deadline', punishment.date)
    else await query.eq('date', punishment.date)
    setPunishment(null)
    setPunishmentInput('')
  }

  // ── Punishment task completion ───────────────────────────
  async function completePunishmentTask(taskId) {
    const proof = (punishmentTaskProof[taskId] || '').trim()
    const { error: err } = await supabase.from('punishment_tasks')
      .update({ completed: true, completed_at: new Date().toISOString(), proof_url: proof || null })
      .eq('id', taskId)
    if (err) { showToast(err.message, 'error'); return }
    setPunishmentTasks(prev => prev.filter(t => t.id !== taskId))
    showToast('Punishment task completed')
  }

  // ── Missed day submit ─────────────────────────────────────
  async function handleMissedSubmit() {
    const excuse = missedReason.trim()
    if (excuse.length < 80 || missedAvoidable === null) return
    setMissedSending(true)

    const generatedExcuseId = `${missedDate}-${Date.now()}`
    const partnerCountSnapshot = partners.length
    const requiredVotes = getMajorityVoteThreshold(partnerCountSnapshot)

    const { data: existingMissedRow, error: existingMissedErr } = await supabase
      .from('missed_days')
      .select('id, excuse_id, excuse, was_avoidable, email_sent, verdict')
      .eq('user_id', userId)
      .eq('date', missedDate)
      .maybeSingle()
    if (existingMissedErr) {
      showToast(existingMissedErr.message || 'Failed to load existing missed day', 'error')
      setMissedSending(false)
      return
    }

    let missedRow = existingMissedRow
    if (missedRow) {
      if (missedRow.verdict) {
        showToast('This missed day already has a final verdict', 'error')
        setMissedSending(false)
        await loadAll()
        return
      }
      if (missedRow.email_sent) {
        showToast('Excuse already submitted for this missed day', 'error')
        setMissedSending(false)
        await loadAll()
        return
      }
    } else {
      const { data: insertedRow, error: insertErr } = await supabase.from('missed_days').insert({
        user_id: userId,
        date: missedDate,
        excuse,
        was_avoidable: missedAvoidable,
        excuse_id: generatedExcuseId,
        email_sent: false,
        required_votes: requiredVotes,
        partner_count_snapshot: partnerCountSnapshot,
      }).select('id, excuse_id, excuse, was_avoidable, email_sent').single()

      if (insertErr) {
        showToast(insertErr.message || 'Failed to save excuse', 'error')
        setMissedSending(false)
        return
      }
      missedRow = insertedRow
    }

    const activeExcuseId = missedRow?.excuse_id || generatedExcuseId
    if (!activeExcuseId) {
      showToast('Existing missed-day record is missing excuse id. Please contact support.', 'error')
      setMissedSending(false)
      return
    }
    const activeExcuse = missedRow?.excuse || excuse
    const activeAvoidable = missedRow?.was_avoidable === null ? missedAvoidable : missedRow?.was_avoidable

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
      const restDays = restDaysState
      let d = dateOffset(missedDate, -1)
      while (true) {
        const dow = new Date(d).getDay()
        if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
        if (!qualifiedDates.has(d)) break
        streakBefore++
        d = dateOffset(d, -1)
      }
    }

    let sentSuccessfully = false
    try {
      const tokenByEmail = await createVoteInviteLinks({
        sourceType: 'missed_day',
        sourceId: missedRow.id,
        excuseId: activeExcuseId,
        missedDate,
        excuseText: activeExcuse,
        emails: partners.map(p => p.email),
      })

      const messages = partners.map(p => {
        const token = tokenByEmail[String(p.email || '').trim().toLowerCase()]
        if (!token) return null
        const base = `${VOTE_BASE_URL}?token=${encodeURIComponent(token)}`
        return {
          to_email: p.email,
          from_name: session?.user?.email?.split('@')[0] || 'Accountabuddy user',
          missed_date: formatDate(missedDate),
          excuse: activeExcuse,
          excuse_text: activeExcuse,
          vote_url: base,
          was_avoidable: activeAvoidable ? 'Yes' : 'No',
          streak: streakBefore,
          accept_url: base + '&vote=accept',
          reject_url: base + '&vote=reject',
        }
      }).filter(Boolean)
      const sentCount = messages.length
      if (sentCount > 0) {
        await sendAccountabilityEmails({ mode: 'vote', messages })
      }
      if (sentCount === 0) {
        showToast('Could not generate secure vote links', 'error')
      } else {
        await supabase.rpc('mark_excuse_emails_sent', { p_source_type: 'missed_day', p_source_id: missedRow.id })
        sentSuccessfully = true
        showToast(`Excuse sent to ${sentCount} accountability partners`)
      }
    } catch (err) { showToast('Failed to send emails', 'error'); console.error('EmailJS error:', err) }

    if (!sentSuccessfully) {
      setMissedSending(false)
      return
    }

    setMissedDate(null); setMissedReason(''); setMissedAvoidable(null); setMissedSending(false)
    await loadAll()
  }

  // ── Missed deadline submit ────────────────────────────────
  async function handleDeadlineSubmit() {
    const excuse = deadlineReason.trim()
    const extensionDate = deadlineExtensionDate.trim()
    if (!deadlineIssue || excuse.length < 80 || deadlineAvoidable === null) return
    if (!isDateKey(extensionDate) || extensionDate <= today) {
      showToast('Choose a valid new deadline after today', 'error')
      return
    }
    if (extensionDate <= deadlineIssue.deadline) {
      showToast('New deadline must be after the missed deadline', 'error')
      return
    }
    const maxExtensionDate = dateOffset(deadlineIssue.deadline, 14)
    if (extensionDate > maxExtensionDate) {
      showToast(`Extension can be at most 14 days after the missed deadline (${formatDate(maxExtensionDate)})`, 'error')
      return
    }
    setDeadlineSending(true)

    const generatedExcuseId = `${deadlineIssue.goalId}-${deadlineIssue.deadline}-${Date.now()}`
    const partnerCountSnapshot = partners.length
    const requiredVotes = getMajorityVoteThreshold(partnerCountSnapshot)

    const { data: existingDeadlineRow, error: existingDeadlineErr } = await supabase
      .from('missed_goal_deadlines')
      .select('id, excuse_id, excuse, requested_deadline, was_avoidable, email_sent, verdict')
      .eq('user_id', userId)
      .eq('goal_id', deadlineIssue.goalId)
      .eq('deadline', deadlineIssue.deadline)
      .maybeSingle()
    if (existingDeadlineErr) {
      showToast(existingDeadlineErr.message || 'Failed to load existing deadline excuse', 'error')
      setDeadlineSending(false)
      return
    }

    let deadlineRow = existingDeadlineRow
    if (deadlineRow) {
      if (deadlineRow.verdict) {
        showToast('This missed deadline already has a final verdict', 'error')
        setDeadlineSending(false)
        await loadAll()
        return
      }
      if (deadlineRow.email_sent) {
        showToast('Deadline excuse already submitted for this goal and date', 'error')
        setDeadlineSending(false)
        await loadAll()
        return
      }
    } else {
      const { data: insertedRow, error: insertErr } = await supabase.from('missed_goal_deadlines').insert({
        user_id: userId,
        goal_id: deadlineIssue.goalId,
        deadline: deadlineIssue.deadline,
        excuse,
        requested_deadline: extensionDate,
        was_avoidable: deadlineAvoidable,
        excuse_id: generatedExcuseId,
        email_sent: false,
        required_votes: requiredVotes,
        partner_count_snapshot: partnerCountSnapshot,
      }).select('id, excuse_id, excuse, requested_deadline, was_avoidable, email_sent').single()

      if (insertErr) {
        showToast(insertErr.message || 'Failed to save deadline excuse', 'error')
        setDeadlineSending(false)
        return
      }
      deadlineRow = insertedRow
    }

    const activeExcuseId = deadlineRow?.excuse_id || generatedExcuseId
    if (!activeExcuseId) {
      showToast('Existing deadline record is missing excuse id. Please contact support.', 'error')
      setDeadlineSending(false)
      return
    }
    const activeExcuse = deadlineRow?.excuse || excuse
    const activeRequestedDeadline = deadlineRow?.requested_deadline || extensionDate
    const activeAvoidable = deadlineRow?.was_avoidable === null ? deadlineAvoidable : deadlineRow?.was_avoidable
    const excuseText = `${formatGoalDeadlineLabel(deadlineIssue.title, deadlineIssue.deadline)} — ${activeExcuse} Requested extension to ${formatDate(activeRequestedDeadline)}.`

    const { data: recentCheckins } = await supabase.from('checkins').select('id, date')
      .eq('user_id', userId).lt('date', deadlineIssue.deadline).order('date', { ascending: false }).limit(365)

    let streakBefore = 0
    if (recentCheckins && recentCheckins.length > 0) {
      const checkinIds = recentCheckins.map(c => c.id)
      const { data: gpRows } = await supabase.from('goal_progress')
        .select('checkin_id, completed, proof_url, proof_image_path, verification_status')
        .in('checkin_id', checkinIds)
      const dailyQuality = buildDailyGoalQuality(recentCheckins, gpRows || [])
      const qualifiedDates = getQualifiedDateSet(dailyQuality)
      const restDays = restDaysState
      let d = dateOffset(deadlineIssue.deadline, -1)
      while (true) {
        const dow = new Date(d).getDay()
        if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
        if (!qualifiedDates.has(d)) break
        streakBefore++
        d = dateOffset(d, -1)
      }
    }

    let sentSuccessfully = false
    try {
      const tokenByEmail = await createVoteInviteLinks({
        sourceType: 'deadline',
        sourceId: deadlineRow.id,
        excuseId: activeExcuseId,
        missedDate: deadlineIssue.deadline,
        excuseText,
        emails: partners.map(p => p.email),
      })

      const messages = partners.map(p => {
        const token = tokenByEmail[String(p.email || '').trim().toLowerCase()]
        if (!token) return null
        const base = `${VOTE_BASE_URL}?token=${encodeURIComponent(token)}`
        return {
          to_email: p.email,
          from_name: session?.user?.email?.split('@')[0] || 'Accountabuddy user',
          missed_date: formatDate(deadlineIssue.deadline),
          excuse: excuseText,
          excuse_text: excuseText,
          vote_url: base,
          was_avoidable: activeAvoidable ? 'Yes' : 'No',
          streak: streakBefore,
          accept_url: base + '&vote=accept',
          reject_url: base + '&vote=reject',
        }
      }).filter(Boolean)
      const sentCount = messages.length
      if (sentCount > 0) {
        await sendAccountabilityEmails({ mode: 'vote', messages })
      }
      if (sentCount === 0) {
        showToast('Could not generate secure vote links', 'error')
      } else {
        await supabase.rpc('mark_excuse_emails_sent', { p_source_type: 'deadline', p_source_id: deadlineRow.id })
        sentSuccessfully = true
        showToast(`Deadline excuse sent to ${sentCount} accountability partners`)
      }
    } catch (err) { showToast('Failed to send deadline emails', 'error'); console.error('Deadline EmailJS error:', err) }

    if (!sentSuccessfully) {
      setDeadlineSending(false)
      return
    }

    setDeadlineIssue(null)
    setDeadlineReason('')
    setDeadlineAvoidable(null)
    setDeadlineExtensionDate('')
    setDeadlineSending(false)
    await loadAll()
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
    if (!hasUnsavedChanges) {
      showToast('No changes to save', 'error')
      return
    }
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
  const tomorrowDisplay = formatShortDate(dateOffset(today, 1))

  // ── Save status label ────────────────────────────────
  const saveLabel = noActiveGoals ? 'No active goals — add a new goal in Settings'
    : saveStatus === 'saving' ? 'Saving...'
    : saveStatus === 'error' ? 'Save failed'
    : !autoSaveEnabled && hasUnsavedChanges ? 'Unsaved changes'
    : saveStatus === 'saved' ? (doneForToday ? 'All set for today' : hasFailedVerificationToday ? 'Saved - fix failed proof' : 'Saved')
    : isComplete && autoSaveEnabled ? 'Will auto-save'
    : ''
  const saveIndicatorState = !autoSaveEnabled && hasUnsavedChanges && saveStatus !== 'saving'
    ? 'idle'
    : saveStatus

  // ── Loading ───────────────────────────────────────────────
  if (loading) {
    return (
      <div className="app">
        <header><h1>Accountabuddy</h1><p className="date">{dateDisplay}</p></header>
        <section className="card"><p className="vote-status">Loading...</p></section>
      </div>
    )
  }

  // ── Punishment ────────────────────────────────────────────
  if (punishment) {
    const inputMatch = punishmentInput === 'I will do better'
    const relatedTask = punishmentTasks.find(t => t.source_id === punishment.id && t.source_type === punishment.source)
    const taskDone = !relatedTask // task either completed or doesn't exist yet
    const canAcknowledge = inputMatch && taskDone
    return (
      <div className="app">
        <header><h1>Accountabuddy</h1><p className="date">{dateDisplay}</p></header>
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
            <p><strong>Assigned punishment:</strong> {formatPunishmentChoice(punishment.punishmentChoice)}</p>
            {punishment.punishmentChoiceVotes > 0 && (
              <p>This punishment won with {punishment.punishmentChoiceVotes} reject vote(s).</p>
            )}
          </div>

          {relatedTask && (
            <div className="punishment-task-inline">
              <h3>Complete Your Punishment</h3>
              <p className="punishment-task-desc">{relatedTask.description}</p>
              <p className="punishment-task-due">
                Due: {formatDate(relatedTask.due_date)}
                {relatedTask.due_date < today ? ' (overdue)' : ''}
              </p>
              <input
                type="text"
                className="field-input"
                placeholder="Proof URL (link to evidence)"
                value={punishmentTaskProof[relatedTask.id] || ''}
                onChange={e => setPunishmentTaskProof(prev => ({ ...prev, [relatedTask.id]: e.target.value }))}
              />
              <button className="save-btn" onClick={() => completePunishmentTask(relatedTask.id)}>
                Mark Punishment as Done
              </button>
              <p className="punishment-task-note">Must wait at least 1 hour after assignment.</p>
            </div>
          )}

          <div className="punishment-gate">
            <p className="punishment-instruction">
              {relatedTask
                ? 'Complete the punishment task above first, then type "I will do better" to continue.'
                : 'Type "I will do better" exactly to continue.'}
            </p>
            <input type="text" className={`field-input punishment-input ${inputMatch ? 'punishment-match' : ''}`}
              value={punishmentInput} onChange={e => setPunishmentInput(e.target.value)}
              placeholder="I will do better" spellCheck={false} autoComplete="off"
              disabled={!!relatedTask} />
            <button className="save-btn" onClick={acknowledgePunishment} disabled={!canAcknowledge}>
              {relatedTask ? 'Complete punishment first' : 'Acknowledge & Continue'}
            </button>
          </div>
        </section>
      </div>
    )
  }

  // ── Missed goal deadline ──────────────────────────────────
  if (deadlineIssue) {
    const charCount = deadlineReason.trim().length
    const hasValidExtensionDate = isDateKey(deadlineExtensionDate) && deadlineExtensionDate > today && deadlineExtensionDate > deadlineIssue.deadline
    const canSubmit = charCount >= 80 && deadlineAvoidable !== null && hasValidExtensionDate && !deadlineSending
    return (
      <div className="app">
        <header><h1>Accountabuddy</h1><p className="date">{dateDisplay}</p></header>
        <section className="card missed-card">
          <h2>Missed Goal Deadline</h2>
          <p className="missed-date">{formatDate(deadlineIssue.deadline)}</p>
          <p className="missed-prompt">
            Goal: <strong>{deadlineIssue.title}</strong>.
            {' '}You missed this deadline. Submit an excuse; it will be sent to {partners.length} people for voting.
          </p>
          <textarea className="missed-textarea" placeholder="What blocked you? What changed? (at least 80 characters)"
            value={deadlineReason} onChange={e => setDeadlineReason(e.target.value)} rows={5} />
          <p className={`char-count ${charCount >= 80 ? 'met' : ''}`}>{charCount}/80 characters</p>
          <div className="deadline-extension-section">
            <p className="avoidable-label">New target deadline</p>
            <input
              type="date"
              className="field-input"
              value={deadlineExtensionDate}
              min={dateOffset(today, 1)}
              onChange={e => setDeadlineExtensionDate(e.target.value)}
            />
            <p className="settings-item-sub">Set when you will actually deliver this goal.</p>
          </div>
          <div className="avoidable-section">
            <p className="avoidable-label">Was this avoidable?</p>
            <div className="avoidable-toggle">
              <button className={`toggle-btn ${deadlineAvoidable === true ? 'toggle-active toggle-yes' : ''}`} onClick={() => setDeadlineAvoidable(true)}>Yes</button>
              <button className={`toggle-btn ${deadlineAvoidable === false ? 'toggle-active toggle-no' : ''}`} onClick={() => setDeadlineAvoidable(false)}>No</button>
            </div>
          </div>
          <button className="save-btn" onClick={handleDeadlineSubmit} disabled={!canSubmit}>
            {deadlineSending ? 'Sending...' : 'Submit Deadline Excuse & Notify Group'}
          </button>
        </section>
        {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
      </div>
    )
  }

  // ── Missed day ────────────────────────────────────────────
  if (missedDate) {
    const charCount = missedReason.trim().length
    const canSubmit = charCount >= 80 && missedAvoidable !== null && !missedSending
    const missedPrompt = missedDate === getYesterday()
      ? `You didn't check in yesterday. Write your excuse below. This will be emailed to ${partners.length} people who will vote on whether it's acceptable.`
      : `You missed a check-in on this date. Write your excuse below before continuing with today's check-in. This will be emailed to ${partners.length} people who will vote on whether it's acceptable.`
    return (
      <div className="app">
        <header><h1>Accountabuddy</h1><p className="date">{dateDisplay}</p></header>
        <section className="card missed-card">
          <h2>Missed Day</h2>
          <p className="missed-date">{formatDate(missedDate)}</p>
          <p className="missed-prompt">{missedPrompt}</p>
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
        <h1>Accountabuddy</h1>
        <p className="date">{dateDisplay}</p>
        {streak > 0 && (
          <p className="streak">
            {streak} day streak
            {verifiedStreak !== streak && <span className="streak-verified"> ({verifiedStreak} verified)</span>}
            {streakPaused && <span className="streak-paused"> paused</span>}
            {[7, 14, 30, 60, 100, 200, 365].includes(streak) && (
              <span className="streak-milestone"> Milestone!</span>
            )}
          </p>
        )}
        {noActiveGoals && (
          <p className="streak-quality">No active goals — streak paused. Add one in Settings.</p>
        )}
      </header>

      {/* Save status indicator */}
      {saveLabel && (
        <div className={`autosave-indicator autosave-${saveIndicatorState}`}>
          {saveLabel}
        </div>
      )}

      {doneForToday && (
        <section className="card day-done-card">
          <h2>All Set For Today</h2>
          <p className="day-done-text">Nothing left to do until tomorrow ({tomorrowDisplay}).</p>
          <p className="day-done-sub">
            {completedGoalsWithProof}/{goals.length} goals
            {pendingTodayGoals > 0 && ` — ${pendingTodayGoals} pending verification`}
            {auditTodayGoals > 0 && ` — ${auditTodayGoals} in audit`}
          </p>
          <button className="history-toggle day-done-edit" onClick={openEditSections}>Edit today</button>
        </section>
      )}

      {noActiveGoals && !doneForToday && (
        <section className="card goal-cycle-card">
          <h2>Goal Cycle Complete</h2>
          <p className="goal-cycle-text">
            Add your next goal in Settings to resume streak progression.
          </p>
          {streak > 0 && (
            <p className="goal-cycle-sub">Streak paused at {streak} day{streak === 1 ? '' : 's'}.</p>
          )}
        </section>
      )}

      {/* Encouragements from partners */}
      {encouragements.length > 0 && (
        <section className="card card-accent-cheer">
          <h2>From Your People</h2>
          <div className="cheer-list">
            {encouragements.map(e => (
              <div key={e.id} className="cheer-item">
                <p className="cheer-message">"{e.message}"</p>
                <span className="cheer-sender">— {e.sender_name || e.sender_email.split('@')[0]}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Punishment tasks — first if present, this is urgent */}
      {punishmentTasks.length > 0 && (
        <section className="card card-accent-red">
          <h2>Punishment Tasks ({punishmentTasks.length})</h2>
          <p className="subtitle">Complete these before your next check-in counts.</p>
          <div className="blocks">
            {punishmentTasks.map(task => (
              <div key={task.id} className="punishment-task-block">
                <p className="punishment-task-desc">{task.description}</p>
                <p className="punishment-task-due">Due: {formatDate(task.due_date)}{task.due_date < today ? ' (overdue)' : ''}</p>
                <input
                  type="text"
                  className="field-input"
                  placeholder="Proof URL (link to evidence)"
                  value={punishmentTaskProof[task.id] || ''}
                  onChange={e => setPunishmentTaskProof(prev => ({ ...prev, [task.id]: e.target.value }))}
                />
                <button className="save-btn" onClick={() => completePunishmentTask(task.id)}>
                  Mark as Done
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 1. GOALS — the primary action ── */}
      <section className="card card-accent-green">
        <h2 className="card-header" onClick={() => toggleCollapse('goals')}>
          Goals <span className="card-header-count">{completedGoalsWithProof}/{goals.length}</span> {collapsed.goals ? '+' : ''}
        </h2>
        {!collapsed.goals && (<>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleGoalImageUpload} style={{ display: 'none' }} />
          {goals.length === 0 ? (
            <p className="empty-state">No goals yet. Add some in Settings to start tracking.</p>
          ) : (<>
            <p className="goal-step-hint">Step 1: tick at least one goal below. Step 2: add proof (URL or image).</p>
            {!hasSelectedGoal && (
              <p className="goal-hint">No goal selected yet. Use the checkbox next to a goal to include it in today&apos;s check-in.</p>
            )}
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
                        {gp.verificationReason && verificationStatus !== 'pending' && (
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
          </>)}
        </>)}
      </section>

      {/* ── 2. MOOD — quick tap ── */}
      <section className="card card-accent-purple">
        <h2 className="card-header" onClick={() => toggleCollapse('mood')}>
          Mood {mood > 0 && <span className="card-header-val">{MOOD_LABELS[mood - 1]}</span>} {collapsed.mood ? '+' : ''}
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

      {/* ── 3. REFLECTIONS — text inputs ── */}
      <section className="card">
        <h2 className="card-header" onClick={() => toggleCollapse('learned')}>
          What I Learned {collapsed.learned ? '+' : ''}
        </h2>
        {!collapsed.learned && (<>
          <textarea className="field-textarea"
            placeholder="What did you learn today? (at least 50 characters)"
            value={learned} onChange={e => setLearned(e.target.value)} rows={3} />
          <p className={`char-count ${learned.trim().length >= 50 ? 'met' : ''}`}>{learned.trim().length}/50</p>
        </>)}
      </section>

      <section className="card">
        <h2 className="card-header" onClick={() => toggleCollapse('built')}>
          What I Built <span className="optional-tag">optional</span> {collapsed.built ? '+' : ''}
        </h2>
        {!collapsed.built && (<>
          <textarea className="field-textarea" placeholder="Built something today? Share it here..."
            value={built} onChange={e => setBuilt(e.target.value)} rows={3} />
          <input type="url" className="field-input" placeholder="Link (optional)"
            value={builtLink} onChange={e => setBuiltLink(e.target.value)} />
        </>)}
      </section>

      {/* ── 4. VOTE PROGRESS — if any pending ── */}
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
                      <span className="vote-tally-total"> ({pv.totalVoted}/{pv.totalPartners})</span>
                    </span>
                  </div>
                  <p className="vote-progress-excuse">"{pv.excuse.length > 80 ? pv.excuse.slice(0, 80) + '...' : pv.excuse}"</p>
                  <div className="vote-progress-partners">
                    {pv.partnerVotes.map(p => (
                      <span key={p.email} className={`vote-partner-chip ${p.voted ? (p.vote === 'accept' ? 'chip-accept' : 'chip-reject') : 'chip-waiting'}`}>
                        {p.email.split('@')[0]}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── 5. 30-DAY DOTS — passive overview ── */}
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
          </div>
        </>)}
      </section>

      {/* ── 6. HISTORY — on demand ── */}
      <section className="card">
        <h2 className="card-header" onClick={toggleHistory}>
          History {showHistory ? '' : '+'}
        </h2>
        {showHistory && (<>
          {history.length === 0 && <p className="empty-state">No entries yet.</p>}
          {history.map(entry => (
            <div key={`${entry.type}-${entry.date}`} className={`history-entry ${entry.type === 'missed' ? 'history-missed' : ''}`}>
              <div className="history-header">
                <span className="history-date">{formatDate(entry.date)}</span>
                {entry.type === 'missed'
                  ? <span className="history-badge badge-missed">Missed</span>
                  : <span className="history-badge badge-done">Done</span>}
              </div>
              {entry.type === 'missed' ? (
                <p className="history-reason">{entry.excuse}</p>
              ) : (
                <div className="history-details">
                  {entry.goalProgress && entry.goalProgress.length > 0 && (
                    <span>
                      {entry.goalProgress.filter(g => g.completed).length}/{entry.goalProgress.length} goals
                    </span>
                  )}
                  <span>{entry.mood > 0 ? MOOD_LABELS[entry.mood - 1] : ''}</span>
                  {entry.learned && <span className="history-learned">{entry.learned}</span>}
                </div>
              )}
            </div>
          ))}
          {historyHasMore && (
            <button className="history-toggle" style={{ marginTop: '0.5rem' }} onClick={() => loadHistory(historyPage + 1)}>
              Load More
            </button>
          )}
        </>)}
      </section>

      {/* Manual save */}
      {((!autoSaveEnabled && hasUnsavedChanges) || (autoSaveEnabled && isComplete && saveStatus !== 'saved')) && (
        <button className="save-btn" onClick={handleForceSave} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving...' : autoSaveEnabled ? 'Save Check-in' : 'Save Changes'}
        </button>
      )}
      {autoSaveEnabled && !isComplete && !noActiveGoals && !doneForToday && (
        <button className="save-btn" disabled style={{ opacity: 0.4 }}>
          {learned.trim().length < 50
            ? `Need ${50 - learned.trim().length} more chars in Today's W`
            : !hasSelectedGoal ? 'Select at least 1 goal above'
            : hasCompletedWithoutProof ? 'Add proof URL or image for selected goals'
            : completedGoalsWithProof === 0 ? 'Add proof for at least 1 selected goal'
            : 'Complete all fields to save'}
        </button>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
    </div>
  )
}

export default App
