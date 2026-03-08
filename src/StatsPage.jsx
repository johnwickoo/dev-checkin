import { useMemo } from 'react'

const MOOD_LABELS = ['Burnt out', 'Low', 'Okay', 'Focused', 'Locked in']

function dateOffset(dateStr, offset) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + offset)
  return dt.toISOString().split('T')[0]
}

function getToday() {
  return new Date().toISOString().split('T')[0]
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function isActiveEntry(entry) {
  if (!entry) return false
  if (entry.missedReason) return false
  return entry.mood > 0
    || entry.problemsSolved > 0
    || (entry.blocks && Object.values(entry.blocks).some(Boolean))
}

function getWeekLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const jan1 = new Date(dt.getFullYear(), 0, 1)
  const week = Math.ceil(((dt - jan1) / 86400000 + jan1.getDay() + 1) / 7)
  return `W${week}`
}

function computeStats() {
  const today = getToday()
  const allDates = []
  const activeDates = []
  const missedEntries = []
  let totalProblems = 0
  const moodByWeek = {}
  let firstDate = null

  for (let i = 0; i < 365; i++) {
    const date = dateOffset(today, -i)
    const stored = localStorage.getItem(`checkin-${date}`)
    if (!stored) continue
    const entry = JSON.parse(stored)

    if (isActiveEntry(entry) || entry.missedReason) {
      allDates.push(date)
      if (!firstDate) firstDate = date

      if (isActiveEntry(entry)) {
        activeDates.push(date)
        totalProblems += entry.problemsSolved || 0

        if (entry.mood > 0) {
          const week = getWeekLabel(date)
          if (!moodByWeek[week]) moodByWeek[week] = []
          moodByWeek[week].push(entry.mood)
        }
      }

      if (entry.missedReason) {
        missedEntries.push({
          date,
          excuse: entry.missedReason,
          verdict: entry.verdict || 'pending',
          voteCount: entry.voteCount || null,
        })
      }
    }
  }

  // Current streak
  let currentStreak = 0
  const todayStored = localStorage.getItem(`checkin-${today}`)
  if (todayStored && isActiveEntry(JSON.parse(todayStored))) {
    currentStreak = 1
  }
  let d = dateOffset(today, -1)
  while (true) {
    const s = localStorage.getItem(`checkin-${d}`)
    if (!s || !isActiveEntry(JSON.parse(s))) break
    currentStreak++
    d = dateOffset(d, -1)
  }

  // Longest streak
  let longestStreak = 0
  let tempStreak = 0
  for (let i = 364; i >= 0; i--) {
    const date = dateOffset(today, -i)
    const stored = localStorage.getItem(`checkin-${date}`)
    if (stored && isActiveEntry(JSON.parse(stored))) {
      tempStreak++
      if (tempStreak > longestStreak) longestStreak = tempStreak
    } else {
      tempStreak = 0
    }
  }

  // Days since first entry
  let totalDaysSinceFirst = 0
  if (firstDate) {
    const [fy, fm, fd] = firstDate.split('-').map(Number)
    const first = new Date(fy, fm - 1, fd)
    const [ty, tm, td] = today.split('-').map(Number)
    const todayDt = new Date(ty, tm - 1, td)
    totalDaysSinceFirst = Math.floor((todayDt - first) / 86400000) + 1
  }

  // Weekly mood averages (last 12 weeks)
  const weeklyMood = []
  const weeks = Object.keys(moodByWeek).slice(-12)
  for (const week of weeks) {
    const moods = moodByWeek[week]
    const avg = moods.reduce((a, b) => a + b, 0) / moods.length
    weeklyMood.push({ week, avg, count: moods.length })
  }

  return {
    currentStreak,
    longestStreak,
    totalLogged: activeDates.length,
    totalDaysSinceFirst,
    consistency: totalDaysSinceFirst > 0
      ? Math.round((activeDates.length / totalDaysSinceFirst) * 100)
      : 0,
    totalProblems,
    weeklyMood,
    missedEntries,
  }
}

function StatsPage() {
  const stats = useMemo(computeStats, [])
  const maxMood = 5

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
            <span className={`stat-value ${stats.consistency < 50 ? 'stat-bad' : stats.consistency >= 80 ? 'stat-good' : ''}`}>
              {stats.consistency}%
            </span>
            <span className="stat-label">Consistency</span>
          </div>
          <div className="stat-block">
            <span className="stat-value">{stats.totalProblems}</span>
            <span className="stat-label">Problems Solved</span>
          </div>
        </div>
        <div className="stat-sub">
          {stats.totalLogged} days logged / {stats.totalDaysSinceFirst} days since first entry
        </div>
      </section>

      <section className="card">
        <h2>Weekly Mood Average</h2>
        {stats.weeklyMood.length === 0 ? (
          <p className="stats-empty">No mood data yet.</p>
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
          <p className="stats-empty">No missed days. Clean record.</p>
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
