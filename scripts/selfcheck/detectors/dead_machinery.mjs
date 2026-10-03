/**
 * 検出器①「死んだ機構」
 *
 * コードに状態値や旗はあるのに、**それを拾う経路が無い**／**実データに一度も現れない**
 * ものを出す。人間が画面を見ないと気付けなかった類のバグを、控えとソースだけで捕る。
 *
 * ## これで捕れた実際のバグ（2026-10-03）
 *
 * - `boxQueue()` が `box_status=eq.pending` しか引かないので、`failed` に落ちた行が
 *   **二度と再試行されない**。`BOX_MAX_ATTEMPTS` / `BOX_RETRY_AFTER_MIN` /
 *   `box_tried_at` / `isPermanentBoxFailure` が丸ごと死んでいた
 * - `duplicate_flag` が prod 4,441 行で **1件も立っていない**（同名+同駅の塊は363組ある）
 *
 * ## 判定の作り
 *
 * 1. `known`    … コードがその列に入れうる値（代入・オブジェクト・SQL の CHECK から）
 * 2. `consumed` … コードがその列で**絞り込んでいる**値（PostgREST の eq./in.、=== 比較）
 * 3. `known ∖ consumed` → **書くが誰も拾わない**
 * 4. 控えの分布と突き合わせ、`known` にあるのに実データ 0 件のものを出す
 * 5. 旗（boolean）は true が 0 件なら出す
 *
 * ⚠ 字句解析ではないので取り違えはある。**所見は「質問」であって断定ではない。**
 *    違ったら baseline.json に入れて黙らせる（理由を書くこと）。
 */

import { allFiles, esc, lineOf } from '../lib/sources.mjs'
import { loadTable, prodOnly, distribution, hasField } from '../lib/archive.mjs'

/**
 * 見張る列。**ここに足すのが検出器を増やす一番安い方法。**
 *
 * - `flag: true`  … boolean 列（true が立つかだけを見る）
 * - `queue: true` … **後で誰かが拾う前提の列**。「書くが拾われない」を見るのはここだけ。
 *   記録専用の列（`ai_logs.status` のような済んだ事実のログ）は書いたら終わりなので、
 *   拾う経路が無くて当たり前。区別しないと 87,158 件の `success` が所見になって
 *   本物が埋もれる（実際に1回目の実行で起きた）。
 */
const TRACKED = [
  {
    column: 'box_status',
    label: 'Box 取り込みの状態',
    table: 'candidates',
    queue: true,
    // 空振りを避けるため、その列を触るファイルだけに絞る
    scope: ['scripts/llm_extract/', 'supabase/functions/', 'src/'],
  },
  {
    column: 'license_status',
    label: '派遣・紹介免許の判定',
    table: 'agent_companies',
    queue: true,   // 判定を間違えるとその会社の人材が派遣案件から丸ごと消える
    scope: ['scripts/', 'supabase/', 'src/'],
  },
  {
    column: 'status',
    label: 'AI 呼び出しログの状態',
    table: 'ai_logs',
    // 記録専用。拾い直す経路は要らない
    scope: ['scripts/llm_extract/', 'supabase/functions/'],
  },
  { column: 'duplicate_flag', label: '重複の旗', table: 'candidates', flag: true, scope: ['src/', 'supabase/', 'scripts/'] },
  { column: 'bookmarked', label: 'ブックマーク', table: 'candidates', flag: true, scope: ['src/', 'supabase/'] },
]

/** 値として扱わない語（真偽値・null・変数っぽいもの） */
const NOT_A_STATE = new Set(['true', 'false', 'null', 'undefined', '', 'eq', 'in', 'is', 'not'])

function inScope(rel, scope) {
  return !scope || scope.some((p) => rel.startsWith(p))
}

