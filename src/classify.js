/**
 * Deterministic track classification (spec §9.2). Same input -> same track,
 * so the level of ceremony a task gets is auditable instead of vibes-based.
 */

/** @type {{signal: string, score: number, words: string[]}[]} */
export const SIGNALS = [
  {
    signal: 'schema_change',
    score: 3,
    words: ['migration', 'migratsiya', 'schema', 'jadval', 'table', 'column', 'ustun', 'ef migrations', 'backfill jadval'],
  },
  {
    signal: 'money_path',
    score: 3,
    words: ['accrual', 'hisoblash', 'to\'lov', 'tolov', 'payment', 'kompensatsiya', 'compensation', 'summa', 'foiz', 'invoice', 'balans', 'balance', 'refund', 'pul'],
  },
  {
    signal: 'auth_surface',
    score: 3,
    words: ['auth', 'permission', 'huquq', 'role', 'rol', 'token', 'idor', 'sso', 'login', 'parol', 'password', 'authorize'],
  },
  {
    signal: 'public_api_change',
    score: 2,
    words: ['api kontrakt', 'breaking', 'endpoint o\'zgar', 'contract', 'public api', 'dto o\'zgar', 'versiya'],
  },
  {
    signal: 'multi_repo',
    score: 2,
    words: ['submodule', 'ikki repo', 'bir necha repo', 'cross-repo', 'monorepo', 'frontend va backend', 'backend va frontend'],
  },
  {
    signal: 'external_integration',
    score: 2,
    words: ['bank', 'edms', 'integratsiya', 'integration', 'webhook', 'broker', 'katm', 'soliq', 'tashqi api', 'third-party'],
  },
  {
    signal: 'data_backfill',
    score: 2,
    words: ['backfill', 'retroaktiv', 'qayta hisob', 'recalculate', 'reprocess', 'o\'tgan kunlar'],
  },
  {
    signal: 'cosmetic',
    score: -2,
    words: ['typo', 'xato harf', 'matn o\'zgar', 'label', 'tarjima', 'translation', 'i18n matn', 'rename', 'config qiymat', 'log qo\'sh', 'formatting'],
  },
];

export const TRACKS = ['trivial', 'standard', 'high_risk'];

/**
 * @param {string} text free-form intent/title
 * @param {{extraSignals?: string[]}} [opts]
 * @returns {{track: string, score: number, signals: string[]}}
 */
export function classify(text, opts = {}) {
  const hay = ` ${String(text ?? '').toLowerCase()} `;
  const hits = [];
  let score = 0;
  for (const s of SIGNALS) {
    if (s.words.some((w) => hay.includes(w.toLowerCase()))) {
      hits.push(s.signal);
      score += s.score;
    }
  }
  for (const extra of opts.extraSignals ?? []) {
    const known = SIGNALS.find((s) => s.signal === extra);
    if (known && !hits.includes(extra)) { hits.push(extra); score += known.score; }
  }
  return { track: trackForScore(score), score, signals: hits };
}

/** @param {number} score */
export function trackForScore(score) {
  if (score <= 0) return 'trivial';
  if (score <= 4) return 'standard';
  return 'high_risk';
}

/**
 * Upgrades are automatic and silent; downgrades need a human decision.
 * @returns {{allowed: boolean, reason: string}}
 */
export function retrackAllowed(from, to, { byUser = false } = {}) {
  const rank = (t) => TRACKS.indexOf(t);
  if (rank(to) > rank(from)) return { allowed: true, reason: 'upgrade is automatic' };
  if (rank(to) === rank(from)) return { allowed: true, reason: 'no change' };
  return byUser
    ? { allowed: true, reason: 'downgrade recorded as a user decision' }
    : { allowed: false, reason: 'downgrading the track needs --by-user (it removes gates)' };
}
