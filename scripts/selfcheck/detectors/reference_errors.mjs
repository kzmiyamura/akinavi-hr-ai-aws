/**
 * 検出器④「実行時に必ず壊れる参照エラー」
 *
 * Edge Function を型チェッカーに通し、**実行時に必ず例外になる種類だけ**を出す。
 *
 * ## なぜ要るか（2026-10-03）
 *
 * `inbound-email/index.ts` が `attachments` を宣言より前に読んでいて、
 * MAILER_DAEMON と OWN_DOMAIN のスキップ経路が
 * `Cannot access 'attachments' before initialization` で例外になっていた。
 * ai_logs に36件溜まっていたのに4日間誰も気付かなかった。
 *
 * 型チェッカーは TS2448 と TS2454 を**正しく出していた**。見ていなかっただけ。
 * `check-and-deploy-edge.sh` が TS2304 だけを grep していたので素通りした。
 * （そのスクリプト側も直したが、**デプロイのときしか走らない**。
 *   コードは毎日変わるので、ここでも毎晩見る。）
 *
 * ## 出さないもの
 *
 * Deno 固有のものは tsc には見えないので除く:
 *   - `TS2307` モジュール解決（`https://esm.sh/...` / `npm:...`）
 *   - `TS2304 Cannot find name 'Deno'`
 * 型の互換（TS2322 等）は既存コードに大量にあるので扱わない。
 * **ここで扱うのは「その行に到達したら必ず落ちる」ものだけ。**
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from '../lib/sources.mjs'

/** 実行時に必ず壊れるコード。増やすなら1種類ずつ、既存の出力を見てから */
const FATAL = {
  TS2304: '未定義の名前',
  TS2448: '宣言より前に使っている（TDZ）',
  TS2454: '代入される前に使っている',
  TS2552: '名前の綴り違い',
}

/** Deno 環境では正しいので無視する行 */
const DENO_NOISE = [
  /Cannot find name 'Deno'/,
  /Cannot find module 'https:\/\//,
  /Cannot find module 'npm:/,
  /Cannot find name 'EdgeRuntime'/,
]

function edgeFunctionFiles() {
  const base = join(REPO, 'supabase', 'functions')
  if (!existsSync(base)) return []
  const out = []
  for (const name of readdirSync(base)) {
    const f = join(base, name, 'index.ts')
    if (existsSync(f)) out.push({ name, file: f })
  }
  return out
}

function typeCheck(files) {
  try {
    execFileSync('npx', [
      '--no-install', 'tsc', '--noEmit', '--ignoreConfig', '--skipLibCheck',
      '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
      ...files,
    ], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    return ''
  } catch (e) {
    // エラーがあれば非ゼロで終わる。出力が欲しいので例外から取る
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

export default {
  id: 'reference-errors',
  title: '実行時に必ず壊れる参照エラー（Edge Function）',

  run() {
    const fns = edgeFunctionFiles()
    if (!fns.length) return []

    const out = typeCheck(fns.map((f) => f.file))
    // tsc が見つからない・起動に失敗したときに「エラー0件＝健康」に見せない
    if (!out.trim() && !existsSync(join(REPO, 'node_modules', 'typescript'))) {
      return [{
        key: 'tsc-missing',
        severity: 'warn',
        title: 'typescript が無いので Edge Function の参照エラーを検査できなかった',
        detail: 'npm install を済ませる。所見ゼロを「健康」と読まないこと。',
      }]
    }

    // ⚠ 指紋に行番号を入れない（上の行を編集するたびに「新規」として鳴り直すため）。
    //    代わりに**同じ種類を1件に束ね、行番号は detail に全部並べる**。
    //    束ねずに1行ずつ出すと、同じ指紋の所見が複数できて
    //    「1件を accept したら残りも黙る」ことになる（初回実行で実際に起きた）。
    const groups = new Map()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/)
      if (!m) continue
      const [, path, row, , code, msg] = m
      if (!FATAL[code]) continue
      if (DENO_NOISE.some((re) => re.test(msg))) continue
      const rel = path.replace(/\\/g, '/').replace(`${REPO.replace(/\\/g, '/')}/`, '')
      const key = `${code}:${rel}:${msg.slice(0, 60)}`
      if (!groups.has(key)) groups.set(key, { code, rel, msg, rows: [] })
      groups.get(key).rows.push(row)
    }

    return [...groups].map(([key, g]) => ({
      key,
      // その行に到達したら必ず落ちる。既存の警告より重い
      severity: 'error',
      title: `${FATAL[g.code]}: ${g.msg.slice(0, 80)}`,
      detail: `${g.rel}:${g.rows.join(', ')}（${g.code}・${g.rows.length}か所）。`
        + `到達したら必ず例外になる。型チェッカーは出していたので、見ていなかっただけ。`,
    }))
  },
}
