import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'
import {
  STREAK_MIN_COMPLETION_RATIO,
  hasGoalProof,
  buildDailyGoalQuality,
  getQualifiedDateSet,
  getAverageCompletionPct,
} from './streakUtils.js'

const MOOD_LABELS = ['Burnt out', 'Low', 'Okay', 'Focused', 'Locked in']

function toDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function dateOffset(dateStr, offset) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + offset)
  return toDateKey(dt)
}

function getToday() {
  return toDateKey(new Date())
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

function getWeekLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const jan1 = new Date(dt.getFullYear(), 0, 1)
  const week = Math.ceil(((dt - jan1) / 86400000 + jan1.getDay() + 1) / 7)
  return `W${week}`
}

function StatsPage({ userId }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { computeStats() }, [])

  async function computeStats() {
    const today = getToday()

    // Single batched query for all data
    const [checkinsRes, missedRes, goalsRes] = await Promise.all([
      supabase.from('checkins').select('id, date, mood').eq('user_id', userId)
        .gte('date', dateOffset(today, -365)).order('date'),
      supabase.from('missed_days').select('*').eq('user_id', userId)
        .order('date', { ascending: false }),
      supabase.from('goals').select('id, title').eq('user_id', userId).eq('active', true),
    ])

    const checkins = checkinsRes.data || []
    const missed = missedRes.data || []
    const goals = goalsRes.data || []
    let allGoalProgress = []
    if (checkins.length > 0) {
      const checkinIds = checkins.map(c => c.id)
      const { data: gpRows } = await supabase.from('goal_progress')
        .select('checkin_id, goal_id, completed, proof_url, proof_image_path')
        .in('checkin_id', checkinIds)
      allGoalProgress = gpRows || []
    }

    const dailyQuality = buildDailyGoalQuality(checkins, allGoalProgress)
    const qualifiedDates = getQualifiedDateSet(dailyQuality)
    const qualifiedDays = qualifiedDates.size
    const avgGoalCompletion = getAverageCompletionPct(dailyQuality)

    // Rest days
    const restDays = JSON.parse(localStorage.getItem(`rest_days_${userId}`) || '[]')

    // Streaks (rest-day aware)
    let currentStreak = 0
    if (qualifiedDates.has(today)) currentStreak = 1
    let d = dateOffset(today, -1)
    while (true) {
      const dow = new Date(d).getDay()
      if (restDays.includes(dow)) { d = dateOffset(d, -1); continue }
      if (!qualifiedDates.has(d)) break
      currentStreak++
      d = dateOffset(d, -1)
    }

    let longestStreak = 0, tempStreak = 0
    for (let i = 364; i >= 0; i--) {
      const date = dateOffset(today, -i)
      const dow = new Date(date).getDay()
      if (restDays.includes(dow)) continue
      if (qualifiedDates.has(date)) {
        tempStreak++
        if (tempStreak > longestStreak) longestStreak = tempStreak
      } else {
        tempStreak = 0
      }
    }

    // Consistency (exclude rest days)
    const firstDate = checkins.length > 0 ? checkins[0].date : null
    let activeDays = 0
    if (firstDate) {
      const [fy, fm, fd] = firstDate.split('-').map(Number)
      const first = new Date(fy, fm - 1, fd)
      const [ty, tm, td] = today.split('-').map(Number)
      const todayDt = new Date(ty, tm - 1, td)
      const totalDays = Math.floor((todayDt - first) / 86400000) + 1
      for (let i = 0; i < totalDays; i++) {
        const dt = new Date(first)
        dt.setDate(dt.getDate() + i)
        if (!restDays.includes(dt.getDay())) activeDays++
      }
    }

    const consistency = activeDays > 0
      ? Math.round((checkins.length / activeDays) * 100)
      : 0

    // Weekly mood
    const moodByWeek = {}
    for (const c of checkins) {
      if (c.mood > 0) {
        const week = getWeekLabel(c.date)
        if (!moodByWeek[week]) moodByWeek[week] = []
        moodByWeek[week].push(c.mood)
      }
    }
    const weeklyMood = Object.keys(moodByWeek).slice(-12).map(week => {
      const moods = moodByWeek[week]
      return { week, avg: moods.reduce((a, b) => a + b, 0) / moods.length, count: moods.length }
    })

    // Goal progress over time (last 30 days)
    let goalStats = []
    if (goals.length > 0) {
      const last30Checkins = checkins.filter(c => c.date >= dateOffset(today, -30))
      if (last30Checkins.length > 0) {
        const recentCheckinIds = new Set(last30Checkins.map(c => c.id))
        goalStats = goals.map(g => {
          const entries = allGoalProgress.filter(p => recentCheckinIds.has(p.checkin_id) && p.goal_id === g.id)
          const completed = entries.filter(e => e.completed && hasGoalProof(e)).length
          return {
            id: g.id,
            title: g.title,
            completed,
            total: last30Checkins.length,
            pct: last30Checkins.length > 0 ? Math.round((completed / last30Checkins.length) * 100) : 0,
          }
        })
      } else {
        goalStats = goals.map(g => ({ id: g.id, title: g.title, completed: 0, total: 0, pct: 0 }))
      }
    }

    // Missed entries
    const missedEntries = missed.map(m => ({
      date: m.date,
      excuse: m.excuse,
      verdict: m.verdict || 'pending',
      voteCount: m.vote_total > 0 ? { accepts: m.vote_accepts, rejects: m.vote_rejects } : null,
    }))

    setStats({
      currentStreak,
      longestStreak,
      qualifiedDays,
      avgGoalCompletion,
      totalLogged: checkins.length,
      activeDays,
      consistency: Math.min(consistency, 100),
      weeklyMood,
      goalStats,
      missedEntries,
    })
    setLoading(false)
  }

  if (loading || !stats) {
    return (
      <div className="app">
        <section className="card">
          <p className="vote-status">Loading stats...</p>
        </section>
      </div>
    )
  }

  const maxMood = 5
  const streakThresholdPct = Math.round(STREAK_MIN_COMPLETION_RATIO * 100)

  return (
    <div className="app">
      <section className="card">
        <h2>Performance Report</h2>
        <div className="stats-grid">
          <div className="stat-block">
            <span className="stat-value">{stats.currentStreak}</span>
            <span className="stat-label">Current Streak</span>
          </div>
          <div className="stat-block">
            <span className="stat-value">{stats.longestStreak}</span>
            <span className="stat-label">Longest Streak</span>
          </div>
          <div className="stat-block">
            <span className={`stat-value ${stats.avgGoalCompletion < 50 ? 'stat-bad' : stats.avgGoalCompletion >= 80 ? 'stat-good' : ''}`}>
              {stats.avgGoalCompletion}%
            </span>
            <span className="stat-label">Avg Goal Completion</span>
          </div>
          <div className="stat-block">
            <span className="stat-value">{stats.qualifiedDays}</span>
            <span className="stat-label">Qualified Days</span>
          </div>
          <div className="stat-block">
            <span className={`stat-value ${stats.consistency < 50 ? 'stat-bad' : stats.consistency >= 80 ? 'stat-good' : ''}`}>
              {stats.consistency}%
            </span>
            <span className="stat-label">Check-in Consistency</span>
          </div>
          <div className="stat-block">
            <span className="stat-value">{stats.totalLogged}</span>
            <span className="stat-label">Days Logged</span>
          </div>
        </div>
        <div className="stat-sub">
          {stats.totalLogged} days logged / {stats.activeDays} active days (rest days excluded)
          <br />
          {stats.qualifiedDays} days met streak quality ({streakThresholdPct}%+ completed with proof)
        </div>
      </section>

      {stats.goalStats.length > 0 && (
        <section className="card card-accent-green">
          <h2>Goal Progress (Last 30 Days)</h2>
          <div className="goal-stats-list">
            {stats.goalStats.map(g => (
              <div key={g.id} className="goal-stat-row">
                <div className="goal-stat-info">
                  <span className="goal-stat-name">{g.title}</span>
                  <span className="goal-stat-detail">{g.completed}/{g.total} days completed</span>
                </div>
                <div className="goal-stat-bar-track">
                  <div
                    className={`goal-stat-bar-fill ${g.pct >= 70 ? 'bar-high' : g.pct >= 40 ? 'bar-mid' : 'bar-low'}`}
                    style={{ width: `${g.pct}%` }}
                  />
                </div>
                <span className="goal-stat-pct">{g.pct}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card card-accent-purple">
        <h2>Weekly Mood Average</h2>
        {stats.weeklyMood.length === 0 ? (
          <p className="empty-state">No mood data yet. Start logging your mood to see trends here.</p>
        ) : (
          <div className="mood-chart">
            {stats.weeklyMood.map(({ week, avg, count }) => (
              <div key={week} className="mood-bar-col">
                <div className="mood-bar-track">
                  <div
                    className={`mood-bar-fill ${avg <= 2 ? 'bar-low' : avg >= 4 ? 'bar-high' : 'bar-mid'}`}
                    style={{ height: `${(avg / maxMood) * 100}%` }}
                  />
                </div>
                <span className="mood-bar-val">{avg.toFixed(1)}</span>
                <span className="mood-bar-label">{week}</span>
                <span className="mood-bar-count">{count}d</span>
              </div>
            ))}
          </div>
        )}
        <div className="mood-chart-legend">
          {MOOD_LABELS.map((label, i) => (
            <span key={i}>{i + 1}={label}</span>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Missed Days ({stats.missedEntries.length})</h2>
        {stats.missedEntries.length === 0 ? (
          <p className="empty-state">No missed days. Clean record — keep it up.</p>
        ) : (
          <div className="missed-list">
            {stats.missedEntries.map(entry => (
              <div key={entry.date} className="missed-row">
                <div className="missed-row-header">
                  <span className="missed-row-date">{formatDate(entry.date)}</span>
                  <span className={`history-badge ${
                    entry.verdict === 'rejected' ? 'badge-missed' :
                    entry.verdict === 'accepted' ? 'badge-done' :
                    'badge-pending'
                  }`}>
                    {entry.verdict === 'rejected' ? 'Rejected' :
                     entry.verdict === 'accepted' ? 'Accepted' :
                     'Pending'}
                  </span>
                </div>
                <p className="missed-row-excuse">{entry.excuse}</p>
                {entry.voteCount && (
                  <p className="missed-row-votes">
                    {entry.voteCount.accepts} accept / {entry.voteCount.rejects} reject
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default StatsPage
