#!/usr/bin/env node
// audit_golden_junk.mjs — ゴールデン期待値に焼き込まれた「スキルでないもの」を洗い出す
//
// excel_golden.json は _verified=未確認 の「抽出結果スナップショット」であり、
// 当時のルールベース抽出のバグがそのまま正解として固定されている。
// これを回帰基準にすると、そのバグは永久に検出されない。
//
// ここでは各スキルキーが「技術名として不自然」な理由を機械的に付ける。
// 判定は保守的（疑わしきは挙げる）。最終的な正否は人が決める前提。
//
// 使い方: node scripts/audit_golden_junk.mjs [--json]
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(readFileSync(join(HERE, 'testData/excel_golden.json'), 'utf8'))

/** 見出し語・工程名・業務語（技術名ではない） */
const LABEL_WORDS = [
  '案件名', '経験年数', '総経験', '業務内容', '作業内容', '工程', '役割', '規模', '人数',
  '要件定義', '基本設計', '詳細設計', '製造', '単体テスト', '結合テスト', '総合テスト',
  '運用保守', '担当', 'フェーズ', '期間', '備考', 'スキル', '職種',
]
/** 文の断片を示す助詞（前後に文字があるもの） */
const PARTICLE = /[^\s]{2,}(は|を|が|への|より|など|における)[^\s]/

const JA = /[ぁ-んァ-ヶ一-龥]/

/** キーが技術名として不自然な理由を返す（空配列なら不審点なし） */
export function junkReasons(key) {
  const k = String(key).trim()
  const r = []
  if (!k) return ['空文字']
  // 記号のみ（―, －, ・ 等）。全角英数（ＳａｌｅｓＦｏｒｃｅ 等）は技術名なので除外しない
  if (!/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９ぁ-んァ-ヶ一-龥]/.test(k)) r.push('記号のみ')
  // 括弧で始まる断片
  if (/^[（(【\[]/.test(k)) r.push('括弧で始まる断片')
  // 見出し語・工程名
  for (const w of LABEL_WORDS) if (k.includes(w)) { r.push(`見出し語(${w})`); break }
  // 文の断片（助詞を含む）
  if (PARTICLE.test(k)) r.push('文の断片(助詞)')
  // バージョン断片のみ（11ｇ, 9i 等）
  if (/^[0-9０-９]{1,2}[a-zA-Zａ-ｚA-Ｚ]{1,2}$/.test(k)) r.push('バージョン断片のみ')
  // 日本語を含み長い（技術名は通常短い）
  if (JA.test(k) && k.length > 12) r.push(`長すぎる(${k.length}字)`)
  // 日本語の説明＋英字技術名の連結（チケット管理Backlog 等）
  if (/^[ぁ-んァ-ヶ一-龥]{3,}[A-Za-z][A-Za-z0-9.]{2,}$/.test(k)) r.push('日本語説明＋技術名の連結')
  return r
}

const rows = []
let totalKeys = 0
for (const [file, data] of Object.entries(golden.files ?? {})) {
  for (const [key, months] of Object.entries(data.skills ?? {})) {
    totalKeys++
    const r = junkReasons(key)
    if (r.length) rows.push({ file, key, months, reasons: r.join(' / ') })
  }
}
rows.sort((a, b) => a.file.localeCompare(b.file) || b.months - a.months)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1))
} else {
  const w = (s, n) => {
    // 全角を2幅として概算し、表を崩さない
    const width = (t) => [...String(t)].reduce((n2, c) => n2 + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)
    const s2 = String(s)
    return s2 + ' '.repeat(Math.max(0, n - width(s2)))
  }
  console.log(`ゴールデン期待値の要確認キー: ${rows.length}件 / 全${totalKeys}キー` +
    `（${golden.files ? Object.keys(golden.files).length : 0}ファイル・生成${golden._generated}・${golden._verified}）\n`)
  console.log(`${w('ファイル', 12)}${w('キー', 36)}${w('月数', 6)}理由`)
  console.log('-'.repeat(100))
  for (const r of rows) console.log(`${w(r.file, 12)}${w(r.key, 36)}${w(r.months, 6)}${r.reasons}`)

  const byFile = new Map()
  for (const r of rows) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1)
  console.log(`\nファイル別: ${[...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}:${n}`).join('  ')}`)

  // ── 抽出ゼロ: 「スキルが1件も取れない」が正解として固定されている ──
  const empty = Object.entries(golden.files ?? {})
    .filter(([, d]) => !Object.keys(d.skills ?? {}).length)
  console.log(`\n=== スキル抽出ゼロのファイル（${empty.length}件）===`)
  console.log('※「取れないのが正解」として固定されている。ルールベースの取りこぼしそのもの')
  console.log(`${w('ファイル', 12)}${w('シート', 22)}総経験`)
  for (const [f, d] of empty) console.log(`${w(f, 12)}${w(d.sheet, 22)}${d.total}ヶ月`)

  // ── 内部矛盾: 個別スキルの月数が総経験を超えている ──
  const over = []
  for (const [file, d] of Object.entries(golden.files ?? {})) {
    if (!Number.isFinite(d.total) || d.total <= 0) continue
    for (const [key, months] of Object.entries(d.skills ?? {})) {
      if (months > d.total) over.push({ file, key, months, total: d.total })
    }
  }
  console.log(`\n=== 内部矛盾: スキル月数 > 総経験月数（${over.length}件）===`)
  console.log('※どちらかが必ず誤り。期待値として成立していない')
  if (over.length) {
    console.log(`${w('ファイル', 12)}${w('キー', 36)}${w('月数', 6)}総経験`)
    for (const o of over.sort((a, b) => b.months - a.months)) {
      console.log(`${w(o.file, 12)}${w(o.key, 36)}${w(o.months, 6)}${o.total}`)
    }
  }
}
