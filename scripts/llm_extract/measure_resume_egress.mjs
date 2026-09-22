#!/usr/bin/env node
/**
 * AI校正を広げたときに Storage egress がいくら増えるかを実測する（2026-09-22）。
 *
 * きっかけ:
 *   LOOKBACK を3日→7日に広げた。対象が増えるぶん経歴書のダウンロードも増える。
 *   「平均315KB」という既存の数字はあるが、**それが今のデータにも当てはまるかを
 *   確かめずに見積もりを出していた**ので、実ファイルに当たって測り直す。
 *
 * 測りかた（egress をほぼ使わない）:
 *   ・対象の resume_url は DB から URL だけを引く（本文・raw_profile は引かない）
 *   ・サイズは **HEAD リクエストの Content-Length** で取る。本体は1バイトも受け取らない
 *   ・同じ URL は1回しか数えない（ファイル名に内容ハッシュが入るので重複＝同一ファイル）
 *
 * 実行:
 *   node scripts/llm_extract/measure_resume_egress.mjs            # 直近7日・未校正
 *   node scripts/llm_extract/measure_resume_egress.mjs --days 3
 *   node scripts/llm_extract/measure_resume_egress.mjs --sample 0 # 全件HEAD（時間はかかる）
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
const KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
if (!BASE.startsWith('http') || !KEY) { console.error('env が足りません'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const argOf = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : def
}
const DAYS = argOf('days', 7)
const SAMPLE = argOf('sample', 60)

const cfg = await fetch(BASE + 'app_config?key=eq.llm_filter_skills&select=value', { headers: H }).then(r => r.json())
const skills = parseSkillFilterValue(cfg?.[0]?.value)
const clause = buildSkillFilterClause(skills)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()

// URL だけを引く。PostgREST は1000行で黙って切るのでページングする
const urls = []
for (let offset = 0; ; offset += 1000) {
  const q = `candidates?select=resume_url&data_env=eq.prod&merged_into=is.null` +
    `&raw_profile->>_llm_checked_at=is.null&resume_url=not.is.null` +
    `&created_at=gte.${encodeURIComponent(since)}${clause}` +
    `&order=created_at.desc&limit=1000&offset=${offset}`
  const rows = await fetch(BASE + q, { headers: H }).then(r => r.json())
  if (!Array.isArray(rows) || rows.length === 0) break
  for (const r of rows) if (r.resume_url) urls.push(r.resume_url)
  if (rows.length < 1000) break
}

const uniq = [...new Set(urls)]

/** 本体を受け取らずにサイズだけ取る */
async function sizeOf(u) {
  try {
    const res = await fetch(u, { method: 'HEAD' })
    if (!res.ok) return null
    const n = Number(res.headers.get('content-length'))
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

const targets = SAMPLE > 0 && uniq.length > SAMPLE
  // 先頭に偏らないよう等間隔で抜く（新しい順に並んでいるため）
  ? uniq.filter((_, i) => i % Math.ceil(uniq.length / SAMPLE) === 0).slice(0, SAMPLE)
  : uniq

const sizes = []
for (let i = 0; i < targets.length; i += 8) {
  const got = await Promise.all(targets.slice(i, i + 8).map(sizeOf))
  for (const s of got) if (s != null) sizes.push(s)
}

sizes.sort((a, b) => a - b)
const sum = sizes.reduce((a, b) => a + b, 0)
const mean = sizes.length ? sum / sizes.length : 0
const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`
const kb = (b) => `${Math.round(b / 1024)}KB`

console.log(`未校正で経歴書を持つ人（直近${DAYS}日・優先スキル絞込あり）`)
console.log(`  対象の人数            : ${urls.length}`)
console.log(`  実ファイル数（重複除く）: ${uniq.length}   ← 同じURL＝同じ中身なので1回DLすれば足りる`)
console.log(`  重複ぶん              : ${urls.length - uniq.length}`)
console.log('')
console.log(`サイズ実測（HEAD ${sizes.length}件・本体は受け取っていない）`)
console.log(`  平均 ${kb(mean)} / 中央 ${kb(med)} / 最小 ${kb(sizes[0] ?? 0)} / 最大 ${kb(sizes.at(-1) ?? 0)}`)
console.log('')
console.log(`この山を全部解析したときの Storage egress 見込み`)
console.log(`  重複を除いて1回ずつDL : ${mb(uniq.length * mean)}`)
console.log(`  重複も毎回DLした場合  : ${mb(urls.length * mean)}`)
