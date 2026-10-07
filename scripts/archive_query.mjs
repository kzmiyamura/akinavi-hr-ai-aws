#!/usr/bin/env node
/**
 * ローカル控え（archive_local.mjs が貯めたJSONL）を集計する。**本番は一切引かない。**
 *
 *   node scripts/archive_query.mjs summary                 # 全体の内訳
 *   node scripts/archive_query.mjs daily                   # 日別の登録数と品質
 *   node scripts/archive_query.mjs company [上位N]          # 送信元会社ごとの件数と品質
 *   node scripts/archive_query.mjs missed                  # 取りこぼし（登録されなかったメール）
 *
 * 人材は7日で本番から消えるが、ここには残る。
 * 「先月と比べてどうか」を調べるのに egress を使わなくて済むのが狙い。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
// 氏名と経歴書ファイル名の照合は**本番と同じ関数**を使う（書き写すとズレる）
import { isOwnersResumeFile, normalizeAgentCompany } from './_extractors.gen.mjs'
// 氏名として成立していない行（「不明」「要員」等）を束ねないため。検出器⑤と同じ規則
import { badNameReasons } from './lib/bad_names.mjs'

/**
 * 控えの場所。環境変数 → D:\akinavi-archive → ~/akinavi-archive の順に探す。
 *
 * ⚠ **既定を1つに決め打ちしない。** このマシンの控えは D ドライブにあるのに
 *    `~/akinavi-archive` を既定にしていたため、何も見つからないまま
 *    「人材 0 件」と表示して**正常終了していた**（2026-10-03 発覚）。
 */
function findArchiveDir() {
  for (const d of [process.env.AKINAVI_ARCHIVE_DIR, 'D:\\akinavi-archive', join(homedir(), 'akinavi-archive')]) {
    if (!d) continue
    const r = resolve(d)
    if (existsSync(join(r, 'db')) || existsSync(join(r, 'candidates'))) return r
  }
  return resolve(process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))
}

const ARCHIVE_DIR = findArchiveDir()

/**
 * 表の置き場所。`db/<表>`（今の形）と `<表>`（昔の形）の両方を見る。
 *
 * ⚠ **archive_local.mjs が db/ の下に掘るようになったのに、こちらは追従していなかった。**
 *    その結果このスクリプトは全部の集計で 0 件を返していた。
 *    CLAUDE.md が「調査はまずここから」と指している道具が黙って空を返すと、
 *    読んだ人は「控えに無い」と判断して prod に SQL を投げる。**防ぎたかったことそのもの。**
 */
function tableDir(table) {
  for (const d of [join(ARCHIVE_DIR, 'db', table), join(ARCHIVE_DIR, table)]) {
    if (existsSync(d)) return d
  }
  return null
}

/** 見つからなかった表を覚えておき、最後に必ず画面へ出す（0件を事実として報告しない） */
const missingTables = new Set()

