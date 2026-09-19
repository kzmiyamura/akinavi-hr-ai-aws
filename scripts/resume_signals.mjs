#!/usr/bin/env node
/**
 * 経歴書を「プロがどう見抜くか」を数値にする。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * ベテランの営業・リクルーターが経歴書で確かめていることのうち、
 * **今あるデータで計算できるもの**だけを実装した。できないものは末尾に書いてある。
 *
 * 前提: rp_skillYears の値は「月」。skillYearsFromProjects が unionMonths で
 *       案件期間の**重複を除いた実月数**を出している（lib.mjs:189）。
 *       したがって max(skillYears) は経歴書が裏付ける職歴の長さの下限になる。
 *
 * 指標:
 *  ① 開始年齢      = 年齢 − 申告経験年数。18未満は計算が合わない。40超は異業種転職
 *  ② 申告と裏付けの差 = 申告経験年数 − max(skillYears)/12
 *       ＋方向（申告が長い）は正常。案件表に前職・研修は載らないため。
 *       −方向（経歴書のほうが長い）は**申告が過小**。経験を隠している/転記ミス
 *  ③ スキルの薄さ   = スキル本数 ÷ 経験年数。短い経歴に大量の技術＝並べただけ
 *  ④ 深さ          = skillYears の中央値（月）。全部が短期なら広く浅く
 *  ⑤ 単価と経験     = 希望単価 ÷ 経験年数。釣り合わないものは理由がある
 *
 *   node scripts/resume_signals.mjs [--flags] [--show 10]
 */
import { loadRows } from './role_classifier/dataset.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const SHOW = Number(argOf('--show', '6'))

