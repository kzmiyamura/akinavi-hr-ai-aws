#!/usr/bin/env node
/**
 * 案件表（projects）から、プロが最初に見る箇所を数値にする。
 * **ローカル控えだけを使う（本番を引かない＝egress ゼロ）。**
 *
 * resume_signals.mjs は「申告・年齢・スキルの辻褄」を見た。こちらは時系列を見る。
 * ベテランの営業が経歴書で最初に指を置くのはここ:
 *   ① 案件と案件のあいだの空白  … 待機・離職。長い/多いのは理由がある
 *   ② 1案件あたりの在籍期間     … 短期の繰り返しは切られている可能性
 *   ③ 役割の推移               … PG→SE→PL と上がったか、同じ位置に留まったか
 *   ④ 直近の中身               … 売り文句と直近3年の実態がズレていないか
 *
 * 前提: D:\akinavi-archive\db\projects.jsonl（scripts/archive_projects.mjs が作る）。
 *       案件表を持つのは AI校正を通った人だけで、実測 3,005人中309人（10.3%）。
 *       **残り90%はこの見方ができない**。AI校正の到達率がそのまま上限になる。
 *
 *   node scripts/resume_timeline.mjs [--show 8]
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const DIR = argOf('--dir', 'D:\\akinavi-archive')
const SHOW = Number(argOf('--show', '8'))

const src = path.join(DIR, 'db', 'projects.jsonl')
if (!fs.existsSync(src)) {
  console.error(`${src} がありません。先に node scripts/archive_projects.mjs を実行してください`)
  process.exit(1)
}

/** 「2024/4」「2024年4月」「R6.4」→ 通算月。lib.mjs の parseYM と同じ考え方 */
const ERA = { 令和: 2018, R: 2018, 平成: 1988, H: 1988, 昭和: 1925, S: 1925 }
function parseYM(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = s.match(/^(19|20)(\d{2})[/年.\-]\s*(\d{1,2})/)
  if (m) return Number(m[1] + m[2]) * 12 + Number(m[3])
  m = s.match(/^(令和|平成|昭和|[RHSrhs])\s?(\d{1,2})\s*[年./\-]\s*(\d{1,2})/)
  if (m) {
    const base = ERA[m[1]] ?? ERA[m[1].toUpperCase()]
    if (base) return (base + Number(m[2])) * 12 + Number(m[3])
  }
  return null
}
const NOW = (() => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() + 1 })()

/**
 * ⚠ 役割の推移は**計算できない**。
 *   TRANSCRIBE_RULES が AI に求めている出力は {start, end, techs} だけで、
 *   役割・案件名・工程を聞いていない（prompts.mjs の出力JSON形）。
 *   AI はグリッドのそのセルを読んでいるのに、捨てている。
 *   プロンプトに role と phases を足せば、ほぼ追加費用なしで
 *   「役割の推移」「工程の幅（上流に触れたか）」が取れるようになる。
 *
 * 代わりに、今のデータで計算できる**売り文句と実態のズレ**を見る。
 * 登録スキルのうち直近3年の案件に出てくる割合。低いほど
 * 「営業が並べた技術」と「本人が最近やったこと」が離れている。
 */
const RECENT_MONTHS = 36
const normTech = (s) => String(s ?? '').toLowerCase().replace(/[\s　・\-_.]/g, '')

/** 人材の登録スキル（別ファイル）を id で引けるようにする */
function loadSkillsById(dir) {
  const d = path.join(dir, 'db', 'candidates')
  const m = new Map()
  if (!fs.existsSync(d)) return m
  for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r?.id && Array.isArray(r.skills)) m.set(r.id, r.skills)
    }
  }
  return m
}

const skillsById = loadSkillsById(DIR)
const rows = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const recs = []
for (const r of rows) {
  const ps = (r.rp_projects || []).map((p) => ({
    s: parseYM(p.start), e: parseYM(p.end) ?? NOW, techs: p.techs ?? [],
  })).filter((p) => p.s != null && p.e >= p.s).sort((a, b) => a.s - b.s)
  if (ps.length < 2) continue

  // ① 空白: 前の案件の終わりと次の始まりの差（重なりは0扱い）
  const gaps = []
  for (let i = 1; i < ps.length; i++) gaps.push(Math.max(0, ps[i].s - ps[i - 1].e))
  const maxGap = Math.max(...gaps, 0)
  const bigGaps = gaps.filter((g) => g >= 3).length
  // 直近の案件の終わりから今日まで（待機中かどうか）
  const idleNow = Math.max(0, NOW - Math.max(...ps.map((p) => p.e)))

  // ② 在籍期間
  const durs = ps.map((p) => p.e - p.s + 1)
  const sorted = [...durs].sort((a, b) => a - b)
  const medDur = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const shortJobs = durs.filter((d) => d <= 6).length

  // ③ 売り文句と実態のズレ: 登録スキルのうち直近3年の案件に出てくる割合
  const recentTechs = new Set()
  for (const p of ps) if (p.e >= NOW - RECENT_MONTHS) for (const t of p.techs ?? []) recentTechs.add(normTech(t))
  const listed = (skillsById.get(r.id) ?? []).map(normTech).filter(Boolean)
  const covered = listed.filter((t) => recentTechs.has(t)).length
  const recentCoverage = listed.length >= 5 ? covered / listed.length : null

  recs.push({
    id: r.id, n: ps.length, spanY: (ps[ps.length - 1].e - ps[0].s + 1) / 12,
    maxGap, bigGaps, idleNow, medDur, shortJobs, recentCoverage,
    listedSkills: listed.length, recentTechs: recentTechs.size,
    shortRatio: shortJobs / durs.length,
  })
}

