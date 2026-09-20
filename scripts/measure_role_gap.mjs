#!/usr/bin/env node
/**
 * 役割一覧に無い職種が、実データにどれだけ居るかを測る。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * CLAUDE.md の鉄則「分類は実データで分かれる分だけ。消す/足す前に影響人数を測る」に従う。
 * 足す条件は3つとも満たすこと:
 *   ① 人数がいる（数人のために分類を増やさない）
 *   ② 今の23役割で拾えていない（既存役割の言い換えなら足さない）
 *   ③ 実データで分かれる（希望単価・スキル構成が他と違う）
 *
 * きっかけ（2026-09-21 ユーザー指摘）:
 *   「【ONメンバー】【ディレクション、要件定義、ワイヤーフレーム作成、進行管理、
 *     バナー制作、顧客折衝】【52万円】」の Tomomi.A に役割が1つも付いていなかった。
 *   スキルは Excel / PowerPoint / Word / Slack / GoogleAnalytics / EC-CUBE で、
 *   プログラミング言語が1つも無い。今の役割一覧はエンジニア職しか想定していない。
 *
 *   node scripts/measure_role_gap.mjs
 */
import { loadRows, featurize } from './role_classifier/dataset.mjs'

/** 候補となる職種と、その言い回し。裸の一般語は使わない（案件文にも出るため） */
const CANDIDATES = [
  { label: 'ディレクター', re: /(?:Web|WEB|ウェブ|制作|コンテンツ)?[　 ]?ディレクション|ディレクター(?!ズ)|進行[　 ]?管理/ },
  { label: 'デザイナー', re: /(?:UI|UX|UIUX|Web|グラフィック|バナー|DTP)[　 ]?デザイ(?:ナー|ン)|デザイナー/ },
  { label: 'ライター', re: /(?:Web|SEO|コピー)?[　 ]?ライティング|ライター(?!ズ)|編集者/ },
  { label: 'マーケター', re: /(?:Web|デジタル)?[　 ]?マーケ(?:ター|ティング担当)|広告[　 ]?運用/ },
  { label: '営業', re: /(?:法人|新規|IT)[　 ]?営業|セールス(?!フォース|Force)/ },
  { label: '事務・バックオフィス', re: /バックオフィス|一般[　 ]?事務|営業[　 ]?事務|総務|経理担当/ },
  { label: 'カスタマーサポート', re: /カスタマー[　 ]?(?:サポート|サクセス)|CS担当/ },
]

/** 「55～60万」→ 57.5。全角数字にも対応（実データにある） */
function parseRate(s) {
  const t = String(s ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  const nums = [...t.matchAll(/(\d{2,3})\s*万/g)].map((m) => Number(m[1])).filter((n) => n >= 20 && n <= 300)
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}
const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const rows = loadRows()
const allRates = rows.map((r) => parseRate(r.desired_rate)).filter((v) => v != null)
console.log(`控えの人数: ${rows.length} / 希望単価が取れた人: ${allRates.length}（全体の中央値 ${median(allRates)}万）\n`)

// 「進行管理」等はエンジニアも普通に書く。語だけで数えると当たりすぎる
// （初回の計測で ディレクター437人・単価70万 と出て、役割持ちと1円も違わなかった）。
// **言語スキルが1本も無い人**＝本当に非エンジニア職、に絞って測り直す。
const nonEngineer = rows.filter((r) => featurize(r).cat_languages === 0)
console.log(`言語スキル0本の人: ${nonEngineer.length}人（全体の ${(nonEngineer.length / rows.length * 100).toFixed(1)}%）\n`)

console.log('■ 役割一覧に無い職種の候補（言語スキル0本の人だけで数える）')
console.log('  該当  うち役割ゼロ  単価中央値  ツール中央値  職種')
for (const c of CANDIDATES) {
  const hit = nonEngineer.filter((r) => c.re.test(`${r.rp_subject ?? ''}\n${r.rp_text ?? ''}`))
  if (!hit.length) continue
  const noRole = hit.filter((r) => !(Array.isArray(r.rp_roles) && r.rp_roles.length)).length
  const rates = hit.map((r) => parseRate(r.desired_rate)).filter((v) => v != null)
  const tools = hit.map((r) => featurize(r).cat_tools)
  console.log(`  ${String(hit.length).padStart(4)}  ${String(noRole).padStart(10)}  ` +
    `${String(median(rates) ?? '-').padStart(8)}万  ${String(median(tools) ?? '-').padStart(10)}  ${c.label}`)
}

// 非エンジニアで、どの候補職種にも当たらなかった人
const unmatched = nonEngineer.filter((r) =>
  !CANDIDATES.some((c) => c.re.test(`${r.rp_subject ?? ''}\n${r.rp_text ?? ''}`)))
console.log(`\n  どの候補にも当たらない非エンジニア: ${unmatched.length}人`)

// 比較対象: 今の役割が付いている人の平均像
const withRole = rows.filter((r) => Array.isArray(r.rp_roles) && r.rp_roles.length)
const wrRates = withRole.map((r) => parseRate(r.desired_rate)).filter((v) => v != null)
const wrFeats = withRole.map(featurize)
console.log(`\n  ${String(withRole.length).padStart(4)}  ${'-'.padStart(10)}  ` +
  `${String(median(wrRates) ?? '-').padStart(8)}万  ` +
  `${String((wrFeats.filter((f) => f.cat_languages === 0).length / withRole.length * 100).toFixed(0)).padStart(10)}%  ` +
  `${String(median(wrFeats.map((f) => f.cat_tools)) ?? '-').padStart(10)}  （比較）今の役割が付いている人`)

// 役割が1つも付いていない人が何人いるか（取りこぼしの総量）
const noRoleAll = rows.filter((r) => !(Array.isArray(r.rp_roles) && r.rp_roles.length))
console.log(`\n■ 役割が1つも付いていない人: ${noRoleAll.length}人（${(noRoleAll.length / rows.length * 100).toFixed(1)}%）`)
const noRoleNoLang = noRoleAll.filter((r) => featurize(r).cat_languages === 0).length
console.log(`   うち言語スキル0本（非エンジニア職の疑い）: ${noRoleNoLang}人`)
console.log(`\n■ 役割ゼロの人の件名（10件）`)
for (const r of noRoleAll.slice(0, 10)) console.log(`   ${String(r.rp_subject ?? '').slice(0, 74)}`)
