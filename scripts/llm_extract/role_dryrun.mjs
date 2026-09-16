#!/usr/bin/env node
// =============================================================================
// 役割を AI に読ませたら regex より良くなるか、ドライランで確かめる
// =============================================================================
// 使い方:
//   node scripts/llm_extract/role_dryrun.mjs [--n 40] [--model haiku] [--seed 1]
//
// なぜ要るか（2026-09-16 ユーザー指摘「フリーフォーマットはaiの校正がきくんでしょ。特に役割」）:
//   AI校正（FIELD_POLICY）は name / company / age / skillYears 等を直しているが、
//   **roles は対象外**で、プロンプトにも項目が無い。一度も AI に聞いたことがない。
//   一方で役割は「自由記述から立場を読む」判断そのもので、regex がいちばん苦手な領域。
//
//   ただし FIELD_POLICY は 2026-08-07 に実データ60件のドライランで決めた経緯がある。
//   単価・駅は AI に任せると劣化した。**役割も、入れる前に測る。**
//
// egress ゼロ:
//   本番を引かない。D:\akinavi-archive\mail のメール原本を読む。
//
// 出力:
//   一致 / 食い違い の件数と、食い違った実例（本文の該当部分つき）。
//   どちらが正しいかは**人が読んで決める**。このスクリプトは判定しない。
// =============================================================================
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFromProse } from '../_extractors.gen.mjs'
import { callModel } from './caller.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const N = Number(argOf('--n', 40))
const MODEL = argOf('--model', 'haiku')
const SEED = Number(argOf('--seed', 1))
const ROOT = argOf('--dir', 'D:/akinavi-archive/mail')
const OUT = argOf('--out', '')

const IS_JINZAI = /【氏名】|【年齢】|人材情報|要員情報|弊社社員|【備\s*考】|ご紹介/
const IS_ANKEN = /【案件|案件情報|募集要項|【募集|【作業期間】|エンド直案件/

// docs/ROLE_DEFINITION.md の23ラベル。**一覧外の言葉を作らせない**
const LABELS = [
  'プロジェクトマネージャー', 'プロジェクトリーダー', 'PMO', 'スクラムマスター',
  'プロダクトマネージャー', 'コンサルタント', 'アーキテクト', 'テックリード',
  'システムエンジニア', 'プログラマー', 'フロントエンドエンジニア', 'バックエンドエンジニア',
  'フルスタックエンジニア', 'モバイルアプリエンジニア', 'インフラエンジニア', 'クラウドエンジニア',
  'データエンジニア', 'MLエンジニア', 'テストエンジニア', '社内SE', 'SRE',
  '運用保守', 'ヘルプデスク',
]

const RULES = `あなたはSES営業メールの読み取り係です。メール本文から「その人材の役割」を判断してください。

必ず次の一覧から選びます。一覧に無い言葉を作らないでください:
${LABELS.join(' / ')}

判断のルール（重要）:
- mainRole は **その人が実際に担ってきた立場**を1つ。迷ったら本文で先に、強く書かれている方
- subRoles は他に担っていた役割（最大3つ、無ければ空配列）
- **「工程として関わった」は役割ではない**。「要件定義から運用保守まで一連の工程を経験」は
  運用保守が職種という意味ではない
- **「作業をした」は役割ではない**。「問い合わせ対応を担当」だけでヘルプデスクとしない
- **【希望案件】欄は"やりたいこと"であって経歴ではない**。そこにしか出てこない役割は採らない
- **「PM補佐」「サブリーダー」は本人の役割にしない**（補佐は決裁しない）
- **否定は採らない**。「PMは得意ではありません」「PMポジションは希望せず」
- PL/SQL・PL/I は Oracle や IBM の**言語**であって役割ではない
- 役割が読み取れなければ mainRole は null

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"results":[{"no":1,"mainRole":null,"subRoles":[],"why":"根拠にした本文の語を20字以内で"}]}

--- 以下、番号付きのメール本文 ---
`

// ── 対象メールを決める（再現できるよう擬似乱数は seed 固定）───────────────
let rnd = SEED
const next = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648