function* rows(table) {
  const dir = tableDir(table)
  if (!dir) { missingTables.add(table); return }
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

/**
 * 控えが読めたかを最後に報告する。**0件を「無い」と書かないための歯止め。**
 * 読めていなければ終了コード 2 を返す（呼び出し側が気づけるように）。
 */
function reportMissing() {
  if (missingTables.size === 0) return
  console.error('')
  console.error(`⚠ 控えに見つからなかった表: ${[...missingTables].join(', ')}`)
  console.error(`   探した場所: ${join(ARCHIVE_DIR, 'db', '<表>')} と ${join(ARCHIVE_DIR, '<表>')}`)
  console.error('   **上の集計は「データが無い」ではなく「読めていない」。**')
  console.error('   node scripts/archive_local.mjs を先に走らせるか、AKINAVI_ARCHIVE_DIR を指定する。')
  process.exitCode = 2
}
process.on('exit', reportMissing)

const pct = (n, d) => (d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(1)}%`.padStart(6))
const skillCount = (r) => {
  const sy = r.rp_skillYears ?? {}
  return Object.keys(sy).filter((k) => !k.startsWith('_')).length
}

const cmd = process.argv[2] ?? 'summary'

// ⚠ **知らないサブコマンドで黙って成功しないこと。** 以前このスクリプトは
//    控えを見つけられないまま 0 件・終了コード 0 を返しており、読んだ人が
//    「控えにデータが無い」と誤解して prod に SQL を投げていた。同じ事故を
//    サブコマンド名の打ち間違いで起こさないため、ここで止める。
/**
 * 位置引数（サブコマンドの後ろ）。**フラグとその値を食わない。**
 *
 * ⚠ 2026-10-04: `skillfilter --sample 6` が `--sample` を**スキル名のリスト**として
 *    読み、全員が「どのスキルにも該当しない」＝**8,225人中0人**という静かな嘘を返した。
 *    このスクリプトは「prod に SQL を投げないため」の道具なので、
 *    黙ってゼロを返すのが一番やってはいけない壊れ方（同じ病気で3度目）。
 */
const FLAGS_WITH_VALUE = new Set(['--sample', '--dir', '--since', '--list', '--company', '--window',
  // find 用。ここに足し忘れると値がサブコマンドの位置引数として読まれる（2026-10-04 の事故と同じ）
  '--name', '--skill', '--pref', '--age', '--exp', '--kw', '--no'])
const POSITIONAL = []
for (let i = 3; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('-')) {
    if (FLAGS_WITH_VALUE.has(a)) i++
    continue
  }
  POSITIONAL.push(a)
}
/** n 番目の位置引数（0 始まり）。無ければ null */
const posArg = (n) => POSITIONAL[n] ?? null

const COMMANDS = ['summary', 'daily', 'company', 'rate', 'skillfilter', 'missed', 'resume', 'dup', 'find']
if (!COMMANDS.includes(cmd)) {
  console.error(`⚠ 知らないサブコマンド: ${cmd}`)
  console.error(`   使えるのは: ${COMMANDS.join(' | ')}`)
  console.error('   rate [スキル]        経験年数帯ごとの希望単価の分布')
  console.error('   skillfilter [スキル,...]  本文マッチが絞り込みに足している人数')
  console.error('   company [社名]       その会社のメール1通あたりの人数（名簿かどうか）')
  console.error('   resume              氏名と経歴書ファイル名の一致')
  console.error('   dup                 同じ人が何度も登録されていないか')
  console.error('   find                条件で人材を引く（--name/--company/--skill/--pref/--age/--exp/--kw）')
  process.exit(2)
}

if (cmd === 'summary') {
  let n = 0, prod = 0, noName = 0, noExp = 0, noSkillYears = 0, noStation = 0, dup = 0
  let oldest = null, newest = null
  for (const r of rows('candidates')) {
    n++
    if (r.data_env === 'prod') prod++
    if (!r.name || r.name === '不明') noName++
    if (r.experience_years == null) noExp++
    if (skillCount(r) === 0) noSkillYears++
    if (!r.rp_nearestStation) noStation++
    if (r.duplicate_flag) dup++
    const d = r.created_at
    if (!oldest || d < oldest) oldest = d
    if (!newest || d > newest) newest = d
  }
  console.log(`控え: ${ARCHIVE_DIR}`)
  console.log(`人材 ${n} 件（prod ${prod}）  ${String(oldest).slice(0, 10)} 〜 ${String(newest).slice(0, 10)}`)
  console.log(`  氏名が不明        ${String(noName).padStart(5)}  ${pct(noName, n)}`)
  console.log(`  経験年数なし      ${String(noExp).padStart(5)}  ${pct(noExp, n)}`)
  console.log(`  スキル年数が空    ${String(noSkillYears).padStart(5)}  ${pct(noSkillYears, n)}`)
  console.log(`  最寄駅なし        ${String(noStation).padStart(5)}  ${pct(noStation, n)}`)
  console.log(`  重複フラグ        ${String(dup).padStart(5)}  ${pct(dup, n)}`)
  let logs = 0
  for (const _ of rows('ai_logs')) logs++
  console.log(`ai_logs ${logs} 件 / 会社 ${[...rows('agent_companies')].length} 社`)
}

if (cmd === 'daily') {
  const byDay = new Map()
  for (const r of rows('candidates')) {
    const d = String(r.created_at).slice(0, 10)
    const a = byDay.get(d) ?? { n: 0, noName: 0, noExp: 0, noSy: 0 }
    a.n++
    if (!r.name || r.name === '不明') a.noName++
    if (r.experience_years == null) a.noExp++
    if (skillCount(r) === 0) a.noSy++
    byDay.set(d, a)
  }
  console.log('日付        件数  氏名不明  経験なし  スキル年数なし')
  for (const [d, a] of [...byDay].sort()) {
    console.log(`${d}  ${String(a.n).padStart(4)}  ${pct(a.noName, a.n)}  ${pct(a.noExp, a.n)}  ${pct(a.noSy, a.n)}`)
  }
}

if (cmd === 'company') {
  /**
   * 社名を渡すと、その会社だけを「1通に何人載っているか」で見る。
   *
   *   node scripts/archive_query.mjs company                 # 上位15社
   *   node scripts/archive_query.mjs company ブライトスター    # その会社の中身
   *
   * ⚠ **「名簿か」は人数では分からない。** 1通1人のメールを10通送る会社と、
   *   10人の名簿を1通送る会社は、どちらも人材10人として入る。
   *   区別できるのは**本文が同じ人が何人いるか**（複数人メールは1通ぶんの本文を
   *   各人に配る。2026-09-17 以降は自分のブロックだけなので、
   *   **ブロック先頭までの共通部分**で見る）。
   */
  const nameArg = posArg(0)
  if (nameArg && !/^\d+$/.test(nameArg)) {
    const hit = [...rows('candidates')].filter((r) => String(r.from_company ?? '').includes(nameArg))
    if (!hit.length) {
      console.error(`⚠ 「${nameArg}」を from_company に含む人材が控えに無い`)
      console.error('   社名の一部で探す。上位社名は: node scripts/archive_query.mjs company')
      process.exit(2)
    }
    const prod = hit.filter((r) => r.data_env === 'prod')
    console.log(`「${nameArg}」を含む会社の人材 ${hit.length} 人（prod ${prod.length} 人）`)
    const cos = [...new Set(hit.map((r) => r.from_company))]
    console.log(`会社名の表記: ${cos.join(' / ')}`)

    // 同じメール由来かを「件名＋受信時刻」で束ねる。本文はブロックごとに違うので使えない
    const byMail = new Map()
    for (const r of hit) {
      const k = `${r.rp_subject ?? '(件名なし)'}|${r.rp_received ?? r.created_at ?? ''}`
      if (!byMail.has(k)) byMail.set(k, [])
      byMail.get(k).push(r)
    }
    const sizes = [...byMail.values()].map((v) => v.length).sort((a, b) => b - a)
    const multi = sizes.filter((n) => n > 1)
    console.log('')
    console.log(`メール ${byMail.size} 通 → 1通あたり ${sizes[0]} 〜 ${sizes[sizes.length - 1]} 人`)
    console.log(`複数人が載っていたメール: ${multi.length} 通（最大 ${multi[0] ?? 0} 人）`)
    console.log(`1通1人のメール:          ${sizes.length - multi.length} 通`)
    console.log('')
    console.log('通ごと（新しい順・上位10通）')
    const entries = [...byMail].sort((a, b) => String(b[0]).localeCompare(String(a[0]))).slice(0, 10)
    for (const [k, v] of entries) {
      const [subj, at] = k.split('|')
      const noSkill = v.filter((r) => (Array.isArray(r.skills) ? r.skills : []).length === 0).length
      console.log(`  ${String(v.length).padStart(2)}人  ${String(at).slice(0, 16)}  スキル空 ${noSkill}人`)
      console.log(`        件名: ${String(subj).slice(0, 70)}`)
      console.log(`        氏名: ${v.map((r) => r.name ?? '(名前なし)').slice(0, 8).join(' / ')}`)
    }
    process.exit(0)
  }

  const top = Number(nameArg ?? 15)
  const byCo = new Map()
  for (const r of rows('candidates')) {
    const c = (r.from_company ?? '(不明)').trim()
    const a = byCo.get(c) ?? { n: 0, noName: 0, noSy: 0, exp: [] }
    a.n++
    if (!r.name || r.name === '不明') a.noName++
    if (skillCount(r) === 0) a.noSy++
    if (r.experience_years != null) a.exp.push(r.experience_years)
    byCo.set(c, a)
  }
  console.log('件数  氏名不明  スキル年数なし  平均経験  会社')
  for (const [c, a] of [...byCo].sort((x, y) => y[1].n - x[1].n).slice(0, top)) {
    const avg = a.exp.length ? (a.exp.reduce((s, v) => s + v, 0) / a.exp.length).toFixed(1) : '-'
    console.log(`${String(a.n).padStart(4)}  ${pct(a.noName, a.n)}  ${pct(a.noSy, a.n)}  ${String(avg).padStart(6)}年  ${c}`)
  }
}

if (cmd === 'rate') {
  // 経験年数帯ごとの希望単価相場。**年齢を無視した相場比較を直すための実測。**
  //
  // きっかけ: 23歳・経験ほぼ無しの人材に「相場75万（VMware）-25」と出ていた。
  // 相場がスキル単位だけなので、20年選手の中央値と比べられていた。
  // 営業が知りたいのは「その年齢・経験でその金額が通るのか」。
  //
  //   node scripts/archive_query.mjs rate            # 経験年数帯ごとの相場
  //   node scripts/archive_query.mjs rate <スキル>    # そのスキルを帯で割ったときの人数
  const skillFilter = posArg(0)

  // SQL 側の parse_rate_man / 画面側の parseRateMan と同じ規則（範囲は下限・全角も拾う）
  const parseRate = (src) => {
    if (!src) return null
    const z = String(src).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    const m = z.match(/(\d+(?:\.\d+)?)/)
    if (!m) return null
    const v = Number(m[1])
    return v >= 10 && v <= 300 ? v : null
  }
  const pctl = (arr, p) => {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    const i = (s.length - 1) * p
    const lo = Math.floor(i), hi = Math.ceil(i)
    return Math.round(lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo))
  }
  // 帯の切り方は IT の単価が実際に段差になる所に合わせる（未経験/若手/中堅/ベテラン/シニア）
  const BANDS = [[0, 3], [3, 6], [6, 11], [11, 16], [16, 99]]
  const bandOf = (y) => BANDS.findIndex(([lo, hi]) => y >= lo && y < hi)
  const label = (i) => {
    const [lo, hi] = BANDS[i]
    return hi === 99 ? `${lo}年以上` : `${lo}〜${hi - 1}年`
  }

  const buckets = BANDS.map(() => [])
  let noExp = 0, noRate = 0, used = 0
  for (const r of rows('candidates')) {
    if (r.data_env !== 'prod') continue
    if (skillFilter) {
      const sk = Array.isArray(r.skills) ? r.skills : []
      if (!sk.includes(skillFilter)) continue
    }
    const rate = parseRate(r.desired_rate)
    const y = r.experience_years
    if (rate == null) { noRate++; continue }
    if (y == null) { noExp++; continue }
    const b = bandOf(y)
    if (b < 0) continue
    buckets[b].push(rate)
    used++
  }

  console.log(skillFilter ? `スキル「${skillFilter}」の経験年数別 希望単価` : '経験年数別 希望単価（prod 全員）')
  console.log(`対象 ${used} 人（単価が読めない ${noRate} 人・経験年数なし ${noExp} 人は除外）`)
  console.log('')
  console.log('経験          人数   25%   中央   75%')
  for (let i = 0; i < BANDS.length; i++) {
    const a = buckets[i]
    const mark = a.length < 20 ? '  ← 20人未満。相場と呼べない' : ''
    console.log(
      `${label(i).padEnd(10)}  ${String(a.length).padStart(5)}  `
      + `${String(pctl(a, 0.25) ?? '-').padStart(4)}  ${String(pctl(a, 0.5) ?? '-').padStart(4)}  `
      + `${String(pctl(a, 0.75) ?? '-').padStart(4)}${mark}`,
    )
  }

  if (!skillFilter) {
    // スキル×帯に割ったとき、何セットが「相場」と呼べる人数（20人以上）になるか。
    // ここが薄いならスキル×帯は作らず、帯だけで比べる方がよい
    const cells = new Map()
    const skillTotals = new Map()
    for (const r of rows('candidates')) {
      if (r.data_env !== 'prod') continue
      const rate = parseRate(r.desired_rate)
      if (rate == null || r.experience_years == null) continue
      const b = bandOf(r.experience_years)
      if (b < 0) continue
      for (const s of (Array.isArray(r.skills) ? r.skills : [])) {
        cells.set(`${s}${b}`, (cells.get(`${s}${b}`) ?? 0) + 1)
        skillTotals.set(s, (skillTotals.get(s) ?? 0) + 1)
      }
    }
    const usableSkills = [...skillTotals].filter(([, n]) => n >= 20).length
    const usableCells = [...cells].filter(([, n]) => n >= 20).length
    const perBand = BANDS.map((_, i) => [...cells].filter(([k, n]) => Number(k.split('')[1]) === i && n >= 20).length)
    console.log('')
    console.log('スキル×経験帯に割ったときの使えるセット数（20人以上）')
    console.log(`  スキル単位（今の相場表）: ${usableSkills} スキル`)
    console.log(`  スキル×帯             : ${usableCells} セット`)
    for (let i = 0; i < BANDS.length; i++) console.log(`    ${label(i).padEnd(10)} ${String(perBand[i]).padStart(4)} スキル`)
  }
}

if (cmd === 'skillfilter') {
  // 人材一覧の優先スキル絞り込みが、`skills` 列と本文正規表現のどちらで効いているかを測る。
  //
  // きっかけ: 人材タブの初回読み込みが重い。一覧は優先スキルごとに
  //   `skills.cs.[...]`（GIN索引あり）と `raw_profile->>text.imatch."..."`（索引なし）を
  //   **OR で繋いでいる**ため、索引が使えず全行の本文を正規表現で走る。
  //   本文側が実際に何人を足しているのかが分からないと、外していいか判断できない。
  //
  //   node scripts/archive_query.mjs skillfilter [スキル,スキル,...]
  const skills = (posArg(0) ?? 'Java,C#,Python,JavaScript,PHP').split(',').map((s) => s.trim())

  // 画面・ワーカーと同じ語境界（src/lib/skillWordMatch.ts の skillWordRegex と同じ規則）
  // ⚠ 画面の `src/lib/skillWordMatch.ts` の WORD_CHARS と**同じ集合でなければ測れない**。
  //    2026-10-04 まで `._` を語扱いしており、`PHP。` のような本文を取り逃がして
  //    実際より少なく（PHP 312人→100人）出ていた。「同じ規則」とコメントだけ書いて
  //    中身が違うのが一番危ない。
  const WORD = 'a-zA-Z0-9#+'
  const reOf = (s) => new RegExp(
    `(^|[^${WORD}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^${WORD}]|$)`, 'i',
  )
  /**
   * `--no-dot` で「直前が `.` のとき」を除いて測る。
   *
   * ⚠ 本番の語境界は `.` を語の一部と見ないので、**URL の拡張子に当たる**。
   *   2026-10-04 実測で、9/18 以降の「本文だけ該当」56人の大半が
   *   `https://a23.hm-f.jp/cc.php?t=…`（配信停止・スキルシートのリンク）だった。
   *   PHP 経験者として一覧に出ている＝営業が見る誤ヒット。
   */
  const reNoDotOf = (s) => new RegExp(
    `(^|[^${WORD}.])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^${WORD}]|$)`, 'i',
  )
  const NO_DOT = process.argv.includes('--no-dot')
  const res = skills.map((s) => ({ s, re: (NO_DOT ? reNoDotOf : reOf)(s) }))

  // `--sample N` で「本文だけ該当」の実物を前後文脈つきで出す。
  //
  // ⚠ 件数だけでは**外していいか決められない**。本文に出ているスキルが
  //   本人の経験なのか（＝抽出の取りこぼし＝直すべき）、募集要項やメールの
  //   定型文に出ているだけなのか（＝そもそも誤ヒット＝外すべき）で結論が逆になる。
  const sampleAt = process.argv.indexOf('--sample')
  const SAMPLE_N = sampleAt >= 0 ? Number(process.argv[sampleAt + 1] ?? 10) : 0
  const samples = []

  /**
   * 本文を何人で共有しているか（＝1通に複数人が載っていたメール）。
   *
   * ⚠ **ここを見ないと結論が逆になる。** 複数人メールでは1人ぶんのブロックから
   *   スキルを採るが、`body` は**メール全体**が各人に入る。すると
   *   「本文に Java があるのに skills 列に無い」が、取りこぼしではなく
   *   **同僚の Java に当たっているだけ**（＝本来外すべき誤ヒット）になる。
   *   2026-10-04 に `--sample` で同じ本文の2人（KH 25歳 / KY 55歳）が並んで気付いた。
   */
  const bodyShare = new Map()
  for (const r of rows('candidates')) {
    if (r.data_env !== 'prod') continue
    const b = r.rp_text ?? ''
    if (!b) continue
    const k = `${b.length}:${b.slice(0, 120)}`
    bodyShare.set(k, (bodyShare.get(k) ?? 0) + 1)
  }

  /**
   * `--since YYYY-MM-DD` で作成日を絞る。
   *
   * ⚠ **控えは prod より長い履歴を持つ**ので、直した後の挙動を見たいときは
   *   必ず切ること。例: 複数人メールで「本文に全員ぶんが入る」問題は
   *   **2026-09-17 に修正済み**（ブロックだけを保存する）。日付で切らずに測ると
   *   修正前の行が混ざり、「今も壊れている」という誤った結論になる（2026-10-04 に一度やった）。
   */
  const sinceAt = process.argv.indexOf('--since')
  const SINCE = sinceAt >= 0 ? process.argv[sinceAt + 1] : null
  const shareOf = (body) => (body ? bodyShare.get(`${body.length}:${body.slice(0, 120)}`) ?? 1 : 1)

  let total = 0, bySkills = 0, byBodyOnly = 0, neither = 0, noBody = 0
  let bodyOnlyShared = 0
  const bodyOnlyPerSkill = new Map()
  for (const r of rows('candidates')) {
    if (r.data_env !== 'prod') continue
    if (SINCE && String(r.created_at ?? '') < SINCE) continue
    total++
    const have = (Array.isArray(r.skills) ? r.skills : []).map((x) => String(x).toLowerCase())
    const body = r.rp_text ?? ''
    if (!body) noBody++
    const hitSkills = res.some(({ s }) => have.includes(s.toLowerCase()))
    if (hitSkills) { bySkills++; continue }
    const hitBody = res.filter(({ re }) => re.test(body))
    if (hitBody.length) {
      byBodyOnly++
      const share = shareOf(body)
      if (share > 1) bodyOnlyShared++
      for (const { s } of hitBody) bodyOnlyPerSkill.set(s, (bodyOnlyPerSkill.get(s) ?? 0) + 1)
      if (samples.length < SAMPLE_N) {
        const { s, re } = hitBody[0]
        const m = re.exec(body)
        const at = m ? m.index : 0
        samples.push({
          name: r.name ?? '(名前なし)',
          skill: s,
          share,
          skills: (Array.isArray(r.skills) ? r.skills : []).slice(0, 8).join('/') || '(空)',
          skillCount: (Array.isArray(r.skills) ? r.skills : []).length,
          around: body.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, ' ').trim(),
        })
      }
    } else neither++
  }

  console.log(`優先スキル: ${skills.join(', ')}${SINCE ? ` / ${SINCE} 以降に登録された人だけ` : ''}`)
  console.log(`prod 人材 ${total} 人（本文が空 ${noBody} 人）`)
  console.log('')
  console.log(`skills 列で該当（索引が効く）      ${String(bySkills).padStart(5)}  ${pct(bySkills, total).trim()}`)
  console.log(`本文の正規表現だけで該当（索引なし） ${String(byBodyOnly).padStart(5)}  ${pct(byBodyOnly, total).trim()}`)
  console.log(`どちらにも該当しない               ${String(neither).padStart(5)}  ${pct(neither, total).trim()}`)
  console.log('')
  console.log(`→ 本文マッチを外すと一覧から消える人: ${byBodyOnly} 人`)
  // 複数人メール由来かどうかで「取りこぼし」か「他人のスキルへの誤ヒット」かが分かれる
  console.log(`   うち本文を他の人材と共有している（複数人メール）: ${bodyOnlyShared} 人`
    + ` ${pct(bodyOnlyShared, byBodyOnly).trim()}`)
  console.log(`   1通1人のメール（＝本人の本文に出ている）:        ${byBodyOnly - bodyOnlyShared} 人`
    + ` ${pct(byBodyOnly - bodyOnlyShared, byBodyOnly).trim()}`)
  console.log('   内訳（スキル別・重複あり）')
  for (const [s, n] of [...bodyOnlyPerSkill].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${s.padEnd(12)} ${String(n).padStart(5)} 人`)
  }
  if (SAMPLE_N) {
    console.log('')
    console.log(`実物 ${samples.length} 件（本文だけ該当・前後の文脈つき）`)
    console.log('本人の経験なら抽出の取りこぼし。募集要項や定型文なら誤ヒット。')
    for (const s of samples) {
      console.log('')
      console.log(`  ${s.name}  【${s.skill}】  本文の共有人数: ${s.share}  skills列 ${s.skillCount}件: ${s.skills}`)
      console.log(`    …${s.around}…`)
    }
  } else {
    console.log('')
    console.log('実物を見る: node scripts/archive_query.mjs skillfilter "" --sample 10')
  }
}

if (cmd === 'missed') {
  // linked_id が null ＝ 解析したが人材として登録されなかったメール
  const byDomain = new Map()
  let total = 0, missed = 0
  for (const r of rows('ai_logs')) {
    if (r.type !== 'candidate') continue
    total++
    if (r.linked_id) continue
    missed++
    const d = String(r.from_address ?? '').split('@')[1]?.toLowerCase() ?? '(不明)'
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
  }
  console.log(`人材メール ${total} 件中、登録されなかったもの ${missed} 件（${pct(missed, total).trim()}）`)
  console.log('\n件数  送信元ドメイン')
  for (const [d, n] of [...byDomain].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${String(n).padStart(4)}  ${d}`)
  }
}

