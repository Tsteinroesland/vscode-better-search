// 0 means exact match, 1 means smart (case-insensitive unless the query has an
// uppercase letter) and 2 means always case-insensitive. Mirrors the setting in
// levvy.ts so both scorers behave consistently.
const case_setting: 0 | 1 | 2 = 1 as 0 | 1 | 2

// Size of the character n-grams used to build the term-frequency vectors. n=2
// (bigrams) is a good default for short strings like file paths: it captures
// local character order without being as sparse as longer grams.
const NGRAM = 2

/**
 * Decides whether matching should be case-insensitive for a given query. Under
 * smart case (1) we only fold case when the query is all lowercase, so typing an
 * uppercase letter lets the user demand an exact-case match.
 */
const foldCase = (q: string): boolean => {
  if (case_setting === 2) return true
  if (case_setting === 0) return false
  // smart case: insensitive unless the query contains an uppercase letter
  for (let i = 0; i < q.length; i++) {
    const code = q.charCodeAt(i)
    if (65 <= code && code <= 90) return false
  }
  return true
}

/**
 * Builds a sparse term-frequency vector of character n-grams for `s`, keyed by
 * the n-gram string. The string is padded with leading/trailing sentinels so
 * that prefixes and suffixes get their own distinctive grams.
 */
const ngramCounts = (s: string, fold: boolean): Map<string, number> => {
  const text = fold ? s.toLowerCase() : s
  // Sentinel-pad so boundary characters contribute distinct grams.
  const padded = `\u0001${text}\u0002`
  const counts = new Map<string, number>()
  if (padded.length < NGRAM) {
    counts.set(padded, 1)
    return counts
  }
  for (let i = 0; i + NGRAM <= padded.length; i++) {
    const gram = padded.slice(i, i + NGRAM)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Euclidean norm of a term-frequency vector. */
const norm = (counts: Map<string, number>): number => {
  let sum = 0
  for (const v of counts.values()) sum += v * v
  return Math.sqrt(sum)
}

/**
 * Cosine similarity between two character-n-gram vectors, in `[0, 1]`. 1 means
 * the n-gram profiles are identical; 0 means they share no n-grams.
 */
export const cosineSimilarity = (q: string, h: string): number => {
  const fold = foldCase(q)
  const qc = ngramCounts(q, fold)
  const hc = ngramCounts(h, fold)

  const qn = norm(qc)
  const hn = norm(hc)
  if (qn === 0 || hn === 0) return 0

  // Iterate the smaller map for the dot product.
  const [small, large] = qc.size <= hc.size ? [qc, hc] : [hc, qc]
  let dot = 0
  for (const [gram, count] of small) {
    const other = large.get(gram)
    if (other !== undefined) dot += count * other
  }

  return dot / (qn * hn)
}

/**
 * Convenience scorer returning a *distance* (lower = better match), so it is a
 * drop-in replacement for {@link scoreLevvy}. `padding` is accepted for API
 * compatibility but unused: cosine similarity is already length-normalized.
 */
export const scoreCosine = (q: string, h: string, _padding = 0): number => {
  return 1 - cosineSimilarity(q, h)
}

/**
 * Reusable cosine scorer that caches the query's n-gram vector across calls.
 * Intended for ranking a large candidate list against a single query in a tight
 * loop (e.g. a fuzzy file finder). Lower scores indicate better matches, so it
 * is interchangeable with {@link LevvyScorer}.
 */
export class CosineScorer {
  private cachedQuery: string | undefined
  private cachedFold = false
  private cachedCounts: Map<string, number> = new Map()
  private cachedNorm = 0

  private prepareQuery(q: string): void {
    const fold = foldCase(q)
    if (this.cachedQuery === q && this.cachedFold === fold) return
    this.cachedQuery = q
    this.cachedFold = fold
    this.cachedCounts = ngramCounts(q, fold)
    this.cachedNorm = norm(this.cachedCounts)
  }

  score(q: string, h: string, _padding = 0): number {
    this.prepareQuery(q)
    const qn = this.cachedNorm
    if (qn === 0) return 1

    const hc = ngramCounts(h, this.cachedFold)
    const hn = norm(hc)
    if (hn === 0) return 1

    const [small, large] =
      this.cachedCounts.size <= hc.size
        ? [this.cachedCounts, hc]
        : [hc, this.cachedCounts]
    let dot = 0
    for (const [gram, count] of small) {
      const other = large.get(gram)
      if (other !== undefined) dot += count * other
    }

    return 1 - dot / (qn * hn)
  }
}
