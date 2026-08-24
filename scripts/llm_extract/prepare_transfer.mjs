#!/usr/bin/env node
// 会社PCへ渡す設定ファイルを、送信しやすい形でデスクトップに取り出す。
//
// 対象:
//   ~/.akinavi_shadow.env         → akinavi_shadow_env.txt
//   ~/.akinavi_shadow_state.json  → akinavi_shadow_state.txt
//
// ドット始まりのファイルはエクスプローラーから扱いにくく、拡張子 .env / .json は
// チャットツールで添付を弾かれることがあるため .txt に変えて出す。
// 受け取り側（新PCのClaude）は SETUP_company_pc.md の手順で正しい名前に戻す。
//
// 使い方:
//   node scripts/llm_extract/prepare_transfer.mjs
//
// ⚠ 出力先には DB 全権限のキーが平文で置かれる。送信したら削除すること
//   （このスクリプトが最後に削除コマンドを案内する）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const OUT_DIR = path.join(HOME, 'Desktop', 'akinavi_setup_send')

const TARGETS = [
  { src: '.akinavi_shadow.env', dst: 'akinavi_shadow_env.txt', required: true,
    label: '接続設定（必須・事前に送る）' },
  { src: '.akinavi_shadow_state.json', dst: 'akinavi_shadow_state.txt', required: false,
    label: '処理状態（カットオーバー直前に送り直す）' },
]

fs.mkdirSync(OUT_DIR, { recursive: true })

let missing = 0
for (const t of TARGETS) {
  const src = path.join(HOME, t.src)
  const dst = path.join(OUT_DIR, t.dst)
  if (!fs.existsSync(src)) {
    console.log(`✗ 見つかりません: ${src}   (${t.label})`)
    if (t.required) missing++
    continue
  }
  fs.copyFileSync(src, dst)
  const size = fs.statSync(dst).size
  const lines = fs.readFileSync(dst, 'utf8').split('\n').filter(l => l.trim()).length
  console.log(`✓ ${t.dst}  (${size} バイト / ${lines} 行)   ${t.label}`)
}

console.log(`\n出力先: ${OUT_DIR}`)

if (missing) {
  console.log(`\n⚠ 必須ファイルが ${missing} 件見つかりません。移設元PCで実行しているか確認してください。`)
  process.exit(1)
}

console.log(`
次にやること:
  1. 上のフォルダを開く（エクスプローラーのアドレス欄に貼り付け）
  2. 中の .txt を LINE WORKS を使うPCへ移す（USB / 社内共有 / OneDrive など）
  3. LINE WORKS で会社PCの担当者へ送る
  4. 送り終わったら、このフォルダを削除する:

     Remove-Item -Recurse -Force "${OUT_DIR}"

⚠ このフォルダにはデータベースの全権限を持つキーが平文で入っています。
   送信後は必ず削除してください。`)
