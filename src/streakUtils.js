export const STREAK_MIN_COMPLETION_RATIO = 0.5

export function hasGoalProof(progress) {
  if (!progress) return false
  const proofUrl = typeof progress.proof_url === 'string'
    ? progress.proof_url.trim()
    : typeof progress.proofUrl === 'string'
      ? progress.proofUrl.trim()
      : ''
  const proofImagePath = progress.proof_image_path || progress.proofImagePath
  return Boolean(proofUrl || proofImagePath)
}

export function getVerificationStatus(progress) {
  return progress?.verification_status ?? progress?.verificationStatus ?? null
}

export function isGoalVerified(progress) {
  return getVerificationStatus(progress) === 'verified'
}

export function isGoalFailedVerification(progress) {
  return getVerificationStatus(progress) === 'failed'
}

export function buildDailyGoalQuality(
  checkins,
  goalProgressRows,
  minCompletionRatio = STREAK_MIN_COMPLETION_RATIO,
  options = {},
) {
  const { requireVerified = false, excludeFailedProofs = true } = options
  const goalProgressByCheckin = {}
  for (const row of (goalProgressRows || [])) {
    if (!row.checkin_id) continue
    if (!goalProgressByCheckin[row.checkin_id]) goalProgressByCheckin[row.checkin_id] = []
    goalProgressByCheckin[row.checkin_id].push(row)
  }

  const dailyQuality = {}
  for (const checkin of (checkins || [])) {
    const rows = goalProgressByCheckin[checkin.id] || []
    const totalGoals = rows.length
    const completedWithProof = rows.filter(row => {
      if (!row.completed || !hasGoalProof(row)) return false
      if (excludeFailedProofs && isGoalFailedVerification(row)) return false
      if (requireVerified && !isGoalVerified(row)) return false
      return true
    }).length
    const hasCompletedWithoutProof = rows.some(row => row.completed && !hasGoalProof(row))
    const hasFailedProof = excludeFailedProofs && rows.some(row => row.completed && isGoalFailedVerification(row))
    const hasCompletedNotVerified = requireVerified
      && rows.some(row => row.completed && hasGoalProof(row) && !isGoalVerified(row))
    const completionRatio = totalGoals > 0 ? completedWithProof / totalGoals : 0

    dailyQuality[checkin.date] = {
      date: checkin.date,
      checkinId: checkin.id,
      totalGoals,
      completedWithProof,
      completionRatio,
      hasCompletedWithoutProof,
      hasFailedProof,
      hasCompletedNotVerified,
      qualifies: totalGoals > 0
        && !hasCompletedWithoutProof
        && !hasFailedProof
        && !hasCompletedNotVerified
        && completionRatio >= minCompletionRatio,
    }
  }

  return dailyQuality
}

export function getQualifiedDateSet(dailyQuality) {
  return new Set(
    Object.values(dailyQuality || {})
      .filter(day => day.qualifies)
      .map(day => day.date),
  )
}

export function getAverageCompletionPct(dailyQuality, fromDate = null) {
  const days = Object.values(dailyQuality || {})
    .filter(day => !fromDate || day.date >= fromDate)
  if (days.length === 0) return 0
  const avgRatio = days.reduce((sum, day) => sum + day.completionRatio, 0) / days.length
  return Math.round(avgRatio * 100)
}
