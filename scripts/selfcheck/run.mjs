#!/usr/bin/env node
/**
 * 夜間健診。**ローカル控えとリポジトリのソースだけを読む。egress ゼロ・トークンゼロ。**
 *
 *   node scripts/selfcheck/run.mjs              # 新規の所見だけ出す（既定）
 *   node scripts/selfcheck/run.mjs --all        # baseline を無視して全部出す
 *   node scripts/selfcheck/run.mjs --json       # 機械向け（claude -p に渡す形）
 *   node scripts/selfcheck/run.mjs --accept "理由"  # 今出ている新規を baseline に入れる
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
import { withFingerprints, diffAgainstBaseline, exitCodeFor, acceptInto } from './lib/diff.mjs'
import { archiveDir } from './lib/archive.mjs'

import deadMachinery from './detectors/dead_machinery.mjs'
import promisedFlags from './detectors/promised_flags.mjs'
import errorVisibility from './detectors/error_visibility.mjs'

const DETECTORS = [deadMachinery, promisedFlags, errorVisibility]

const HERE = import.meta.dirname
const BASELINE = join(HERE, 'baseline.json')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const SHOW_ALL = has('--all')
const AS_JSON = has('--json')
const SHOW_STALE = has('--stale')
const acceptAt = argv.indexOf('--accept')
const ACCEPT_WHY = acceptAt >= 0 ? argv[acceptAt + 1] : null

function loadBaseline() {
  if (!existsSync(BASELINE)) return {}
  try { return JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { return {} }
}

const findings = []
const crashed = []
for (const d of DETECTORS) {
  try {
    findings.push(...withFingerprints(d, d.run()))
  } catch (e) {
    // 検出器が落ちたのを静かに飲むと「所見ゼロ＝健康」に見える。一番やってはいけない
    crashed.push({ id: d.id, error: `${e?.message ?? e}`.slice(0, 300) })
  }
}

const baseline = loadBaseline()
const { fresh, known, stale } = diffAgainstBaseline(findings, SHOW_ALL ? {} : baseline)

if (ACCEPT_WHY) {
  if (!fresh.length) { console.log('新規の所見が無いので baseline は変えない') }
  else {
    const next = acceptInto(baseline, fresh, ACCEPT_WHY, new Date().toISOString().slice(0, 10))
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    console.log(`baseline に ${fresh.length} 件入れた: ${ACCEPT_WHY}`)
  }
  process.exitCode = 0
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
    console.log(`   指紋: ${f.fp}`)
  }
  if (!fresh.length && !crashed.length) console.log('\n新規の所見なし。')
  process.exitCode = exitCodeFor({ fresh, crashed })
}