const pool = []
for (const day of readdirSync(ROOT, { withFileTypes: true })) {
  if (!day.isDirectory()) continue
  for (const m of readdirSync(join(ROOT, day.name), { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const p = join(ROOT, day.name, m.name, 'message.json')
    if (!existsSync(p)) continue
    let j
    try { j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const text = (j.subject ?? '') + '\n' + (j.body ?? '')
    if (!IS_JINZAI.test(text) || IS_ANKEN.test(text)) continue
    if (text.length < 300 || text.length > 6000) continue      // 極端に短い/長いは除く
    pool.push({ id: `${day.name}/${m.name}`, subject: j.subject ?? '', text })
  }
}
// シャッフルして先頭 N 件
for (let i = pool.length - 1; i > 0; i--) {
  const k = Math.floor(next() * (i + 1));[pool[i], pool[k]] = [pool[k], pool[i]]
}
const picked = pool.slice(0, N)
console.log(`候補 ${pool.length} 通から ${picked.length} 通を検査（seed=${SEED}, model=${MODEL}）\n`)

// ── AI に聞く（10通ずつ）────────────────────────────────────────────────────
const aiByIdx = new Map()
let cost = 0, ms = 0
for (let s = 0; s < picked.length; s += 10) {
  const chunk = picked.slice(s, s + 10)
  const body = chunk.map((c, i) =>
    `【${i + 1}】\n${c.text.slice(0, 4000)}\n`).join('\n')
  let res
  try {
    res = await callModel(MODEL, RULES + body)
  } catch (e) {
    console.error(`  呼び出し失敗（${s + 1}〜）: ${e.message}`)
    continue
  }
  cost += res.costUsd ?? 0
  ms += res.ms ?? 0
  const rows = res.data?.results ?? []
  for (const r of rows) {
    const idx = s + (Number(r.no) - 1)
    if (idx >= s && idx < s + chunk.length) aiByIdx.set(idx, r)
  }
  process.stdout.write(`  ${Math.min(s + 10, picked.length)}/${picked.length} 件\r`)
}
console.log('')

// ── 比較 ────────────────────────────────────────────────────────────────────
let agree = 0, differ = 0, noAi = 0, bothNull = 0
const diffs = []
for (let i = 0; i < picked.length; i++) {
  const c = picked[i]
  const rx = extractFromProse(c.text, '')
  const rxMain = rx.roles[0] ?? null
  const ai = aiByIdx.get(i)
  if (!ai) { noAi++; continue }
  const aiMain = ai.mainRole && LABELS.includes(ai.mainRole) ? ai.mainRole : null
  if (rxMain === null && aiMain === null) { bothNull++; continue }
  if (rxMain === aiMain) agree++
  else {
    differ++
    diffs.push({
      id: c.id,
      subject: c.subject.slice(0, 70),
      regex: rxMain, regexAll: rx.roles.slice(0, 4),
      regexScore: rxMain ? rx.roleScores[rxMain] : null,
      regexEvidence: rx.roleEvidence?.[rxMain] ?? null,
      ai: aiMain, aiSub: ai.subRoles ?? [], why: ai.why ?? '',
    })
  }
}

console.log('══ 結果 ══')
console.log(`  一致           ${agree}`)
console.log(`  食い違い        ${differ}`)
console.log(`  両方とも役割なし  ${bothNull}`)
if (noAi) console.log(`  AI応答なし      ${noAi}`)
console.log(`  トークン費用（参考・Max枠内） ${cost.toFixed(4)} / ${(ms / 1000).toFixed(1)}秒\n`)

console.log('══ 食い違い（どちらが正しいかは人が読んで決める）══')
for (const d of diffs) {
  console.log(`\n── ${d.subject}`)
  console.log(`   regex : ${d.regex ?? '(なし)'}  [スコア${d.regexScore ?? '-'}${d.regexEvidence ? '/印:' + d.regexEvidence : ''}]  全部=${JSON.stringify(d.regexAll)}`)
  console.log(`   AI    : ${d.ai ?? '(なし)'}  副=${JSON.stringify(d.aiSub)}`)
  console.log(`   AI根拠 : ${d.why}`)
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ agree, differ, bothNull, noAi, diffs }, null, 2), 'utf8')
  console.log(`\n書き出し: ${OUT}`)
}
