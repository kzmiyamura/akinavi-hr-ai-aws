#!/usr/bin/env node
// ワーカーの状態ファイル ~/.akinavi_shadow_state.json を初期化する。
//
// 用途: 別PCへの移設時、旧PCの状態ファイルが取得できない場合のみ使う。
// 取得できるなら旧PCの現物をコピーすること（そちらが正解）。watermark を引き継がないと
// 未処理分の取りこぼし、または処理済み分の再処理（＝Max枠の無駄使い）が起きる。
//
// 使い方:
//   node scripts/llm_extract/init_state.mjs            # 確認のみ（書き込まない）
//   node scripts/llm_extract/init_state.mjs --write    # 「今」で初期化して書き込む
//   node scripts/llm_extract/init_state.mjs --write --watermark 2026-08-10T01:31:15Z
//
// 注意: 「今」で初期化すると、それ以前に登録された未処理の人材は AI 補正されないまま
// 7日で archive される。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_FILE = path.join(os.homedir(), '.akinavi_shadow_state.json')

const args = process.argv.slice(2)
const write = args.includes('--write')
const wmIdx = args.indexOf('--watermark')
const watermark = wmIdx >= 0 ? args[wmIdx + 1] : new Date().toISOString()

if (wmIdx >= 0 && !watermark) {
  console.error('--watermark の値がありません')
  process.exit(1)
}
if (Number.isNaN(Date.parse(watermark))) {
  console.error(`watermark が日時として解釈できません: ${watermark}`)
  process.exit(1)
}

const existing = fs.existsSync(STATE_FILE)
if (existing) {
  console.log(`既存の状態ファイル: ${STATE_FILE}`)
  console.log(fs.readFileSync(STATE_FILE, 'utf8').trim())
} else {
  console.log(`状態ファイルはまだありません: ${STATE_FILE}`)
}

// day を今日の日付で埋めると、その日の残り枠が 0 からではなく満額で始まる。
// 移設当日に旧PCぶんと合わせて上限を二重に使わないよう、day は空にして
// ワーカーの日付切り替えロジックに任せる（起動時に今日ぶんとして 0 から数え直す）。
const next = {
  watermark,
  day: '',
  dayCount: 0,
  dayCost: 0,
  projWatermark: watermark,
  recDayCount: 0,
}

console.log('\n書き込む内容:')
console.log(JSON.stringify(next))

if (!write) {
  console.log('\n（--write を付けると実際に書き込みます）')
  if (existing) console.log('⚠ 既存ファイルを上書きします。旧PCからコピーできるならそちらを優先してください。')
  process.exit(0)
}

if (existing) {
  const backup = `${STATE_FILE}.bak`
  fs.copyFileSync(STATE_FILE, backup)
  console.log(`\n既存ファイルを退避: ${backup}`)
}

fs.writeFileSync(STATE_FILE, JSON.stringify(next))
console.log(`書き込みました: ${STATE_FILE}`)
console.log('\n⚠ この watermark より前に登録された未処理の人材は AI 補正されません。')