const pr = (title, key, buckets) => {
  const v = recs.filter((r) => r[key] != null)
  console.log(`\n■ ${title}（対象 ${v.length}人）`)
  for (const b of buckets) {
    const n = v.filter((r) => b.test(r[key])).length
    console.log(`   ${b.label.padEnd(24)} ${String(n).padStart(4)}人 (${(n / v.length * 100).toFixed(1)}%)${b.note ? '  ' + b.note : ''}`)
  }
}

console.log(`案件表を持つ人: ${rows.length}人 / うち2案件以上で時系列が読めた人: ${recs.length}人`)
console.log(`（案件表があるのは AI校正を通った人だけ。prod 3,005人中309人＝10.3%が上限）`)

pr('① いちばん長い空白', 'maxGap', [
  { label: '空白なし', test: (v) => v === 0 },
  { label: '1〜2ヶ月', test: (v) => v >= 1 && v <= 2 },
  { label: '3〜6ヶ月', test: (v) => v >= 3 && v <= 6, note: '← 理由を聞く' },
  { label: '7〜12ヶ月', test: (v) => v >= 7 && v <= 12, note: '← 要確認' },
  { label: '1年超', test: (v) => v > 12, note: '← 必ず理由を押さえる' },
])

pr('② 3ヶ月以上の空白の回数', 'bigGaps', [
  { label: '0回', test: (v) => v === 0 },
  { label: '1回', test: (v) => v === 1 },
  { label: '2回', test: (v) => v === 2 },
  { label: '3回以上', test: (v) => v >= 3, note: '← 繰り返している' },
])

pr('③ 1案件あたりの在籍期間（中央値）', 'medDur', [
  { label: '6ヶ月以下', test: (v) => v <= 6, note: '← 短期の繰り返し' },
  { label: '7〜12ヶ月', test: (v) => v > 6 && v <= 12 },
  { label: '1〜2年', test: (v) => v > 12 && v <= 24 },
  { label: '2年超', test: (v) => v > 24, note: '← 長く使われている' },
])

pr('④ 半年以下の案件の割合', 'shortRatio', [
  { label: '0〜25%', test: (v) => v <= 0.25 },
  { label: '25〜50%', test: (v) => v > 0.25 && v <= 0.5 },
  { label: '50〜75%', test: (v) => v > 0.5 && v <= 0.75, note: '← 半分以上が短期' },
  { label: '75%超', test: (v) => v > 0.75, note: '← ほぼ短期のみ' },
])

pr('⑤ 売り文句と実態のズレ（登録スキルのうち直近3年の案件に出てくる割合）', 'recentCoverage', [
  { label: '20%未満', test: (v) => v < 0.2, note: '← 登録スキルの大半が直近に無い' },
  { label: '20〜40%', test: (v) => v >= 0.2 && v < 0.4 },
  { label: '40〜60%', test: (v) => v >= 0.4 && v < 0.6 },
  { label: '60%以上', test: (v) => v >= 0.6, note: '← 直近の実態と一致' },
])

pr('⑥ 直近案件の終了から今日まで', 'idleNow', [
  { label: '稼働中〜1ヶ月', test: (v) => v <= 1 },
  { label: '2〜3ヶ月', test: (v) => v >= 2 && v <= 3 },
  { label: '4〜12ヶ月', test: (v) => v >= 4 && v <= 12, note: '← 長めの待機' },
  { label: '1年超', test: (v) => v > 12, note: '← 経歴書が古い可能性も' },
])

// 営業に見せる価値のある「引っかかる人」
const flagged = recs.filter((r) => r.maxGap > 12 || r.bigGaps >= 3 || r.shortRatio > 0.75)
console.log(`\n■ 引っかかる人: ${flagged.length}人（${(flagged.length / recs.length * 100).toFixed(1)}%）`)
for (const f of flagged.slice(0, SHOW)) {
  console.log(`   案件${String(f.n).padStart(2)}件 / ${f.spanY.toFixed(1)}年  ` +
    `最長空白${String(f.maxGap).padStart(2)}ヶ月 / 3ヶ月超の空白${f.bigGaps}回 / ` +
    `在籍中央値${f.medDur}ヶ月 / 短期${(f.shortRatio * 100).toFixed(0)}%`)
}