if (cmd === 'resume') {
  /**
   * 「人材メールの氏名」と「紐付いた経歴書」が同じ人かを控えだけで照合する。
   *
   *   node scripts/archive_query.mjs resume [--since YYYY-MM-DD] [--list N]
   *
   * ## 何と何を比べているか
   *
   * `resume_url` の最後の部分は **添付の元ファイル名を無害化したもの**
   * （`inbound-email` の `uploadToStorage`: `filename.replace(/[^\w.\-]/g, '_')`）。
   * **氏名から作っていない**ので、氏名と突き合わせても循環しない。
   *
   * 判定は本番と同じ `isOwnersResumeFile`（全角→半角・記号除去してから部分一致）を
   * そのまま import する。書き写すとズレる。
   *
   * ⚠ **「一致しない」は「他人の経歴書」ではない。** ファイル名が
   *   `skillsheet_20260901.xlsx` のように名前を含まない形なら、そもそも照合できない。
   *   そこを分けずに「不一致 N件」と報告すると嘘になるので3つに分ける:
   *     一致 / 名前が入っていないファイル名 / **名前が入っているのに違う**（←これが疑わしい）
   *   最後の分類の中身は、メール控えの添付を実際に開いて確かめること
   *   （`D:\akinavi-archive\mail\<日付>\<ID>\` に実ファイルがある）。
   */
  const sinceAt2 = process.argv.indexOf('--since')
  const SINCE2 = sinceAt2 >= 0 ? process.argv[sinceAt2 + 1] : null
  const listAt = process.argv.indexOf('--list')
  const LIST_N = listAt >= 0 ? Number(process.argv[listAt + 1] ?? 10) : 0

  /**
   * ファイル名に「人名らしさ」があるか。無ければ照合不能に分類する。
   *
   * ⚠ 最初に書いたときは `shared` と `edit` を人名らしいと見てしまい、
   *   「名前が入っているのに違う」を 276人と**多く見せていた**（2026-10-04）。
   *   `shared_<ハッシュ>.xlsx` は匿名の添付名、`edit` は Google Drive の URL の末尾。
   *   疑わしい件数を多く出す方向の間違いは、調べる手間をそのまま無駄にする。
   */
  const GENERIC_RE = /^(?:[-_0-9.]|skill|sheet|skillsheet|resume|cand|cv|keireki|shokumu|youin|profile|ver|copy|new|file|files|doc|docx|document|xls|xlsx|pdf|shared|share|upload|attach|attachment|data|tmp|temp|final|edit|view|usp|sharing|経歴書?|職務経歴書?|スキルシート|要員|人材|履歴書|技術者|提案|無題)+$/i
  const nameishTokens = (base) => base
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[_\-.\s]+/)
    .filter((t) => t && !/^[0-9a-f]{8,}$/i.test(t) && !/^\d+$/.test(t))

  let withResume = 0, noResume = 0, ok = 0, noNameInFile = 0, mismatch = 0, noName = 0
  let driveLink = 0, partial = 0
  /** isOwnersResumeFile と同じ正規化（全角→半角・記号除去） */
  const norm = (s) => String(s ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[.s　・_-【】()（）]/g, '')
    .toLowerCase()
  const samples = []
  // Google Drive / Docs の共有リンクはファイル名を持たない（末尾が `edit` 等）。
  // Storage に上げた添付とは別物なので、照合可否の分母から外す
  const DRIVE_RE = /(?:drive|docs)\.google\.com/i
  for (const r of rows('candidates')) {
    if (r.data_env !== 'prod') continue
    if (r.merged_into) continue
    if (SINCE2 && String(r.created_at ?? '') < SINCE2) continue
    if (!r.resume_url) { noResume++; continue }
    withResume++
    const name = String(r.name ?? '').trim()
    if (!name || name === '不明') { noName++; continue }

    if (DRIVE_RE.test(String(r.resume_url))) { driveLink++; continue }
    const base = decodeURIComponent(String(r.resume_url).split('/').pop() ?? '')
    if (isOwnersResumeFile(base, [name])) { ok++; continue }

    // 名前を含まないファイル名（`skillsheet_2026.xlsx` 等）は「不一致」ではなく照合不能
    const toks = nameishTokens(base)
    const looksNamed = toks.some((t) => !GENERIC_RE.test(t) && t.length >= 2)
    if (!looksNamed) { noNameInFile++; continue }

    /**
     * 逆向きの含有（氏名 ⊇ ファイル名の語）は**同じ人**とみなす。
     *
     * 本番の `isOwnersResumeFile` は「ファイル名が氏名を含むか」しか見ない。
     * ところが実データは逆が多い: 氏名 `樊RK` / ファイル `RK_<ハッシュ>.xlsx`、
     * 氏名 `邱 ZM` / ファイル `_ZM_<ハッシュ>.xlsx`。
     * 送信元はイニシャルだけでファイルを作り、本文には姓が書いてある。
     * ここを分けないと「疑わしい」が 113人に膨らむ（実際は部分一致・2026-10-04 実測）。
     */
    const nk = norm(name)
    if (toks.some((t) => { const k = norm(t); return k.length >= 2 && nk.includes(k) })) {
      partial++
      continue
    }

    mismatch++
    if (samples.length < (LIST_N || 8)) {
      samples.push({ name, base, co: r.from_company ?? '(不明)', at: String(r.created_at ?? '').slice(0, 10) })
    }
  }

  console.log(`prod 人材（統合されたものを除く）${withResume + noResume} 人${SINCE2 ? ` / ${SINCE2} 以降` : ''}`)
  console.log(`  経歴書が紐付いている   ${String(withResume).padStart(5)} 人  ${pct(withResume, withResume + noResume).trim()}`)
  console.log(`  紐付いていない         ${String(noResume).padStart(5)} 人`)
  console.log('')
  console.log('紐付いている人の内訳（氏名と経歴書ファイル名の照合・本番と同じ判定）')
  console.log(`  一致                       ${String(ok).padStart(5)} 人  ${pct(ok, withResume).trim()}`)
  console.log(`  ファイル名に名前が入っていない ${String(noNameInFile).padStart(5)} 人  ${pct(noNameInFile, withResume).trim()}  ←照合できない`)
  console.log(`  Google Drive の共有リンク     ${String(driveLink).padStart(5)} 人  ${pct(driveLink, withResume).trim()}  ←照合できない`)
  console.log(`  部分一致（ファイル名はイニシャル）${String(partial).padStart(5)} 人  ${pct(partial, withResume).trim()}  ←同じ人`)
  console.log(`  名前が入っているのに違う      ${String(mismatch).padStart(5)} 人  ${pct(mismatch, withResume).trim()}  ←**疑わしい**`)
  console.log(`  氏名が「不明」              ${String(noName).padStart(5)} 人  ${pct(noName, withResume).trim()}`)

  if (samples.length) {
    console.log('')
    console.log('「名前が入っているのに違う」実物')
    console.log('（ファイル名の名前が本人かは、メール控えの添付を開いて確かめること）')
    for (const s of samples) {
      console.log(`  ${s.at}  氏名: ${s.name}`)
      console.log(`              ファイル: ${s.base}`)
      console.log(`              送信元: ${s.co}`)
    }
  }
}