/** コードがその列に入れうる値 */
function collectKnown(column, scope) {
  const hits = new Map()   // 値 -> [{rel, line}]
  const c = esc(column)
  const pats = [
    // JS/TS: `box_status: 'failed'` / `box_status = "done"`
    new RegExp(`\\b${c}\\s*[:=]\\s*['"\`]([^'"\`]{1,40})['"\`]`, 'g'),
    // PostgREST の書き込みではなく更新パラメータ: `.update({ box_status: 'x' })` は上で拾う
    // SQL: CHECK (box_status IN ('a','b'))  /  DEFAULT 'pending'
    new RegExp(`\\b${c}\\b[^\\n;]{0,80}?\\bIN\\s*\\(([^)]{1,200})\\)`, 'gi'),
    new RegExp(`\\b${c}\\b[^\\n;]{0,80}?\\bDEFAULT\\s+'([^']{1,40})'`, 'gi'),
  ]
  for (const f of allFiles()) {
    if (f.kind !== 'code' || !inScope(f.rel, scope)) continue
    if (!f.text.includes(column)) continue
    for (const re of pats) {
      for (const m of f.text.matchAll(re)) {
        for (const raw of String(m[1]).split(',')) {
          const v = raw.trim().replace(/^['"`]|['"`]$/g, '').trim()
          if (!v || NOT_A_STATE.has(v) || /[${}]/.test(v)) continue
          if (!hits.has(v)) hits.set(v, [])
          hits.get(v).push({ rel: f.rel, line: lineOf(f.text, m.index) })
        }
      }
    }
  }
  return hits
}

/** コードがその列で絞り込んでいる値 */
function collectConsumed(column, scope) {
  const out = new Set()
  const c = esc(column)
  const pats = [
    // PostgREST: `box_status=eq.pending` / `box_status=in.(pending,failed)` / `box_status=not.is.null`
    new RegExp(`${c}=eq\\.([^&'"\`\\s)]{1,40})`, 'g'),
    new RegExp(`${c}=in\\.\\(([^)]{1,200})\\)`, 'g'),
    new RegExp(`${c}=neq\\.([^&'"\`\\s)]{1,40})`, 'g'),
    // supabase-js: `.eq('box_status', 'pending')` / `.in('box_status', ['a','b'])`
    new RegExp(`\\.eq\\(\\s*['"\`]${c}['"\`]\\s*,\\s*['"\`]([^'"\`]{1,40})['"\`]`, 'g'),
    new RegExp(`\\.in\\(\\s*['"\`]${c}['"\`]\\s*,\\s*\\[([^\\]]{1,200})\\]`, 'g'),
    // JS 比較: `box_status === 'failed'` / `'failed' === box_status`
    new RegExp(`\\b${c}\\s*[!=]==?\\s*['"\`]([^'"\`]{1,40})['"\`]`, 'g'),
    new RegExp(`['"\`]([^'"\`]{1,40})['"\`]\\s*[!=]==?\\s*\\b${c}\\b`, 'g'),
    // switch/case や配列メンバシップ: `['pending','failed'].includes(box_status)`
    new RegExp(`\\[([^\\]]{1,200})\\]\\s*\\.includes\\(\\s*[\\w.?]*\\b${c}\\b`, 'g'),
    // SQL の WHERE 比較
    new RegExp(`\\b${c}\\s*=\\s*'([^']{1,40})'`, 'g'),
  ]
  for (const f of allFiles()) {
    if (f.kind !== 'code' || !inScope(f.rel, scope)) continue
    if (!f.text.includes(column)) continue
    for (const re of pats) {
      for (const m of f.text.matchAll(re)) {
        for (const raw of String(m[1]).split(',')) {
          const v = raw.trim().replace(/^['"`]|['"`]$/g, '').trim()
          if (!v || NOT_A_STATE.has(v) || /[${}]/.test(v)) continue
          out.add(v)
        }
      }
    }
  }
  return out
}

export default {
  id: 'dead-machinery',
  title: '死んだ機構（書くが拾われない状態・一度も立たない旗）',

  run() {
    const findings = []

    for (const t of TRACKED) {
      const rows = loadTable(t.table)
      const prod = rows ? prodOnly(rows) : null
      const observable = rows ? hasField(rows, t.column) : false
      const dist = observable ? distribution(prod, t.column) : null

      // --- 控えがこの列を持っていない＝そもそも測れない。これ自体が所見 ---
      if (rows && !observable) {
        findings.push({
          key: `unobservable:${t.table}.${t.column}`,
          severity: 'info',
          title: `控えに ${t.table}.${t.column} が無く、死んでいるか確かめられない`,
          detail: `${t.label}。archive_local.mjs の select に ${t.column} を足せば、`
            + `以後この列は egress ゼロで検査できる。`,
        })
      }

      if (t.flag) {
        // --- 旗が一度も立っていない ---
        if (dist) {
          const on = (dist.get('true') ?? 0)
          const total = prod.length
          if (total >= 200 && on === 0) {
            findings.push({
              key: `never-set:${t.table}.${t.column}`,
              severity: 'warn',
              title: `${t.label}（${t.column}）が prod ${total} 行で1件も立っていない`,
              detail: `立てるコードはあるのに実データが0件。条件が厳しすぎるか、`
                + `立てる経路に到達していない。分布: ${fmt(dist)}`,
            })
          }
        }
        continue
      }

      const known = collectKnown(t.column, t.scope)
      const consumed = collectConsumed(t.column, t.scope)
      if (known.size === 0) continue

      // --- ① 書くが誰も拾わない状態（拾う前提の列だけ） ---
      for (const [v, where] of (t.queue ? known : [])) {
        if (consumed.has(v)) continue
        const seen = dist?.get(v) ?? 0
        findings.push({
          key: `unconsumed:${t.table}.${t.column}=${v}`,
          severity: seen > 0 ? 'warn' : 'info',
          title: `${t.column}='${v}' を書くコードはあるが、この値で絞り込む経路が無い`,
          detail: `${t.label}。${where.slice(0, 3).map((w) => `${w.rel}:${w.line}`).join(' / ')}`
            + `${dist ? `。控えの実データ: ${seen} 件` : '。控えで未確認'}`
            + `。その状態に落ちた行を拾い直す処理が無いなら、そこで止まったままになる。`,
        })
      }

      // --- ② コードにあるのに実データに1件も無い状態 ---
      if (dist && prod.length >= 200) {
        for (const [v, where] of known) {
          if ((dist.get(v) ?? 0) > 0) continue
          if (!consumed.has(v)) continue   // ①で出しているので重複させない
          findings.push({
            key: `absent-in-data:${t.table}.${t.column}=${v}`,
            severity: 'info',
            title: `${t.column}='${v}' は prod ${prod.length} 行に1件も無い`,
            detail: `${t.label}。${where.slice(0, 2).map((w) => `${w.rel}:${w.line}`).join(' / ')}`
              + `。到達不能な分岐か、もう使っていない状態名。`,
          })
        }
      }
    }

    return findings
  },
}

function fmt(dist) {
  return [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, n]) => `${k}=${n}`).join(', ')
}
