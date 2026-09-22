#!/usr/bin/env node
/**
 * AI校正の「行列の長さ」を件数だけで測る（2026-09-22）。
 *
 * きっかけ:
 *   ワーカーのログが「ペース配分により待機」で埋まっている＝日次上限に張り付いている。
 *   その状態では、能力を1件ぶん取り戻すことがそのまま「1人多く校正できる」に直結する。
 *   どれだけ行列が伸びているかを知らないと、取り戻した枠の価値が判断できない。
 *
 * 測るもの（ワーカーの実際の取得条件と同じ絞り込みを使う）:
 *   ・今まさに処理待ちの人数（直近 LOOKBACK_DAYS 日・印が無い・スキル絞込あり）
 *   ・絞込を外した場合の人数（絞込がどれだけ効いているか）
 *   ・期限切れ（LOOKBACK_DAYS を過ぎて二度と拾われない）人数
 *
 * **本体は1行も転送しない。** すべて HEAD + Prefer: count=exact（egress ほぼゼロ）。
 *
 * 実行: node scripts/llm_extract/queue_depth.mjs [--days 3]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSkillFilterValue, buildSkillFilterClause } from './shadow_worker_lib.mjs'

const ENV_PATH = join(homedir(), '.akinavi_shadow.env')

function loadEnv(path) {
  const out = {}
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) {
    console.error(`env ファイルを読めません: ${path}\n${e.message}`); process.exit(1)
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const env = loadEnv(ENV_PATH)
const BASE = (env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1/'
// このマシンの env は SUPABASE_SERVICE_KEY という名前。他スクリプトと綴りが違うので両方見る
const KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
if (!BASE.startsWith('http') || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が env にありません'); process.exit(1)
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

/** 本体を受け取らずに件数だけ取る */
async function count(query) {
  const res = await fetch(BASE + query, {
    method: 'HEAD',
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  })
  const cr = res.headers.get('content-range') || ''
  const n = Number(cr.split('/')[1])
  return Number.isFinite(n) ? n : null
}

/** 1行だけ読む（設定値の取得用） */
async function one(query) {
  const res = await fetch(BASE + query, { headers: H })
  const rows = await res.json()
  return Array.isArray(rows) ? rows[0] : null
}

const daysArg = process.argv.indexOf('--days')
const DAYS = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 3

const cfg = await one('app_config?key=eq.llm_filter_skills&select=value')
const skills = parseSkillFilterValue(cfg?.value)
const clause = buildSkillFilterClause(skills)

const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const base = `candidates?select=id&data_env=eq.prod&merged_into=is.null`
const unchecked = `&raw_profile->>_llm_checked_at=is.null`
const inWindow = `&created_at=gte.${encodeURIComponent(since)}`
const expired = `&created_at=lt.${encodeURIComponent(since)}`

const [queued, queuedNoFilter, inWin, expiredUnchecked, expiredWithResume] = await Promise.all([
  count(base + unchecked + inWindow + clause),
  count(base + unchecked + inWindow),
  count(base + inWindow),
  count(base + unchecked + expired + clause),
  count(base + unchecked + expired + clause + '&resume_url=not.is.null'),
])

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')

console.log(`AI校正の行列（直近${DAYS}日・data_env=prod）`)
console.log(`  優先スキル絞込 : ${skills?.length ? skills.join(', ') : '（なし＝全件対象）'}`)
console.log('')
console.log(`  直近${DAYS}日の登録              : ${inWin}`)
console.log(`  うち未校正（絞込なし）        : ${queuedNoFilter}  (${pct(queuedNoFilter, inWin)})`)
console.log(`  うち未校正（絞込あり＝行列）  : ${queued}`)
console.log('')
console.log(`  期限切れ（${DAYS}日を過ぎて二度と拾われない）: ${expiredUnchecked}`)
console.log(`    うち経歴書を持っている人                : ${expiredWithResume}`)
