#!/usr/bin/env node
/**
 * list_issues.mjs — GitHub Issues をローカルから取得・クローズするスクリプト
 *
 * 使い方:
 *   node scripts/list_issues.mjs              # open な Issue 一覧
 *   node scripts/list_issues.mjs --all        # open + closed 含む全件
 *   node scripts/list_issues.mjs --close 42   # Issue #42 をクローズ
 *   node scripts/list_issues.mjs --reopen 42  # Issue #42 を再オープン
 *
 * 環境変数（.env.local から自動読み込み）:
 *   VITE_SUPABASE_URL  — Supabase プロジェクト URL
 *   VITE_SUPABASE_ANON_KEY — Supabase anon key
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// --- .env.local から環境変数を読み込む ---
function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}

loadEnv()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL = `${SUPABASE_URL}/functions/v1/create-github-issue`

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  console.error('       .env.local を確認してください')
  process.exit(1)
}

// --- CLI 引数パース ---
const args = process.argv.slice(2)
const showAll = args.includes('--all')
const closeIdx = args.indexOf('--close')
const reopenIdx = args.indexOf('--reopen')

// --- PATCH: クローズ / 再オープン ---
async function patchIssue(number, state) {
  const res = await fetch(EDGE_URL, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ number, state }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`PATCH失敗: ${res.status} ${err}`)
    process.exit(1)
  }
  const data = await res.json()
  const stateLabel = state === 'closed' ? 'クローズ' : '再オープン'
  console.log(`✅ Issue #${number} を${stateLabel}しました: ${data.html_url ?? ''}`)
}

// --- GET: Issue 一覧 ---
async function listIssues() {
  const res = await fetch(EDGE_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`GET失敗: ${res.status} ${err}`)
    process.exit(1)
  }
  const issues = await res.json()

  const filtered = showAll ? issues : issues.filter(i => i.state === 'open')

  if (filtered.length === 0) {
    console.log(showAll ? '（Issue なし）' : '✅ open な Issue はありません')
    return
  }

  const openCount = issues.filter(i => i.state === 'open').length
  const closedCount = issues.filter(i => i.state === 'closed').length
  console.log(`\n=== GitHub Issues (open: ${openCount} / closed: ${closedCount}) ===\n`)

  for (const issue of filtered) {
    const stateIcon = issue.state === 'open' ? '🟢' : '⚫'
    const date = issue.created_at ? issue.created_at.slice(0, 10) : ''
    console.log(`${stateIcon} #${issue.number}  [${date}]  ${issue.title}`)
    if (issue.html_url) console.log(`        ${issue.html_url}`)
    console.log()
  }

  if (!showAll && openCount > 0) {
    console.log(`ヒント: --all で closed も表示 / --close <番号> でクローズ`)
  }
}

// --- main ---
if (closeIdx !== -1) {
  const num = parseInt(args[closeIdx + 1], 10)
  if (!num) { console.error('--close <Issue番号> を指定してください'); process.exit(1) }
  await patchIssue(num, 'closed')
} else if (reopenIdx !== -1) {
  const num = parseInt(args[reopenIdx + 1], 10)
  if (!num) { console.error('--reopen <Issue番号> を指定してください'); process.exit(1) }
  await patchIssue(num, 'open')
} else {
  await listIssues()
}
