const del_cost = 2
const skip_cost = 2
const sub_cost = 3
const streak_bias = 3

const case_setting: 0 | 1 | 2 = 1 as any // 0 means exact match, 1 means smart and 2 insensitive

export const referenceLevvy = (
  c: Map<string, number>,
  q: string,
  q_i: number,
  h: string,
  h_i: number,
  padding: number,
  consecutive_match = false
): number => {
  const hash = `(${q_i}):(${h_i}):(${consecutive_match})`
  if (c.has(hash)) {
    return (
      c.get(hash) ??
      (() => {
        throw 'nei'
      })()
    )
  }

  const h_len = h.length - h_i
  const q_len = q.length - q_i

  // we can cheat in the recursion by looking at the original length of the strings
  const bias = Math.max(Math.min(q.length, h.length) - 1, 0) * streak_bias

  if (h_len === 0) {
    const dist = q_len * del_cost + padding * skip_cost + bias
    const result = dist as any
    c.set(hash, result)
    return result
  }

  if (q_len === 0) {
    const dist = (h_len + padding) * skip_cost + bias
    const result = dist as any
    c.set(hash, result)
    return result
  }

  const a = q.charCodeAt(q_i)
  const b = h.charCodeAt(h_i)

  let adjustedA = a
  let adjustedB = b

  if (case_setting === 2) {
    if (65 <= a && a <= 90) adjustedA = a + 32
    if (65 <= b && b <= 90) adjustedB = b + 32
  } else if (case_setting === 1 && 97 <= a && a <= 122) {
    if (65 <= b && b <= 90) adjustedB = b + 32
  }

  const is_match = adjustedA === adjustedB
  if (is_match) {
    let skip = referenceLevvy(c, q, q_i, h, h_i + 1, padding) + skip_cost
    let del = referenceLevvy(c, q, q_i + 1, h, h_i, padding, consecutive_match) + del_cost
    let match =
      referenceLevvy(c, q, q_i + 1, h, h_i + 1, padding, true) -
      (consecutive_match ? streak_bias : 0)

    let result = Math.min(match, skip, del)
    c.set(hash, result)
    return result
  }

  let skip = referenceLevvy(c, q, q_i, h, h_i + 1, padding) + skip_cost
  let del = referenceLevvy(c, q, q_i + 1, h, h_i, padding, consecutive_match) + del_cost
  let sub = referenceLevvy(c, q, q_i + 1, h, h_i + 1, padding) + sub_cost

  const result = Math.min(del, skip, sub)
  c.set(hash, result)
  return result
}

/*
 * precondition: dp needs to be at least (q.length + 1) * (h.length + 1) * 2 long
 */
export const iterativeLevvy = (q: string, h: string, padding: number, dp: number[]): number[] => {
  const q_len = q.length
  const h_len = h.length

  // const Q = q_len + 1;
  const H = h_len + 1
  const B = 2
  const BH = B * H

  const bias = Math.max(Math.min(q_len, h_len) - 1, 0) * streak_bias

  // Base cases
  for (let q_i = 0; q_i <= q_len; q_i++) {
    const dist = (q_len - q_i) * del_cost + padding * skip_cost + bias
    dp[q_i * BH + h_len * B + 0] = dist
    dp[q_i * BH + h_len * B + 1] = dist
  }
  for (let h_i = 0; h_i <= h_len; h_i++) {
    const dist = (h_len - h_i + padding) * skip_cost + bias
    dp[q_len * BH + h_i * B + 0] = dist
    dp[q_len * BH + h_i * B + 1] = dist
  }

  // Fill dp table
  for (let q_i = q_len - 1; q_i >= 0; q_i--) {
    for (let h_i = h_len - 1; h_i >= 0; h_i--) {
      const a = q.charCodeAt(q_i)
      const b = h.charCodeAt(h_i)

      let adjustedA = a
      let adjustedB = b

      if (case_setting === 2) {
        if (65 <= a && a <= 90) adjustedA = a + 32
        if (65 <= b && b <= 90) adjustedB = b + 32
      } else if (case_setting === 1 && 97 <= a && a <= 122) {
        if (65 <= b && b <= 90) adjustedB = b + 32
      }

      const is_match = adjustedA === adjustedB

      // Deletion
      let del_cost_total = del_cost + dp[(q_i + 1) * BH + h_i * B + 0] // after deletion, cm == 0

      // Skipping
      let skip_cost_total = skip_cost + dp[q_i * BH + (h_i + 1) * B + 0] // after skip, cm == 0

      let match_cost
      if (is_match) {
        // Matching
        match_cost = dp[(q_i + 1) * BH + (h_i + 1) * B + 1]
      } else {
        // Subbing
        match_cost = sub_cost + dp[(q_i + 1) * BH + (h_i + 1) * B + 0] // after sub, cm == 0
      }

      dp[q_i * BH + h_i * B + 0] = Math.min(del_cost_total, skip_cost_total, match_cost)

      // Deletion
      let del_cost_cm1 = del_cost + dp[(q_i + 1) * BH + h_i * B + 1] // keep a potential streak going

      // Skipping
      let skip_cost_cm1 = skip_cost + dp[q_i * BH + (h_i + 1) * B + 0] // after skip, cm resets to 0

      let match_cost_cm1
      if (is_match) {
        // Matching
        match_cost_cm1 = dp[(q_i + 1) * BH + (h_i + 1) * B + 1] - streak_bias
      } else {
        // Subbing
        match_cost_cm1 = sub_cost + dp[(q_i + 1) * BH + (h_i + 1) * B + 0]
      }

      dp[q_i * BH + h_i * B + 1] = Math.min(del_cost_cm1, skip_cost_cm1, match_cost_cm1)
    }
  }

  return dp
}

