#!/usr/bin/env node
// set_day_count.mjs — ワーカーの当日処理カウンタを調整する
//
// 上限を引き下げた日は、それ以前に旧上限で消費した分が新上限を超えてしまい、
// その日は一切処理されなくなる（2026-08-10: 旧400で227件消費 → 新上限100で全スキップ）。
// 上限変更の初日など、意図しない停止を解くために使う。
//
// ワーカーは state をメモリに持ち saveState() で上書きするため、
// 必ず停止した状態で実行すること（pm2 stop → 本スクリプト → pm2 start）。
//
// 使い方:
//   node scripts/llm_extract/set_day_count.mjs        # 現在値を表示
//   node scripts/llm_extract/set_day_count.mjs 40     # 当日カウンタを40にする
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const FILE = join(homedir(), '.akinavi_shadow_state.json')
if (!existsSync(FILE)) { console.error(`状態ファイルがありません: ${FILE}`); process.exit(1) }
const state = JSON.parse(readFileSync(FILE, 'utf8'))

const arg = process.argv[2]
if (arg === undefined) {
  console.log(`day=${state.day} dayCount=${state.dayCount} dayCost=$${(state.dayCost ?? 0).toFixed(2)}`)
  process.exit(0)
}
const n = Number(arg)
if (!Number.isInteger(n) || n < 0) { console.error('0以上の整数を渡してください'); process.exit(1) }

const before = state.dayCount
state.dayCount = n
writeFileSync(FILE, JSON.stringify(state))
console.log(`dayCount: ${before} → ${state.dayCount}（day=${state.day}）`)
