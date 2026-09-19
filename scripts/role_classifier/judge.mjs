#!/usr/bin/env node
/**
 * 輪の3つ目。分類器が迷った人を claude -p に**独立に**判定させ、突き合わせる。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * ⚠ AI に分類器の答えを見せない。
 *   2026-09-19 の実験で、regex の候補を見せた版は12件中5件で null を返した。
 *   正解（システムエンジニア／データエンジニア）が候補に無かったため答えられなかった。
 *   独立に判断させて**あとで突き合わせる**。割れること自体が情報になる。
 *
 * 2つの使い方:
 *   --route N  … 分類器が迷っている人（確率が0.5付近）を N 人。教師データを増やす
 *   --audit N  … 分類器が**確信している**人を無作為に N 人。系統的な誤りを見つける
 *                （確信している側は閾値付近を見ても永久に気づけない）
 *
 *   node scripts/role_classifier/judge.mjs --route 8
 *   node scripts/role_classifier/judge.mjs --audit 8
 */
import fs from 'fs'
import { loadRows, featurize, weakLabel, FEATURE_NAMES, STRONG_INFRA_SKILLS } from './dataset.mjs'
import { callModel } from '../llm_extract/caller.mjs'
import { trimBodyForLlm } from '../llm_extract/shadow_worker_lib.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROUTE_N = Number(argOf('--route', '0'))
const AUDIT_N = Number(argOf('--audit', '0'))
const OUT = argOf('--out', '')
if (!ROUTE_N && !AUDIT_N) { console.error('--route N か --audit N を指定してください'); process.exit(1) }

// ── 学習（train.mjs と同じ手順。係数を得るためだけに回す） ────────────────
const rows = loadRows()
const labeled = [], unsure = [], confident = []
for (const r of rows) {
  const w = weakLabel(r)
  const f = featurize(r)
  const x = FEATURE_NAMES.map((k) => f[k])
  if (w.label === 1 || w.label === 0) { labeled.push({ x, y: w.label }); confident.push({ r, x, y: w.label, f }) }
  else if (w.reason !== '信号なし') unsure.push({ r, x, w, f })
}
let seed = 20260919
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const D = FEATURE_NAMES.length
const mean = new Array(D).fill(0), std = new Array(D).fill(0)
for (const d of labeled) for (let j = 0; j < D; j++) mean[j] += d.x[j] / labeled.length
for (const d of labeled) for (let j = 0; j < D; j++) std[j] += (d.x[j] - mean[j]) ** 2 / labeled.length
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j]) || 1
const z = (x) => x.map((v, j) => (v - mean[j]) / std[j])
const w8 = new Array(D).fill(0)
let b = 0
const sig = (t) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))))
const score = (x) => sig(z(x).reduce((a, v, j) => a + v * w8[j], b))
for (let e = 0; e < 600; e++) {
  const gw = new Array(D).fill(0); let gb = 0
  for (const d of labeled) {
    const err = score(d.x) - d.y, zx = z(d.x)
    for (let j = 0; j < D; j++) gw[j] += err * zx[j] / labeled.length
    gb += err / labeled.length
  }
  for (let j = 0; j < D; j++) w8[j] -= 0.1 * (gw[j] + 0.01 * w8[j])
  b -= 0.1 * gb
}

// ── 対象を選ぶ ────────────────────────────────────────────────────────────
let targets, mode
if (ROUTE_N) {
  mode = 'route'
  targets = unsure.map((u) => ({ ...u, p: score(u.x) }))
    .sort((a, b2) => Math.abs(a.p - 0.5) - Math.abs(b2.p - 0.5)).slice(0, ROUTE_N)
} else {
  mode = 'audit'
  // 確信している人から無作為に。正負を半々にして偏らせない
  const pos = confident.filter((c) => c.y === 1), neg = confident.filter((c) => c.y === 0)
  const pick = (arr, n) => arr.map((d) => ({ d, k: rnd() })).sort((a, b2) => a.k - b2.k).slice(0, n).map((o) => o.d)
  targets = [...pick(pos, Math.ceil(AUDIT_N / 2)), ...pick(neg, Math.floor(AUDIT_N / 2))]
    .map((c) => ({ ...c, p: score(c.x) }))
}

/** AI に渡すプロンプト。**分類器の確率も弱教師の結果も渡さない**（アンカリング防止）。
 *  判断材料は本文だけ。役割の定義だけ与えて、独立に答えさせる */
const prompt = (t) => `あなたはSES営業の技術者経歴の読み取り係です。
下の人材メール本文を読んで、**この人が基盤（インフラ）の技術者かどうか**だけを判断してください。

判断の基準:
- サーバ / ネットワーク / クラウド基盤 / 仮想化 / ミドルウェアの設計・構築・運用を
  **本人の仕事として**行っていれば yes
- アプリケーション開発（業務ロジック・画面・API）が中心なら no
- 【希望案件】欄にしか出てこないもの、否定されているものは根拠にしない
  （「インフラ案件希望」はやりたいことであって経歴ではない）
- 開発も基盤も両方やっている場合、**基盤の比重が明らかに小さければ** no

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"infra":true または false,"confidence":"high|medium|low","reason":"40字以内の根拠"}

--- 以下メール本文 ---
${trimBodyForLlm(`${t.r.rp_subject ?? ''}\n${t.r.rp_text ?? ''}`)}`

// ── 実行 ─────────────────────────────────────────────────────────────────
console.log(`${mode === 'route' ? '■ 振り分け: 分類器が迷っている人' : '■ 監査: 分類器が確信している人（無作為）'} ${targets.length}人`)
console.log('  ※ AI には分類器の答えを見せていない（独立判定）\n')

const out = []
let agree = 0
for (const [i, t] of targets.entries()) {
  let d = null
  try { d = (await callModel('haiku', prompt(t))).data } catch (e) { d = { error: String(e.message).slice(0, 50) } }
  const clsSays = t.p >= 0.5
  const aiSays = d?.infra === true
  const ok = d?.error ? null : clsSays === aiSays
  if (ok) agree++
  const mark = d?.error ? '失敗' : ok ? '一致' : '★相違'
  console.log(`${String(i + 1).padStart(2)}. ${mark}  分類器 p=${t.p.toFixed(3)}(${clsSays ? 'インフラ' : '違う'}) / AI=${d?.error ? d.error : (aiSays ? 'インフラ' : '違う')}(${d?.confidence ?? '-'})`)
  console.log(`     ${String(t.r.name ?? '').padEnd(12)} 基盤${t.f.base_n}/開発${t.f.dev_n} 強技術${t.f.strong_infra_skills}  ${d?.reason ?? ''}`)
  if (!ok && !d?.error) console.log(`     件名: ${String(t.r.rp_subject ?? '').slice(0, 72)}`)
  out.push({ id: t.r.id, name: t.r.name, p: t.p, ai: d, features: t.f, subject: t.r.rp_subject })
}

const done = out.filter((o) => !o.ai?.error).length
console.log(`\n一致 ${agree}/${done}`)
if (mode === 'route') {
  console.log('→ 一致した分はそのまま教師データに足せる。相違した分が、人が見る価値のある件。')
} else {
  console.log('→ ここでの相違は**系統的な誤り**の疑い。閾値付近を見ても見つからない種類のもの。')
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8'); console.log(`→ ${OUT} に保存`) }
