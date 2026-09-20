#!/usr/bin/env node
/**
 * 案件表（raw_profile.projects）だけをローカル控えに追加取得する。
 *
 * なぜ専用スクリプトなのか:
 *   archive_local.mjs に projects を足しても、**既に控えた行は更新されない**
 *   （watermark で「続きから」しか引かないため）。全件を引き直すと約23MB かかる。
 *   projects と付随する数項目だけに絞れば **実測 541kB**（1人あたり184バイト）で済む。
 *   CLAUDE.md「raw_profile を丸ごと select しない」に従い、要る JSON パスだけ指定する。
 *
 * 案件表は経歴の見抜きに一番効く材料（案件間の空白＝待機/離職、1案件の在籍期間、
 * 役割の推移）だが、**持っているのは AI校正を通った人だけ**。
 * 2026-09-19 実測で 3,005人中309人（10.3%）しかいない。
 *
 * ⚠ PostgREST は 1000行で黙って切る。offset でページングすること。
 *
 *   node scripts/archive_projects.mjs [--dry-run] [--dir D:\akinavi-archive]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const DRY = args.includes('--dry-run')
const DIR = argOf('--dir', 'D:\\akinavi-archive')

// ── env（sb-query.mjs と同じ置き場から読む。source は使わない） ──────────
const ENV_PATH = join(homedir(), '.akinavi_shadow.env')
let SUPABASE_URL = '', KEY = ''
try {
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/)
    if (!m) continue
    const v = m[2].trim().replace(/^["']|["']$/g, '')
    if (m[1] === 'SUPABASE_URL') SUPABASE_URL = v
    if (m[1] === 'SUPABASE_SERVICE_KEY' || m[1] === 'SUPABASE_SERVICE_ROLE_KEY') KEY = v
  }
} catch (e) {
  console.error(`env を読めません: ${ENV_PATH}\n${e.message}`)
  process.exit(1)
}
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が env にありません'); process.exit(1) }

const PAGE = 500
const SELECT = [
  'id',
  'rp_projects:raw_profile->projects',
  'rp_llmCheckedAt:raw_profile->>_llm_checked_at',
  'rp_llmApplied:raw_profile->_llm_applied',
].join(',')

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// 件数だけ先に数える（本体を受け取らない）
const head = await fetch(
  `${SUPABASE_URL}/rest/v1/candidates?select=id&data_env=eq.prod&merged_into=is.null`,
  { method: 'HEAD', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact' } })
const total = Number((head.headers.get('content-range') ?? '/0').split('/')[1] ?? 0)
console.log(`対象: prod の人材 ${total}人`)
if (DRY) { console.log('（--dry-run: ここで止めます。本体は転送していません）'); process.exit(0) }

const out = []
let bytes = 0
for (let from = 0; from < total; from += PAGE) {
  const q = `candidates?select=${encodeURIComponent(SELECT)}` +
    `&data_env=eq.prod&merged_into=is.null&order=created_at.asc&limit=${PAGE}&offset=${from}`
  const rows = await rest(q)
  if (!rows.length) break
  bytes += JSON.stringify(rows).length
  for (const r of rows) {
    // 案件表が無い人（AI未処理）は行を作らない。控えを無駄に膨らませない
    if (!Array.isArray(r.rp_projects) || !r.rp_projects.length) continue
    out.push(r)
  }
  process.stdout.write(`\r取得 ${Math.min(from + PAGE, total)}/${total}  案件表あり ${out.length}人  ${(bytes / 1024).toFixed(0)}KB`)
  if (rows.length < PAGE) break
}
console.log()

const dbDir = join(DIR, 'db')
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })
const dest = join(dbDir, 'projects.jsonl')
writeFileSync(dest, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log(`\n案件表を持つ人: ${out.length}人（${(out.length / total * 100).toFixed(1)}%）`)
console.log(`転送量: ${(bytes / 1024).toFixed(0)}KB`)
console.log(`保存先: ${dest}`)