if (cmd === 'find') {
  /**
   * 条件で人材を引く。**本番は引かない**（2026-10-08 追加）。
   *
   *   node scripts/archive_query.mjs find [--name 氏名] [--company 社名] \
   *        [--skill C#,Java] [--pref 大阪] [--age 30-50] [--exp 5-] \
   *        [--kw リモート,自走] [--since YYYY-MM-DD] [--list N] [--dump]
   *
   * ## なぜ要るか
   * 「○○社の△△さんの経歴書はあるか」「C# で大阪の人はいるか」を調べるのに、
   * 今まで prod へ SQL を投げるしか無かった。人材は控えに全部残っているので
   * egress ゼロで答えられる。その場限りのクエリを書かないための置き場でもある。
   *
   * ⚠ **控えは prod（7日保持）より長い履歴を持つ。**「今いるか」を聞かれている
   *   ときに古い行を混ぜると、営業が連絡できない人を薦めることになる。
   *   そこで各行に **prod に残っているか（作成が7日以内か）** を必ず出し、
   *   既に消えている行は `（控えのみ）` と明示する。件数も分けて出す。
   *
   * ⚠ **スキルの一致は語境界で見る**（`src/lib/skillWordMatch.ts` と同じ文字集合）。
   *   部分一致にすると `Java` が `JavaScript` を、`C` が `C#` を食う。
   */
  const argVal = (flag) => {
    const i = process.argv.indexOf(flag)
    return i >= 0 ? (process.argv[i + 1] ?? null) : null
  }
  const NAME_Q = argVal('--name')
  /** 人材番号で引く。`--no 123` / `--no AK-000123` のどちらでも受ける */
  const NO_Q = (() => {
    const v = argVal('--no')
    if (!v) return null
    const d = String(v).replace(/[^0-9]/g, '')
    return d === '' ? null : Number(d)
  })()
  const CO_Q = argVal('--company')
  const SKILL_Q = (argVal('--skill') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const PREF_Q = argVal('--pref')
  const KW_Q = (argVal('--kw') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const SINCE_F = argVal('--since')
  const LIST_F = Number(argVal('--list') ?? 20)
  const DUMP = process.argv.includes('--dump')
  const PROSE = process.argv.includes('--prose')

  /** `--age 30-50` は **30以上50未満**。`30-` は下限のみ、`-50` は上限のみ */
  const parseRange = (s) => {
    if (!s) return null
    const m = String(s).match(/^(\d+)?-(\d+)?$/)
    if (m) return { min: m[1] ? Number(m[1]) : null, max: m[2] ? Number(m[2]) : null }
    return { min: Number(s), max: null }
  }
  const AGE_R = parseRange(argVal('--age'))
  const EXP_R = parseRange(argVal('--exp'))

  if (!NAME_Q && !NO_Q && !CO_Q && !SKILL_Q.length && !PREF_Q && !KW_Q.length && !AGE_R && !EXP_R) {
    console.error('⚠ 条件を1つも指定していない。全員出しても意味が無いので止める。')
    console.error('   例: find --no AK-000123')
    console.error('       find --company リクラシ --name TI')
    console.error('       find --skill C# --pref 大阪 --age 30-50 --kw リモート')
    process.exit(2)
  }

  // 氏名・社名の照合は記号と全角幅を落としてから部分一致（イニシャル氏名は `T・I` / `T.I` / `TI` が混在）
  const loose = (s) => String(s ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　・.,_\-【】()（）株式会社有限合同]/g, '')
    .toLowerCase()

  // 語境界つきスキル一致（skillfilter と同じ文字集合。ここを変えるなら両方変える）
  const WORD_F = 'a-zA-Z0-9#+'
  const skillRe = (s) => new RegExp(
    `(^|[^${WORD_F}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^${WORD_F}]|$)`, 'i',
  )
  const SKILL_RES = SKILL_Q.map((s) => ({ s, re: skillRe(s) }))

  /**
   * 控えの `created_at` が保持期間より古いか。保持は `candidate_retention_days`（既定7日）。
   *
   * ⚠ **これは「prod から消えている」ことの証明にはならない。**
   *   `inbound-email` は同じ人の再送を UPDATE するとき
   *   **`created_at` を now() に書き換えて7日カウントを延長する**（index.ts の
   *   「created_at をリセットして7日カウントを延長」）。控えは**初回に見た値しか持たない**
   *   ので（[[archive-has-only-creation-time-values]]）、毎日再送されている人材は
   *   控えでは「9月の行」に見えるのに prod では生きている。
   *   2026-10-08 に実際にやらかした: リクラシの TI さんを控えの created_at（9/27）だけで
   *   「prod から消えている」と判断したが、prod の created_at は 10/06 で**居た**。
   *   在否を断定したいときは prod を1行だけ引く（`sb-query.mjs`）。
   */
  const RETENTION_DAYS = 7
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10)

  // 経歴書の原本がローカル控えにあるか。D: が無い環境でも落とさない
  let resolveLocal = () => null
  try {
    const m = await import('./llm_extract/local_resume.mjs')
    resolveLocal = (url) => { try { return m.resolveLocalResume(url) } catch { return null } }
  } catch { /* 控えが読めなくても検索自体は成立する */ }

  const hits = []
  let scanned = 0
  for (const r of rows('candidates')) {
    if (r.data_env !== 'prod') continue
    if (r.merged_into) continue
    if (SINCE_F && String(r.created_at ?? '') < SINCE_F) continue
    scanned++

    if (NO_Q != null && Number(r.candidate_no) !== NO_Q) continue
    if (NAME_Q && !loose(r.name).includes(loose(NAME_Q))) continue
    if (CO_Q && !loose(r.from_company).includes(loose(CO_Q))) continue

    if (SKILL_RES.length) {
      const skillText = (Array.isArray(r.skills) ? r.skills.join(' / ') : String(r.skills ?? ''))
        + ' ' + Object.keys(r.rp_skillYears ?? {}).filter((k) => !k.startsWith('_')).join(' ')
      if (!SKILL_RES.every(({ re }) => re.test(skillText))) continue
    }

    if (PREF_Q) {
      const place = [r.rp_prefecture, r.rp_nearestStation,
        ...(Array.isArray(r.rp_availableRegions) ? r.rp_availableRegions : [])].join(' ')
      if (!place.includes(PREF_Q)) continue
    }

    const age = Number(r.rp_age)
    if (AGE_R) {
      if (!Number.isFinite(age)) continue
      if (AGE_R.min != null && age < AGE_R.min) continue
      if (AGE_R.max != null && age >= AGE_R.max) continue   // 上限は「未満」
    }
    const exp = Number(r.experience_years)
    if (EXP_R) {
      if (!Number.isFinite(exp)) continue
      if (EXP_R.min != null && exp < EXP_R.min) continue
      if (EXP_R.max != null && exp >= EXP_R.max) continue
    }

    // キーワードは本文・自己PR・担当コメントを対象にする（OR）。当たった語を出す
    let kwHit = []
    if (KW_Q.length) {
      const prose = [r.rp_text, r.rp_selfPR, r.rp_agentComment].filter(Boolean).join('\n')
      kwHit = KW_Q.filter((k) => prose.includes(k))
      if (!kwHit.length) continue
    }
    hits.push({ r, kwHit })
  }

  const inProd = hits.filter((h) => String(h.r.created_at ?? '').slice(0, 10) >= cutoff)
  console.log(`該当 ${hits.length} 人（prod 対象 ${scanned} 行を走査${SINCE_F ? ` / ${SINCE_F} 以降` : ''}）`)
  console.log(`  控えの初回登録が ${cutoff} 以降（prod にほぼ確実に居る） ${inProd.length} 人`)
  console.log(`  それより古い（**消えたとは限らない**・再送更新で生きている場合がある） ${hits.length - inProd.length} 人`)

  const order = [...hits].sort((a, b) => String(b.r.created_at ?? '').localeCompare(String(a.r.created_at ?? '')))
  for (const { r, kwHit } of order.slice(0, LIST_F)) {
    const at = String(r.created_at ?? '').slice(0, 10)
    const alive = at >= cutoff ? '' : '  （控えの初回登録が古い・prod の在否は未確認）'
    // 人材番号（控えに入っているのは 20261008_candidate_no.sql 適用後の行だけ）
    const code = r.candidate_no == null
      ? ''
      : `  AK-${String(r.candidate_no).padStart(6, '0')}`
    console.log('')
    console.log(`■ ${r.name ?? '(氏名なし)'}${code}  ${at}${alive}`)
    console.log(`   送信元: ${r.from_company ?? '(不明)'}`)
    console.log(`   年齢 ${r.rp_age ?? '-'} / 経験 ${r.experience_years ?? '-'}年 / 希望単価 ${r.desired_rate ?? '-'}`)
    console.log(`   場所: ${r.rp_prefecture ?? '-'} / 最寄 ${r.rp_nearestStation ?? '-'} / 稼働可 ${(r.rp_availableRegions ?? []).join('・') || '-'}`)
    console.log(`   商流 ${r.rp_commercialFlow ?? '-'} / 雇用 ${r.rp_employmentType ?? '-'} / リモート ${r.rp_remoteAvailable ?? '-'} / 派遣可 ${r.rp_hakenOk ?? '-'}`)
    console.log(`   役割: ${(r.rp_roles ?? []).join('・') || '-'}  到達 ${JSON.stringify(r.rp_roleLevels ?? {})}`)
    console.log(`   スキル: ${(Array.isArray(r.skills) ? r.skills : []).join(' / ') || '-'}`)
    const sy = Object.entries(r.rp_skillYears ?? {}).filter(([k]) => !k.startsWith('_'))
    if (sy.length) console.log(`   年数: ${sy.map(([k, v]) => `${k}=${v}`).join(' / ')}`)
    if (kwHit.length) console.log(`   キーワード一致: ${kwHit.join('・')}`)

    /**
     * `--prose` で担当コメントと自己PRを出す。
     *
     * ⚠ 「自走できるか」「週何日なら常駐できるか」は**列になっていない**。
     *   営業がメールに書いた一文にしか無いので、列だけ見て答えると推測になる。
     *   `--kw` が当たった語は前後も出す（どこに書かれていたかで意味が変わる）。
     */
    if (PROSE) {
      const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').slice(0, n) : null)
      if (r.rp_agentComment) console.log(`   担当コメント: ${clip(r.rp_agentComment, 300)}`)
      if (r.rp_selfPR) console.log(`   自己PR: ${clip(r.rp_selfPR, 300)}`)
      for (const k of kwHit) {
        const prose = [r.rp_text, r.rp_selfPR, r.rp_agentComment].filter(Boolean).join('\n')
        const i = prose.indexOf(k)
        console.log(`   「${k}」の前後: …${prose.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ')}…`)
      }
    }

    // ⚠ 経歴書は3経路（添付=resume_url / Box=box_url / 共有リンク=drive_url）。
    //    1つだけ見て「無い」と書かない
    const urls = [['添付', r.resume_url], ['Box', r.box_url], ['共有リンク', r.drive_url]]
      .filter(([, u]) => u)
    if (!urls.length) {
      console.log('   経歴書: **紐付いていない**（resume_url / box_url / drive_url すべて空）')
    } else {
      for (const [kind, u] of urls) {
        const base = decodeURIComponent(String(u).split('/').pop() ?? '')
        const local = resolveLocal(u)
        console.log(`   経歴書(${kind}): ${base}`)
        console.log(`       原本の控え: ${local ?? '（ローカルに無い）'}`)
      }
    }
    if (DUMP) console.log(`   [dump] ${JSON.stringify({ ...r, rp_text: undefined })}`)
  }
  if (order.length > LIST_F) console.log(`\n…他 ${order.length - LIST_F} 人（--list で増やす）`)
}

