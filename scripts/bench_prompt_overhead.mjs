#!/usr/bin/env node
// bench_prompt_overhead.mjs — claude -p の固定オーバーヘッドを測る
//
// claude -p はカレントディレクトリのプロジェクト設定（CLAUDE.md 等）を読み込む。
// ワーカーはプロジェクト直下で動いていたため、抽出のたびに背景を送っていた。
// **抽出プロンプトは自己完結しているので、この分は丸ごと無駄。**
//
// 使い方: node scripts/bench_prompt_overhead.mjs
//   同じ極小プロンプトを「プロジェクト内」と「空ディレクトリ」で1回ずつ実行して比べる。
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const PROMPT = 'Reply with just: ok'
const empty = path.join(os.tmpdir(), 'akinavi-llm-cwd')
fs.mkdirSync(empty, { recursive: true })

function run(cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', 'claude-haiku-4-5', '--output-format', 'json'],
      { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(new Error(out.slice(0, 200))) } })
    p.stdin.on('error', () => {})
    p.stdin.write(PROMPT); p.stdin.end()
  })
}

const rows = []
for (const [label, cwd] of [['プロジェクト内', process.cwd()], ['空ディレクトリ', empty]]) {
  const r = await run(cwd)
  const u = r.usage ?? {}
  rows.push({ label, 書き込み: u.cache_creation_input_tokens, 読み込み: u.cache_read_input_tokens, 入力: u.input_tokens })
}
console.table(rows)
const diff = (rows[0].書き込み ?? 0) - (rows[1].書き込み ?? 0)
console.log(`\n差分: ${diff.toLocaleString()} トークン/回（プロジェクト設定の読み込み分）`)
console.log(`ワーカーは 1日100件が上限なので、最大で 1日あたり約 ${(diff * 100).toLocaleString()} トークン`)
