#!/usr/bin/env node
/**
 * `agent_companies` の会社名を今の検閲に通し直して、壊れている行を全部出す。
 * **本番は引かない**（ローカル控え `masters/agent_companies.jsonl` を読む）。
 *
 *   node scripts/audit_agent_companies.mjs
 *   node scripts/audit_agent_companies.mjs --json <出力>   # 修復スクリプトへの入力
 *
 * ## なぜ要るか
 *
 * 会社名の抽出経路は5つあり、検閲はブロックリストなので**必ず漏れる**。
 * 実際、同じ病気を3回やっている（2026-08-29 に72人 / 09-12 に「株式会社営業部」/
 * 10-03 に「ご担当者」「即戦力AIコンサル/PM」「要員配信」）。
 * 1件ずつ画面で見つけるのをやめ、**全件を一度に通し直す**のがこのスクリプト。
 *
 * ## 壊れていると何が起きるか
 *
 * `agent_companies` は送信元ドメインが主キーで、`license_status` が
 * `haken`/`both` の会社だけが `fetch_candidates_for_project` の `p_require_haken`
 * を通る。社名が壊れると厚労省で引けず `notfound` になり、
 * **その会社の人材が派遣案件から丸ごと消える**。
 *
 * ## 直し方の優先順位（出力の `fix` 列）
 *
 *   1. `by_number` … 許可番号がある → **番号から正式社名を引く**（厚労省が正）
 *                      `node scripts/mhlw_lookup.mjs --number 派13-xxxxxx`
 *   2. `by_domain` … 同じドメインの人材に妥当な from_company がある → それを使う
 *   3. `manual`    … どちらも無い。人が見る
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 検閲を **本番に出す index.ts から切り出して**使う。
 * 手写しのレプリカを作ると必ずソースと乖離し、「監査は通るが本番は壊れている」
 * （またはその逆）になる。`src/lib/__tests__/companyNameGate.test.ts` と同じ方式。
 */
