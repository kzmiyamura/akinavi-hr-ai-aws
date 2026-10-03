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
const FLAGS_WITH_VALUE = new Set(['--sample', '--dir', '--since'])
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

const COMMANDS = ['summary', 'daily', 'company', 'rate', 'skillfilter', 'missed']
if (!COMMANDS.includes(cmd)) {
  console.error(`⚠ 知らないサブコマンド: ${cmd}`)
  console.error(`   使えるのは: ${COMMANDS.join(' | ')}`)
  console.error('   rate [スキル]        経験年数帯ごとの希望単価の分布')
  console.error('   skillfilter [スキル,...]  本文マッチが絞り込みに足している人数')
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
  const top = Number(posArg(0) ?? 15)
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