if (cmd === 'dup') {
  /**
   * 同じ人が何度も登録されていないかを控えだけで調べる。
   *
   *   node scripts/archive_query.mjs dup [--since YYYY-MM-DD] [--list N] [--company 社名]
   *
   * ## 本番の重複判定（ここを取り違えると全部無意味になる）
   *
   * 氏名一致＋スキル Jaccard ≥ 0.4 で同一人物と見たあと、本番は**送信元で分岐する**:
   *
   *   同じ会社からの再送  → **1レコードに UPDATE で統合**（行は増えない）
   *   別の会社から同じ人  → **分けて残す**（2026-08-20 ユーザー判断。同じ人でも会社で単価が違う）
   *
   * つまり**別会社の重複は仕様どおり**で、取りこぼしは「同じ会社なのに行が増えた」分だけ。
   * 会社名の正規化は本番の `normalizeAgentCompany` を import して使う（書き写すとズレる）。
   *
   * ⚠ **`duplicate_flag` では測れない。** 本番はこのフラグを**意図的に使っていない**
   *   （`fetch_candidates_for_project` が `duplicate_flag=false` で絞るため、
   *   true にするとマッチングから丸ごと消える）。控えの実測でも 8,279行すべて false。
   *   最初これを「印が付いていない＝取りこぼし243組」と書きかけた。**何も測っていない数字**だった。
   *
   * ⚠ **同じ氏名は同じ人とは限らない。** イニシャル氏名は同名が多く、prod 実測で
   *   同名10件超の氏名が52種・最大35件ある（2026-08-21）。だから件数だけでは何も言えない。
   *   年齢・性別・県・スキルの重なりを並べて、**同じ人らしい集まりだけ**を数える。
   */
  const sinceAt3 = process.argv.indexOf('--since')
  const SINCE3 = sinceAt3 >= 0 ? process.argv[sinceAt3 + 1] : null
  const listAt3 = process.argv.indexOf('--list')
  const LIST_N3 = listAt3 >= 0 ? Number(process.argv[listAt3 + 1] ?? 10) : 10
  const DETAIL = process.argv.includes('--detail')
  const coAt = process.argv.indexOf('--company')
  const CO = coAt >= 0 ? process.argv[coAt + 1] : null

  const normName = (s) => String(s ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[.\s　・,_\-【】()（）．，、]/g, '')
    .toLowerCase()

  const skillSet = (r) => new Set(
    (Array.isArray(r.skills) ? r.skills : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean),
  )
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return null          // 測れない（0 と区別する）
    let inter = 0
    for (const v of a) if (b.has(v)) inter++
    return inter / (a.size + b.size - inter)
  }

  /**
   * **保持期間の窓**。本番の人材は `candidate_retention_days`（既定7日）で消えるので、
   * 8日空いた2行は重複ではなく「消えた後の再登録」。控えは prod より長い履歴を持つため、
   * ここで切らないと**仕様どおりの再登録を取りこぼしとして数える**
   * （`skillfilter --since` で同じ間違いをしたのと同型・2026-10-04）。
   */
  const winAt = process.argv.indexOf('--window')
  const WINDOW_DAYS = winAt >= 0 ? Number(process.argv[winAt + 1] ?? 7) : 7

  /** 同じ会社の行のうち、幅 WINDOW_DAYS 日の窓に同時に存在した最大行数 */
  function maxInWindow(list) {
    const ts = list.map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => a - b)
    if (ts.length < 2) return ts.length
    const span = WINDOW_DAYS * 86400000
    let best = 1
    for (let i = 0, j = 0; i < ts.length; i++) {
      while (ts[i] - ts[j] > span) j++
      best = Math.max(best, i - j + 1)
    }
    return best
  }

  const groups = new Map()
  let people = 0, skippedBadName = 0
  for (const r of rows('candidates')) {
    if (r.data_env !== 'prod') continue
    if (r.merged_into) continue
    if (SINCE3 && String(r.created_at ?? '') < SINCE3) continue
    if (CO && !String(r.from_company ?? '').includes(CO)) continue
    const key = normName(r.name)
    if (key.length < 2) continue                 // 氏名として成立していない行は検出器⑤の担当
    // 「不明」「要員」等は氏名ではない。束ねると**別人15人が1組の重複**に見える
    // （最初これを出して、送信元が8社ばらばらの「15件の重複」を作ってしまった）
    if (badNameReasons(r.name).length) { skippedBadName++; continue }
    people++
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  // 「同じ人らしい」= 氏名が同じで、年齢と性別が一致し、スキルの重なりが本番のしきい値以上
  const SAME_THRESHOLD = 0.4
  const dupGroups = []
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    const base = list[0]
    const baseSkills = skillSet(base)
    const same = [base]
    for (const r of list.slice(1)) {
      const sameAttr = (r.rp_age ?? null) === (base.rp_age ?? null) && (r.rp_gender ?? null) === (base.rp_gender ?? null)
      const j = jaccard(baseSkills, skillSet(r))
      if (sameAttr && (j === null || j >= SAME_THRESHOLD)) same.push(r)
    }
    if (same.length < 2) continue

    // 本番と同じ軸で束ねる: 送信アドレスが同じ、または正規化した会社名が同じなら「同じ会社」
    const agentKey = (r) => normalizeAgentCompany(r.from_company) || String(r.rp_from ?? '').toLowerCase() || '(不明)'
    const byAgent = new Map()
    for (const r of same) {
      const k = agentKey(r)
      if (!byAgent.has(k)) byAgent.set(k, [])
      byAgent.get(k).push(r)
    }
    const worst = [...byAgent.values()].reduce((a, b) => (b.length > a.length ? b : a))
    const mails = new Set(same.map((r) => `${r.rp_subject}|${r.rp_received}`))
    // 1通のメールの中で同じ人が2行になっていないか（ブロック分割の不具合）
    const perMail = new Map()
    for (const r of same) {
      const k = `${r.rp_subject}|${r.rp_received}`
      perMail.set(k, (perMail.get(k) ?? 0) + 1)
    }
    dupGroups.push({
      key, name: base.name, rows: same, mails: mails.size,
      agents: byAgent.size,
      sameAgentMax: worst.length,          // 同じ会社から増えた最大行数
      windowMax: Math.max(...[...byAgent.values()].map(maxInWindow)),
      sameMailMax: Math.max(...perMail.values()),
      senders: new Set(same.map((r) => r.from_company ?? '(不明)')),
      span: [String(same[0].created_at).slice(0, 10), String(same[same.length - 1].created_at).slice(0, 10)],
      jac: same.slice(1).map((r) => jaccard(baseSkills, skillSet(r))),
    })
  }

  // 取りこぼし = 同じ会社・保持期間の窓の中で2行以上（＝本番に同時に存在していた）
  const missed = dupGroups.filter((g) => g.windowMax >= 2)
  const expired = dupGroups.filter((g) => g.windowMax < 2 && g.sameAgentMax >= 2)
  const byDesign = dupGroups.filter((g) => g.sameAgentMax < 2)
  missed.sort((a, b) => b.windowMax - a.windowMax)

  const extraRows = missed.reduce((n, g) => n + g.windowMax - 1, 0)
  const sameMail = dupGroups.filter((g) => g.sameMailMax >= 2)

  console.log(`prod 人材（統合済み・氏名が成立しない行を除く）${people} 人${SINCE3 ? ` / ${SINCE3} 以降` : ''}${CO ? ` / 送信元 ${CO}` : ''}`)
  console.log(`  氏名として成立しない行を除外   ${skippedBadName} 人`)
  console.log(`氏名が同じ集まり              ${[...groups.values()].filter((l) => l.length > 1).length} 組`)
  console.log(`うち同じ人らしい集まり          ${dupGroups.length} 組（年齢・性別一致＋スキル重なり ${SAME_THRESHOLD} 以上）`)
  console.log('')
  console.log(`本番の仕様で分けると（保持期間の窓 ${WINDOW_DAYS} 日）`)
  console.log(`  別会社から同じ人            ${byDesign.length} 組  ←**仕様どおり**（単価が会社で違うので分けて残す）`)
  console.log(`  7日の保持を過ぎた再登録      ${expired.length} 組  ←**仕様どおり**（前の行は消えている）`)
  console.log(`  同じ会社・同じ窓で行が増えた  ${missed.length} 組 / 余分 ${extraRows} 行  ←**取りこぼし**`)
  console.log(`  同じ1通のメールの中で重複    ${sameMail.length} 組  ←分割の不具合`)

  if (missed.length) {
    console.log('')
    console.log(`「同じ会社・同じ窓で増えた」多い順に ${Math.min(LIST_N3, missed.length)} 組`)
    for (const g of missed.slice(0, LIST_N3)) {
      const jac = g.jac.map((v) => (v === null ? '-' : v.toFixed(2))).join(',')
      console.log(`  窓内${String(g.windowMax).padStart(2)}件（全${g.rows.length}件・1通に最大${g.sameMailMax}件）  ${g.name}`)
      console.log(`        メール ${g.mails}通 / 会社 ${g.agents}社: ${[...g.senders].join('・')}`)
      console.log(`        ${g.span[0]}〜${g.span[1]} / スキル重なり ${jac}`)
      if (DETAIL) {
        // 登録時刻を並べる。**同じ取り込み周期に固まっていたら競合**（相手の行がまだ無い）、
        // ばらけていたら照会そのものが当たっていない。原因が分かれないと直せない
        for (const r of g.rows) {
          console.log(`          氏名「${r.name}」 登録 ${String(r.created_at ?? '').replace('T', ' ').slice(0, 19)}`
            + ` / 受信 ${String(r.rp_received ?? '-').replace('T', ' ').slice(0, 16)}`
            + ` / 駅 ${r.rp_nearestStation ?? '-'} / 県 ${r.rp_prefecture ?? '-'}`
            + ` / 経験 ${r.experience_years ?? '-'}年 / スキル${(r.skills ?? []).length}`)
        }
      }
    }
  }
}
