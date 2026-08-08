#!/usr/bin/env node
// Supabase REST の読み取り専用クエリ。
//
// `source ~/.akinavi_shadow.env && node -e "..."` を置き換えるためのもの。
// source と node -e はどちらも allowlist に登録できず毎回承認が要るので、
// env の読み込みをこのスクリプト内で行い、実ファイルとして呼べるようにしている。
//
// 使い方:
//   node scripts/llm_extract/sb-query.mjs "candidates?id=eq.<uuid>&select=name,raw_profile"
//   node scripts/llm_extract/sb-query.mjs "candidates?select=id,name&limit=5" --raw
//
// オプション:
//   --raw   整形せず生 JSON を出力（既定は読みやすく要約表示）
//
// 恒久許可の例（.claude/settings.json）:
//   "Bash(node scripts/llm_extract/sb-query.mjs *)"

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_PATH = join(homedir(), '.akinavi_shadow.env')

function loadEnv(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    console.error(`env ファイルを読めません: ${path}\n${e.message}`)
    process.exit(1)
  }
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    // 前後のクォートを剥がす
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

const args = process.argv.slice(2)
const raw = args.includes('--raw')
const query = args.find((a) => !a.startsWith('--'))

if (!query) {
  console.error('使い方: node scripts/llm_extract/sb-query.mjs "<table>?<params>" [--raw]')
  process.exit(1)
}

// 書き込み系を弾く。このスクリプトは読み取り専用に固定する。
if (/^\s*(insert|update|delete|upsert)\b/i.test(query) || query.includes('..rpc/')) {
  console.error('このスクリプトは読み取り専用です。書き込みは行えません。')
  process.exit(1)
}

const env = loadEnv(ENV_PATH)
const url = env.SUPABASE_URL
const key = env.SUPABASE_SERVICE_KEY

if (!url || !key) {
  console.error(`SUPABASE_URL / SUPABASE_SERVICE_KEY が ${ENV_PATH} にありません`)
  process.exit(1)
}

const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${query.replace(/^\//, '')}`

const res = await fetch(endpoint, {
  method: 'GET',
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`)
  console.error(await res.text())
  process.exit(1)
}

const data = await res.json()

if (raw) {
  console.log(JSON.stringify(data, null, 2))
  process.exit(0)
}

// 既定表示: 配列なら 1 件ずつ、長い文字列と配列は要約する
const rows = Array.isArray(data) ? data : [data]
console.log(`${rows.length} 件`)
for (const [i, row] of rows.entries()) {
  console.log(`--- [${i}] ---`)
  for (const [k, v] of Object.entries(row ?? {})) {
    console.log(`${k}: ${summarize(v)}`)
  }
}

function summarize(v, depth = 0) {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') {
    const oneLine = v.replace(/\s+/g, ' ')
    return oneLine.length > 120 ? `${oneLine.slice(0, 120)}… (${v.length}字)` : oneLine
  }
  if (Array.isArray(v)) {
    if (depth > 0) return `[${v.length}件]`
    return `[${v.length}件] ${v.slice(0, 3).map((x) => summarize(x, depth + 1)).join(', ')}${v.length > 3 ? ' …' : ''}`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (depth > 0) return `{${keys.length}キー}`
    return `{ ${keys.map((k) => `${k}: ${summarize(v[k], depth + 1)}`).join(', ')} }`
  }
  return String(v)
}
