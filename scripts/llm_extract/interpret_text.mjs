#!/usr/bin/env node
// 案件本文を「ファイルから」読んで AI 解釈をドライランする。DBを一切触らない。
//
// 使い方:
//   node scripts/llm_extract/interpret_text.mjs <本文ファイル>
//
// なぜ要るか（2026-09-02）:
//   interpret_projects.mjs は DB の案件しか流せないため、
//   「この求人票をうちのAIはどう読むか」を試せなかった。
//   prompts.mjs の requiredRole 判定を直したときの検証はここで行う。
//   本番と同じ extractProjectInterpretation を呼ぶので、出力はそのまま本番の挙動。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractProjectInterpretation } from './run.mjs'

// caller.mjs が env を要ることがあるので、あれば読む（無くても続行する）
try {
  for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '')
  }
} catch { /* env が無くてもAI解釈だけなら動く */ }

const file = process.argv[2]
if (!file) {
  console.error('使い方: node scripts/llm_extract/interpret_text.mjs <本文ファイル>')
  process.exit(1)
}
const body = readFileSync(file, 'utf8')
console.log(`本文 ${body.length} 字を解釈します…\n`)

const r = await extractProjectInterpretation(body)
console.log(`  求める役割: ${r.requiredRole ?? '(判定なし)'}`)
console.log(`  そう読んだ理由: ${r.roleReason ?? '—'}`)
console.log(`  所見: ${r.summary ?? '—'}`)
console.log(`  確信度: ${r.confidence}`)
if (r.specialist?.ecosystem) console.log(`  専門圏: ${r.specialist.ecosystem}（${r.specialist.reason ?? ''}）`)
if (r.relatedSkills.length) {
  console.log(`  関連スキル: ${r.relatedSkills.map((s) => s.name).filter(Boolean).join('、')}`)
}
console.log(`  複数名案件: ${r.multiPerson ? 'はい' : 'いいえ'}`)
