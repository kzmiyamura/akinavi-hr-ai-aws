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
//   node scripts/llm_extract/sb-query.mjs "candidates?data_env=eq.prod&select=id" --count --anon
//
// オプション:
//   --raw    整形せず生 JSON を出力（既定は読みやすく要約表示）
//   --count  HEAD + Prefer: count=exact で件数だけ取る（本体を転送しないので egress ほぼゼロ）
//   --anon   service key ではなく anon キーで叩く（.env.local の VITE_SUPABASE_ANON_KEY）。
//            画面と同じ権限・同じ statement_timeout で再現したいとき用
//
// 恒久許可の例（.claude/settings.json）:
//   "Bash(node scripts/llm_extract/sb-query.mjs *)"

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_PATH = join(homedir(), '.akinavi_shadow.env')

function loadEnv(path, { optional = false } = {}) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    // --anon は .env.local だけで成立するので、shadow env が無いマシンでも動かす
    if (optional) return {}
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
const countOnly = args.includes('--count')
const useAnon = args.includes('--anon')
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

// --anon のときは shadow env（service key 置き場）が無くても .env.local だけで成立させる
const env = loadEnv(ENV_PATH, { optional: useAnon })
let url = env.SUPABASE_URL
let key = env.SUPABASE_SERVICE_KEY

if (useAnon) {
  // 画面（ブラウザ）と同じロールで再現するため anon キーを使う。
  // anon は statement_timeout が短く（15秒・2026-08-13 に 3→15 へ変更）、
  // service_role では出ない失敗が出ることがある
  const local = loadEnv(join(process.cwd(), '.env.local'))
  if (!local.VITE_SUPABASE_ANON_KEY) {
    console.error('.env.local に VITE_SUPABASE_ANON_KEY がありません（プロジェクト直下で実行すること）')
    process.exit(1)
  }
  key = local.VITE_SUPABASE_ANON_KEY
  url = url || local.VITE_SUPABASE_URL
  if (!url) {
    console.error(`SUPABASE_URL が ${ENV_PATH} にも .env.local（VITE_SUPABASE_URL）にもありません`)
    process.exit(1)
  }
} else if (!url || !key) {
  console.error(`SUPABASE_URL / SUPABASE_SERVICE_KEY が ${ENV_PATH} にありません`)
  process.exit(1)
}

const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${query.replace(/^\//, '')}`

const headers = { apikey: key, Authorization: `Bearer ${key}` }
if (countOnly) headers.Prefer = 'count=exact'

const started = Date.now()
const res = await fetch(endpoint, {
  method: countOnly ? 'HEAD' : 'GET',
  headers,
})
const elapsedMs = Date.now() - started

if (countOnly) {
  // HEAD なので本文は無い。件数は Content-Range ヘッダに入る（例: `*/1881`）
  console.log(`role: ${useAnon ? 'anon' : 'service_role'}`)
  console.log(`HTTP ${res.status} ${res.statusText}  (${elapsedMs}ms)`)
  console.log(`content-range: ${res.headers.get('content-range')}`)
  const bodyHint = res.headers.get('x-envoy-upstream-service-time')
  if (bodyHint) console.log(`upstream-time: ${bodyHint}ms`)
  // HEAD の直後に process.exit すると Windows の node が libuv のアサートで落ちるため
  // exitCode を立てて自然終了させる
  process.exitCode = res.ok ? 0 : 1
}

// --count は HEAD なので本文が無い。ここから先の本文処理をすると
// res.json() が「Unexpected end of JSON input」で落ちるため丸ごと飛ばす
if (!countOnly) {
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