function loadGate() {
  const src = readFileSync(resolve(HERE, '../supabase/functions/inbound-email/index.ts'), 'utf8')
  const pick = (name) => {
    const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[gimsuy]*)\\r?\\n`))
    if (!m) throw new Error(`${name} を index.ts から取り出せません`)
    return m[1]
  }
  const body = src.match(/function isPlausibleCompanyName\(name: string\): boolean \{([\s\S]*?)\n\}/)
  if (!body) throw new Error('isPlausibleCompanyName を index.ts から取り出せません')
  const names = [
    'COMPANY_NG_SENTENCE', 'COMPANY_NG_HEADCOUNT', 'COMPANY_NG_PERSON', 'COMPANY_NG_DATE',
    'COMPANY_NG_SALUTATION', 'COMPANY_NG_PITCH', 'COMPANY_NG_ROLE_ONLY', 'COMPANY_NG_GENERIC',
    'COMPANY_NG_RANDOM', 'COMPANY_HAS_CORP', 'COMPANY_CORP_STRIP',
    'COMPANY_NG_DEPT_ONLY', 'COMPANY_NG_NO_IDENT',
  ]
  const code = names.map((n) => `const ${n} = ${pick(n)};`).join('\n')
    + `\nreturn function (name) {${body[1].replace(/: string/g, '')}\n}`
  const isPlausible = new Function(code)()

  /** どの規則で弾かれたかを、index.ts の定数をそのまま使って判定する */
  const reasons = names.map((n) => [n, new Function(`return ${pick(n)}`)()])
  const by = Object.fromEntries(reasons)
  return (name) => {
    const s = String(name ?? '').trim()
    if (isPlausible(s)) return null
    if (s.length < 2 || s.length > 40) return 'length'
    if (by.COMPANY_NG_SENTENCE.test(s)) return 'sentence'
    if (by.COMPANY_NG_HEADCOUNT.test(s)) return 'headcount'
    if (by.COMPANY_NG_PERSON.test(s)) return 'person'
    if (by.COMPANY_NG_DATE.test(s)) return 'date'
    if (by.COMPANY_NG_RANDOM.test(s)) return 'random'
    if (by.COMPANY_NG_SALUTATION.test(s)) return 'salutation'
    if (!by.COMPANY_HAS_CORP.test(s) && by.COMPANY_NG_PITCH.test(s)) return 'pitch'
    return 'other'
  }
}

const companyNameRejectReason = loadGate()

const ARCHIVE_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))
const argv = process.argv.slice(2)
const JSON_OUT = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null })()

function findFile(...cands) { return cands.find((p) => existsSync(p)) ?? null }

function* jsonl(path) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim()) { try { yield JSON.parse(line) } catch { /* 壊れた行は飛ばす */ } }
  }
}

const acPath = findFile(
  join(ARCHIVE_DIR, 'db', 'masters', 'agent_companies.jsonl'),
  join(ARCHIVE_DIR, 'masters', 'agent_companies.jsonl'),
)
if (!acPath) {
  console.error(`agent_companies の控えが無い。先に: node scripts/archive_masters.mjs`)
  process.exit(1)
}

// ── ドメインごとに、人材側で使われている from_company を集める（代替候補に使う） ──
const byDomain = new Map()
const candDir = findFile(join(ARCHIVE_DIR, 'db', 'candidates'), join(ARCHIVE_DIR, 'candidates'))
if (candDir) {
  const seen = new Set()
  for (const f of readdirSync(candDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const r of jsonl(join(candDir, f))) {
      if (!r.id || seen.has(r.id)) continue
      seen.add(r.id)
      const dom = String(r.rp_from ?? '').split('@')[1]?.toLowerCase().trim()
      if (!dom || !r.from_company) continue
      if (companyNameRejectReason(r.from_company) !== null) continue   // 壊れた名前は候補にしない
      const m = byDomain.get(dom) ?? new Map()
      m.set(r.from_company, (m.get(r.from_company) ?? 0) + 1)
      byDomain.set(dom, m)
    }
  }
}

// ── 監査 ──
const rows = [...jsonl(acPath)]
const broken = []
const byReason = new Map()

for (const r of rows) {
  const name = r.company_name ?? ''
  const reason = !name.trim() ? 'empty' : companyNameRejectReason(name)
  if (!reason) continue

  byReason.set(reason, (byReason.get(reason) ?? 0) + 1)

  // 代替案を探す
  const alt = [...(byDomain.get(r.domain) ?? new Map()).entries()]
    .sort((a, b) => b[1] - a[1])[0]
  const number = r.haken_number || r.shokai_number || null
  const fix = number ? 'by_number' : alt ? 'by_domain' : 'manual'

  broken.push({
    domain: r.domain,
    current: name || '(空)',
    reason,
    license_status: r.license_status,
    number,
    suggestion: number ? `番号 ${number} から引く` : alt ? `${alt[0]}（人材${alt[1]}件で使用）` : '—',
    fix,
  })
}

// ── 出力 ──
console.log(`控え: ${acPath}`)
console.log(`派遣・紹介会社 ${rows.length} 社 → **壊れている ${broken.length} 社**`)
console.log('')

const statusCount = new Map()
for (const r of rows) statusCount.set(r.license_status, (statusCount.get(r.license_status) ?? 0) + 1)
console.log('license_status の内訳（全体）:')
for (const [k, v] of [...statusCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(10)} ${String(v).padStart(4)} 社`)
}
console.log('')

if (broken.length === 0) { console.log('壊れている行は無い。'); process.exit(0) }

console.log('弾かれた理由:')
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(12)} ${String(v).padStart(4)} 社`)
}
console.log('')

const fixCount = new Map()
for (const b of broken) fixCount.set(b.fix, (fixCount.get(b.fix) ?? 0) + 1)
console.log('直し方:')
console.log(`  by_number  ${String(fixCount.get('by_number') ?? 0).padStart(4)} 社  許可番号から正式社名を引ける（厚労省が正）`)
console.log(`  by_domain  ${String(fixCount.get('by_domain') ?? 0).padStart(4)} 社  同ドメインの人材に妥当な社名がある`)
console.log(`  manual     ${String(fixCount.get('manual') ?? 0).padStart(4)} 社  人が見るしかない`)
console.log('')

broken.sort((a, b) => a.fix.localeCompare(b.fix) || a.domain.localeCompare(b.domain))
console.log('| ドメイン | 現在の社名 | 理由 | 免許 | 直し方 | 代替 |')
console.log('|---|---|---|---|---|---|')
for (const b of broken) {
  console.log(`| ${b.domain} | ${b.current} | ${b.reason} | ${b.license_status} | ${b.fix} | ${b.suggestion} |`)
}

if (JSON_OUT) {
  writeFileSync(resolve(JSON_OUT), JSON.stringify(broken, null, 2), 'utf8')
  console.log(`\nJSON: ${resolve(JSON_OUT)}`)
}
