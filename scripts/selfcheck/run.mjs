#!/usr/bin/env node
/**
 * 夜間健診。**ローカル控えとリポジトリのソースだけを読む。egress ゼロ・トークンゼロ。**
 *
 *   node scripts/selfcheck/run.mjs              # 新規の所見だけ出す（既定）
 *   node scripts/selfcheck/run.mjs --all        # baseline を無視して全部出す
 *   node scripts/selfcheck/run.mjs --json       # 機械向け（claude -p に渡す形）
 *   node scripts/selfcheck/run.mjs --accept "理由"  # 今出ている新規を baseline に入れる
 *   node scripts/selfcheck/run.mjs --accept "理由" --fp <指紋の一部>
 *                                               # **その所見だけ**を理由付きで入れる
 *   node scripts/selfcheck/run.mjs --stale      # 直ったので消せる baseline を出す
 *
 * 終了コード: 0=新規なし / 1=新規あり / 2=検出器が落ちた
 *
 * ## なぜ要るか
 *
 * 2026-10-03 に、人が画面を見るだけで**その日のうちに6件**のバグが見つかった
 * （失敗した box 取り込みが二度と再試行されない／重複の旗が4,441行で1件も立たない／
 * コメントだけの無関係メール判定／会社名が「ご担当者」／フィッシングが人材として登録／
 * 23歳に「相場75万 -25」）。検出器は scripts/audit_*.mjs に20本あったが、
 * **13本が prod を引く**ので日常的に回せず、誰も走らせていなかった。
 *
 * 足りないのは検出する力ではなく「控えで回る・自分で起きる・差分だけ鳴る」の3つ。
 *
 * ## 検出器を増やすとき
 *
 * **人が見つけたバグは、直して終わりにせず「そのクラスを捕る検出器」に変える。**
 * そうしないと同じ病気を別の場所で繰り返す（実績あり）。
 * 所見は断定ではなく質問。違ったら baseline.json に理由付きで入れて黙らせる。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { withFingerprintsChecked, diffAgainstBaseline, exitCodeFor, acceptInto } from './lib/diff.mjs'
import { archiveDir } from './lib/archive.mjs'

import deadMachinery from './detectors/dead_machinery.mjs'
import promisedFlags from './detectors/promised_flags.mjs'
import errorVisibility from './detectors/error_visibility.mjs'
import referenceErrors from './detectors/reference_errors.mjs'
import badNames from './detectors/bad_names.mjs'

const DETECTORS = [deadMachinery, promisedFlags, errorVisibility, referenceErrors, badNames]

const HERE = import.meta.dirname
const BASELINE = join(HERE, 'baseline.json')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const SHOW_ALL = has('--all')
const AS_JSON = has('--json')
const SHOW_STALE = has('--stale')
const acceptAt = argv.indexOf('--accept')
const ACCEPT_WHY = acceptAt >= 0 ? argv[acceptAt + 1] : null
/**
 * `--fp <指紋の一部>` で、受け入れる所見を1つに絞る。
 *
 * ⚠ **理由は所見ごとに違う。** 絞れないと「全部まとめて同じ理由」になり、
 *   後から読んだ人がどの所見にどの根拠が付いていたのか分からなくなる
 *   （baseline の値は `why` しか無い）。
 */
const fpAt = argv.indexOf('--fp')
const ACCEPT_FP = fpAt >= 0 ? argv[fpAt + 1] : null

function loadBaseline() {
  if (!existsSync(BASELINE)) return {}
  try { return JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { return {} }
}

const findings = []
const crashed = []
const dupes = []
for (const d of DETECTORS) {
  try {
    const r = withFingerprintsChecked(d, d.run())
    findings.push(...r.findings)
    dupes.push(...r.dupes)
  } catch (e) {
    // 検出器が落ちたのを静かに飲むと「所見ゼロ＝健康」に見える。一番やってはいけない
    crashed.push({ id: d.id, error: `${e?.message ?? e}`.slice(0, 300) })
  }
}

const baseline = loadBaseline()
const { fresh, known, stale } = diffAgainstBaseline(findings, SHOW_ALL ? {} : baseline)

if (ACCEPT_WHY) {
  const target = ACCEPT_FP ? fresh.filter((f) => f.fp.includes(ACCEPT_FP)) : fresh
  if (!fresh.length) {
    console.log('新規の所見が無いので baseline は変えない')
  } else if (!target.length) {
    // 指紋の打ち間違いで「何も入らなかったのに成功」に見せない
    console.error(`⚠ --fp "${ACCEPT_FP}" に当たる新規の所見が無い。今出ているのは:`)
    for (const f of fresh) console.error(`   ${f.fp}`)
    process.exitCode = 2
  } else {
    const next = acceptInto(baseline, target, ACCEPT_WHY, new Date().toISOString().slice(0, 10))
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    console.log(`baseline に ${target.length} 件入れた: ${ACCEPT_WHY}`)
    for (const f of target) console.log(`   ${f.fp}`)
  }
  if (process.exitCode === undefined) process.exitCode = 0
} else if (AS_JSON) {
  console.log(JSON.stringify({ fresh, crashed, counts: { fresh: fresh.length, known: known.length, stale: stale.length } }, null, 2))
  process.exitCode = exitCodeFor({ fresh, crashed })
} else {
  const dir = archiveDir()
  console.log(`夜間健診（検出器 ${DETECTORS.length} 本・egress ゼロ）`)
  console.log(`控え: ${dir ?? '**見つからない**（archive_local.mjs を先に走らせる）'}`)
  console.log(`所見 ${findings.length} 件 → 新規 ${fresh.length} / 既知 ${known.length} / 直った ${stale.length}`)

  if (crashed.length) {
    console.log('')
    console.log('⚠ 検出器が落ちた（所見ゼロを健康と読まないこと）')
    for (const c of crashed) console.log(`  ${c.id}: ${c.error}`)
  }

  if (dupes.length) {
    console.log('')
    console.log(`⚠ 指紋が重複した所見を ${dupes.length} 件落とした（検出器側で束ねること）`)
    for (const fp of [...new Set(dupes)].slice(0, 5)) console.log(`  ${fp}`)
  }

  if (SHOW_STALE) {
    console.log('')
    console.log(stale.length ? '直ったので baseline から消せる:' : '消せる baseline は無い')
    for (const fp of stale) console.log(`  ${fp}  （理由: ${baseline[fp]?.why ?? '-'}）`)
  }

  const mark = { error: '🔴', warn: '🟡', info: '⚪' }
  for (const f of fresh) {
    console.log('')
    console.log(`${mark[f.severity] ?? '⚪'} [${f.detector}] ${f.title}`)
    console.log(`   ${f.detail}`)
    // 一度「直した」として黙らせたものが再発した＝直っていなかった、か別の経路。
    // 新規と同じ扱いで埋もれさせないよう、再発であることを明記する
    if (f.recurredSince) {
      console.log(`   ⚠ **再発**。${f.recurredSince} までで黙らせたが、それより新しい発生がある。`)
      console.log(`      黙らせた理由: ${baseline[f.fp]?.why ?? '-'}`)
    }
    console.log(`   指紋: ${f.fp}`)
  }
  if (!fresh.length && !crashed.length) console.log('\n新規の所見なし。')
  process.exitCode = exitCodeFor({ fresh, crashed })
}
