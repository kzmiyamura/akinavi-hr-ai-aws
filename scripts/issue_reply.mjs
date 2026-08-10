#!/usr/bin/env node
// issue_reply.mjs — GitHub Issue へのコメント投稿・クローズ（外出時の自律運用用）
//
// 承認ダイアログ回避のためのスクリプト（node -e を書かない。CLAUDE.md 方針）。
// 恒久許可: "Bash(node scripts/issue_reply.mjs *)"
//
// 使い方:
//   node scripts/issue_reply.mjs <番号> --comment "本文"            # コメントのみ
//   node scripts/issue_reply.mjs <番号> --comment "本文" --close    # コメント + クローズ
//   node scripts/issue_reply.mjs <番号> --close                     # クローズのみ
//   node scripts/issue_reply.mjs <番号> --comment-file <path> --close  # 長文はファイルから
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(ROOT, '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
}
const EDGE = `${process.env.VITE_SUPABASE_URL}/functions/v1/create-github-issue`
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!KEY) { console.error('VITE_SUPABASE_ANON_KEY 未設定（.env.local を確認）'); process.exit(1) }

const args = process.argv.slice(2)
const number = Number(args[0])
if (!number) { console.error('使い方: node scripts/issue_reply.mjs <番号> [--comment "本文" | --comment-file <path>] [--close]'); process.exit(1) }
const ci = args.indexOf('--comment')
const cfi = args.indexOf('--comment-file')
const comment = ci >= 0 ? args[ci + 1] : cfi >= 0 ? readFileSync(args[cfi + 1], 'utf-8') : undefined
const close = args.includes('--close')
if (!comment && !close) { console.error('--comment / --comment-file / --close のいずれかが必要'); process.exit(1) }

const res = await fetch(EDGE, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ number, comment, state: close ? 'closed' : 'open' }),
})
if (!res.ok) { console.error(`失敗: ${res.status} ${await res.text()}`); process.exit(1) }
console.log(`✅ #${number}`, comment ? 'コメント投稿' : '', close ? '→ クローズ' : '（openのまま）', JSON.stringify(await res.json()))