/** 「55～60万」「75万円」「~80万」→ 万円（範囲は中央値）。取れなければ null */
function parseRate(s) {
  const t = String(s ?? '')
  if (!t) return null
  const nums = [...t.matchAll(/(\d{2,3})\s*万/g)].map((m) => Number(m[1]))
    .filter((n) => n >= 20 && n <= 300)
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const rows = loadRows()
const recs = []
for (const r of rows) {
  const age = Number(r.rp_age ?? 0) || null
  const exp = Number(r.experience_years ?? 0) || null
  const sy = r.rp_skillYears && typeof r.rp_skillYears === 'object' ? r.rp_skillYears : {}
  const months = Object.values(sy).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const maxM = months.length ? Math.max(...months) : null
  const medM = median(months)
  const skills = Array.isArray(r.skills) ? r.skills.length : 0
  const rate = parseRate(r.desired_rate)

  recs.push({
    name: r.name, subject: r.rp_subject, age, exp, skills, rate,
    maxYears: maxM != null ? maxM / 12 : null,
    medMonths: medM,
    startAge: age != null && exp != null ? age - exp : null,
    // 申告 − 裏付け。＋なら申告が長い（正常）、−なら経歴書のほうが長い（申告が過小）
    gap: exp != null && maxM != null ? exp - maxM / 12 : null,
    density: exp ? skills / exp : null,
    ratePerYear: rate != null && exp ? rate / exp : null,
  })
}

const has = (k) => recs.filter((r) => r[k] != null)
const dist = (k, buckets) => {
  const v = has(k)
  const out = buckets.map((b) => ({ ...b, n: v.filter((r) => b.test(r[k])).length }))
  return { total: v.length, out }
}
const pr = (title, k, buckets) => {
  const { total, out } = dist(k, buckets)
  console.log(`\n■ ${title}（対象 ${total}人 / 全 ${recs.length}人）`)
  for (const b of out) {
    const pct = total ? (b.n / total * 100).toFixed(1) : '0.0'
    console.log(`   ${b.label.padEnd(26)} ${String(b.n).padStart(5)}人 (${pct}%)${b.note ? '  ' + b.note : ''}`)
  }
}

console.log(`控えの人数: ${recs.length}`)

pr('① 開始年齢（年齢 − 申告経験年数）', 'startAge', [
  { label: '18未満', test: (v) => v < 18, note: '← 計算が合わない。年齢か経験年数が誤り' },
  { label: '18〜22（新卒から）', test: (v) => v >= 18 && v < 23 },
  { label: '23〜30', test: (v) => v >= 23 && v < 31 },
  { label: '31〜40', test: (v) => v >= 31 && v <= 40, note: '← 異業種からの転職' },
  { label: '40超', test: (v) => v > 40, note: '← 遅い参入。要確認' },
])

pr('② 申告と経歴書の差（申告年数 − 経歴書が裏付ける年数）', 'gap', [
  { label: '−2年未満（経歴書が長い）', test: (v) => v < -2, note: '← 申告が過小。取りこぼし' },
  { label: '−2〜0年', test: (v) => v >= -2 && v < 0 },
  { label: '0〜3年（正常）', test: (v) => v >= 0 && v <= 3, note: '← 前職・研修のぶん' },
  { label: '3〜8年', test: (v) => v > 3 && v <= 8 },
  { label: '8年超', test: (v) => v > 8, note: '← 経歴書が裏付けていない' },
])

pr('③ スキルの薄さ（スキル本数 ÷ 経験年数）', 'density', [
  { label: '1本/年未満', test: (v) => v < 1 },
  { label: '1〜3本/年', test: (v) => v >= 1 && v < 3 },
  { label: '3〜6本/年', test: (v) => v >= 3 && v < 6 },
  { label: '6本/年以上', test: (v) => v >= 6, note: '← 広く浅い / 並べただけの疑い' },
])

pr('④ 深さ（技術ごとの経験月数の中央値）', 'medMonths', [
  { label: '6ヶ月未満', test: (v) => v < 6, note: '← どの技術も短期' },
  { label: '6〜12ヶ月', test: (v) => v >= 6 && v < 12 },
  { label: '1〜3年', test: (v) => v >= 12 && v < 36 },
  { label: '3年以上', test: (v) => v >= 36, note: '← 腰を据えて使っている' },
])

pr('⑤ 単価と経験のつり合い（万円 ÷ 経験年数）', 'ratePerYear', [
  { label: '2万/年未満', test: (v) => v < 2, note: '← 経験の割に安い。理由がある' },
  { label: '2〜5万/年', test: (v) => v >= 2 && v < 5 },
  { label: '5〜10万/年', test: (v) => v >= 5 && v < 10 },
  { label: '10〜20万/年', test: (v) => v >= 10 && v < 20 },
  { label: '20万/年以上', test: (v) => v >= 20, note: '← 経験が浅いのに高い' },
])

// ── 明らかな矛盾を抱えている人を出す（営業に見せる印の候補） ──────────────
const contradictions = recs.filter((r) =>
  (r.startAge != null && r.startAge < 18) || (r.gap != null && r.gap < -2))
console.log(`\n■ 計算が合わない人: ${contradictions.length}人（${(contradictions.length / recs.length * 100).toFixed(1)}%）`)
for (const c of contradictions.slice(0, SHOW)) {
  console.log(`   ${String(c.name ?? '').padEnd(12)} 年齢${c.age ?? '-'} 申告${c.exp ?? '-'}年 ` +
    `経歴書${c.maxYears != null ? c.maxYears.toFixed(1) : '-'}年 開始${c.startAge ?? '-'}歳  ` +
    `${String(c.subject ?? '').slice(0, 44)}`)
}

console.log(`
■ 今のデータでは数値化できないもの（案件表そのものが要る）
   ・案件と案件のあいだの空白（待機・離職の長さ）
   ・1案件あたりの在籍期間（短期の繰り返しは切られている可能性）
   ・役割の推移（PG→SE→PL と上がっているか、同じ位置に留まっているか）
   ・直近の案件と、営業が書いた売り文句のズレ
   ・関わった工程の幅（上流に触れたか）＝ 既存の到達レベル判定が近い
   ・チーム規模（5人のPLと50人のPMは別物）
  いずれも projects[] の開始・終了・役割が要る。控えには落としていないので、
  使うなら archive_local.mjs に projects を足すところから。`)
