#!/usr/bin/env node
/**
 * 役割「インフラエンジニア」の二値分類器を学習し、claude -p に回す人を選ぶ。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * ロジスティック回帰を素の JS で書いている。理由:
 *   ・特徴量21個・学習1,858人なので、この容量で足りる（大きいモデルは過学習するだけ）
 *   ・依存パッケージを増やさない
 *   ・**係数がそのまま「なぜそう判定したか」になる**。営業に見せる印として使える
 *
 * ⚠ 教師ラベルは弱教師（dataset.mjs の weakLabel）で作っている。
 *   したがって精度の数字は「ラベル関数の合議を再現できるか」であって、真の正解率ではない。
 *   本当の価値は **ラベル関数が棄権した人を判定できるか** にある。
 *   そこは claude -p と突き合わせて測る（--route で対象を出す）。
 *
 *   node scripts/role_classifier/train.mjs [--route 30]
 */
import fs from 'fs'
import { loadRows, featurize, weakLabel, FEATURE_NAMES } from './dataset.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROUTE_N = Number(argOf('--route', '0'))
const OUT = argOf('--out', '')

// ── データ ────────────────────────────────────────────────────────────────
const rows = loadRows()
const labeled = [], unsure = []
for (const r of rows) {
  const w = weakLabel(r)
  const x = FEATURE_NAMES.map((k) => featurize(r)[k])
  if (w.label === 1 || w.label === 0) labeled.push({ id: r.id, name: r.name, x, y: w.label })
  else if (w.reason !== '信号なし') unsure.push({ id: r.id, name: r.name, x, w, row: r })
}
if (labeled.length < 50) { console.error('学習データが足りません'); process.exit(1) }

// 学習/検証に分ける。id の見た目で分けると偏るので、決定的な疑似乱数で混ぜる
let seed = 20260919
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const shuffled = labeled.map((d) => ({ d, k: rnd() })).sort((a, b) => a.k - b.k).map((o) => o.d)
const cut = Math.floor(shuffled.length * 0.8)
const train = shuffled.slice(0, cut), test = shuffled.slice(cut)

// ── 標準化（係数を比較できるようにする） ────────────────────────────────
const D = FEATURE_NAMES.length
const mean = new Array(D).fill(0), std = new Array(D).fill(0)
for (const d of train) for (let j = 0; j < D; j++) mean[j] += d.x[j] / train.length
for (const d of train) for (let j = 0; j < D; j++) std[j] += (d.x[j] - mean[j]) ** 2 / train.length
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j]) || 1
const z = (x) => x.map((v, j) => (v - mean[j]) / std[j])

// ── 学習（勾配降下 + L2） ───────────────────────────────────────────────
const w = new Array(D).fill(0)
let b = 0
const LR = 0.1, L2 = 0.01, EPOCHS = 600
const sigmoid = (t) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))))
const score = (x) => sigmoid(z(x).reduce((a, v, j) => a + v * w[j], b))
for (let e = 0; e < EPOCHS; e++) {
  const gw = new Array(D).fill(0)
  let gb = 0
  for (const d of train) {
    const err = score(d.x) - d.y
    const zx = z(d.x)
    for (let j = 0; j < D; j++) gw[j] += err * zx[j] / train.length
    gb += err / train.length
  }
  for (let j = 0; j < D; j++) w[j] -= LR * (gw[j] + L2 * w[j])
  b -= LR * gb
}

// ── 評価 ─────────────────────────────────────────────────────────────────
function metrics(set, th) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const d of set) {
    const p = score(d.x) >= th ? 1 : 0
    if (p === 1 && d.y === 1) tp++
    else if (p === 1 && d.y === 0) fp++
    else if (p === 0 && d.y === 1) fn++
    else tn++
  }
  const prec = tp + fp ? tp / (tp + fp) : 0
  const rec = tp + fn ? tp / (tp + fn) : 0
  return { tp, fp, fn, tn, prec, rec, f1: prec + rec ? 2 * prec * rec / (prec + rec) : 0 }
}

console.log(`学習 ${train.length}人 / 検証 ${test.length}人（正例 ${labeled.filter((d) => d.y === 1).length} / 負例 ${labeled.filter((d) => d.y === 0).length}）`)
console.log(`判定が割れて claude -p に回す対象: ${unsure.length}人\n`)
console.log('■ 検証セットでのしきい値ごとの成績')
console.log('  しきい値  適合率  再現率    F1   （正と判定 / 実際に正）')
for (const th of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  const m = metrics(test, th)
  console.log(`   ${th.toFixed(2)}     ${(m.prec * 100).toFixed(1)}%  ${(m.rec * 100).toFixed(1)}%  ${(m.f1 * 100).toFixed(1)}%   (${m.tp + m.fp} / ${m.tp + m.fn})`)
}
console.log('\n  ※ この数字は「ラベル関数の合議を再現できるか」であって真の正解率ではない。')
console.log('    本当の検証は、下で選んだ人を claude -p に独立に判定させて突き合わせること。')

console.log('\n■ 何を見て判定しているか（標準化した係数。絶対値の大きい順）')
const byW = FEATURE_NAMES.map((n, j) => ({ n, w: w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
for (const f of byW.slice(0, 10)) {
  console.log(`  ${f.w >= 0 ? '＋' : '−'} ${f.n.padEnd(22)} ${f.w.toFixed(3)}`)
}

// ── 振り分け: 判定が割れた人のうち、分類器も迷っている人を claude -p へ ──
if (ROUTE_N > 0) {
  const scored = unsure.map((u) => ({ ...u, p: score(u.x) }))
    .sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5))
  console.log(`\n■ claude -p に回す ${ROUTE_N}人（分類器の確率が 0.5 に近い順＝いちばん情報量が多い）`)
  for (const s of scored.slice(0, ROUTE_N)) {
    console.log(`  p=${s.p.toFixed(3)}  ${String(s.name ?? '').padEnd(10)} ${s.w.reason}  ` +
      `基盤${s.row.rp_skillsByCategory ? '' : '?'}${featurize(s.row).base_n}/開発${featurize(s.row).dev_n} ` +
      `強技術${featurize(s.row).strong_infra_skills}`)
  }
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(scored.slice(0, ROUTE_N).map((s) => ({
      id: s.id, name: s.name, p: s.p, reason: s.w.reason,
      subject: s.row.rp_subject, text: String(s.row.rp_text ?? '').slice(0, 4000),
    })), null, 2), 'utf8')
    console.log(`\n  → ${OUT} に書き出した（claude -p 用）`)
  }
}