/*
 * precondition: dp_current and dp_previous need to be at least (h.length + 1) * 2 long
 */
export const iterativeLevvy_fast = (
  q: string,
  h: string,
  padding: number,
  dp_current: number[],
  dp_previous: number[]
): number => {
  const q_len = q.length
  const h_len = h.length

  // const H = h_len + 1;
  const B = 2 // consecutive_match flag can be 0 or 1
  // const HB = H * B;

  const padding_cost = padding * skip_cost
  const bias = Math.min(q_len, h_len) * streak_bias

  // Base case initialization for q_i = q_len
  for (let h_i = 0; h_i <= h_len; h_i++) {
    const dist = (h_len - h_i) * skip_cost + padding_cost + bias
    dp_previous[h_i * B + 0] = dist
    dp_previous[h_i * B + 1] = dist
  }

  // Main DP loop
  for (let q_i = q_len - 1; q_i >= 0; q_i--) {
    // Initialize dp_current for h_i = h_len
    const dist = (q_len - q_i) * del_cost + padding_cost + bias
    dp_current[h_len * B + 0] = dist
    dp_current[h_len * B + 1] = dist

    for (let h_i = h_len - 1; h_i >= 0; h_i--) {
      const a = q.charCodeAt(q_i)
      const b = h.charCodeAt(h_i)

      let adjustedA = a
      let adjustedB = b

      if (case_setting === 2) {
        if (65 <= a && a <= 90) adjustedA = a + 32
        if (65 <= b && b <= 90) adjustedB = b + 32
      } else if (case_setting === 1 && 97 <= a && a <= 122) {
        if (65 <= b && b <= 90) adjustedB = b + 32
      }

      const is_match = adjustedA === adjustedB

      // Access dp values from dp_previous and dp_current arrays
      const index_current = h_i * B
      const index_next = (h_i + 1) * B

      // Deletion (cm == 0)
      const del_cost_total = del_cost + dp_previous[index_current + 0] // cm remains the same after deletion

      // Skipping (cm == 0)
      const skip_cost_total = skip_cost + dp_current[index_next + 0] // cm resets to 0 after skipping

      let match_cost
      if (is_match) {
        // Matching (cm == 1)
        match_cost = dp_previous[index_next + 1]
      } else {
        // Substitution (cm == 0)
        match_cost = sub_cost + dp_previous[index_next + 0]
      }

      dp_current[index_current + 0] = Math.min(del_cost_total, skip_cost_total, match_cost)

      // Deletion (cm == 1)
      const del_cost_cm1 = del_cost + dp_previous[index_current + 1] // cm remains 1 after deletion

      // Skipping (cm == 1 -> cm resets to 0)
      const skip_cost_cm1 = skip_cost + dp_current[index_next + 0]

      let match_cost_cm1
      if (is_match) {
        // Matching with streak bias
        match_cost_cm1 = dp_previous[index_next + 1] - streak_bias
      } else {
        // Substitution resets cm to 0
        match_cost_cm1 = sub_cost + dp_previous[index_next + 0]
      }

      dp_current[index_current + 1] = Math.min(del_cost_cm1, skip_cost_cm1, match_cost_cm1)
    }

    // Swap dp_current and dp_previous for next iteration
    ;[dp_current, dp_previous] = [dp_previous, dp_current]
  }

  return dp_previous[0] - (bias > 0 ? streak_bias : 0)
}

/**
 * Convenience wrapper around {@link iterativeLevvy_fast} that manages the
 * rolling DP buffers. Lower scores indicate better matches.
 *
 * For ranking many candidates against one query, prefer {@link LevvyScorer},
 * which reuses its buffers across calls instead of allocating per score.
 */
export const scoreLevvy = (q: string, h: string, padding = 0): number => {
  const width = (h.length + 1) * 2
  return iterativeLevvy_fast(q, h, padding, new Array(width), new Array(width))
}

/**
 * Reusable scorer that grows its DP buffers as needed and reuses them across
 * calls. Intended for scoring a large candidate list against a single query in
 * a tight loop (e.g. a fuzzy file finder).
 */
export class LevvyScorer {
  private current: number[] = []
  private previous: number[] = []

  score(q: string, h: string, padding = 0): number {
    const width = (h.length + 1) * 2
    if (this.current.length < width) {
      this.current = new Array(width)
      this.previous = new Array(width)
    }
    return iterativeLevvy_fast(q, h, padding, this.current, this.previous)
  }
}
