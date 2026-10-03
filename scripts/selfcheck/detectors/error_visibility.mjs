/**
 * 検出器⑥「エラーが見えているか」
 *
 * エラーは出ているのに**誰も読まない・読めない**状態を出す。2つの向きで見る。
 *
 * ## A. 控えに溜まっているエラーの種類（データ側）
 *
 * `ai_logs.error_message` を文面で正規化して種類別に数える。**新しい種類が出た夜に鳴る。**
 * これを書いた日（2026-10-03）に直近5日で2種類20件が溜まっていた:
 *   - `候補者保存エラー: unsupported Unicode escape sequence`（12件）
 *   - `Cannot access 'attachments' before initialization`（8件）
 * どちらも人材が**保存されずに消えている**のに、画面に出ないので誰も気付いていなかった。
 *
 * ## B. 原因より先に可変長の値が来る組み立て（コード側）
 *
 * `String(e).slice(0, 300)` で切って保存しているのに、例外の文面が
 * `${長いURL} -> ${status}` の順だと、**切られて原因だけが消える**。
 * 実際 box 取り込みの失敗が全部 `->` で終わっており、4日間ステータスが読めなかった。
 * 切り詰める側と組み立てる側の両方が揃って初めてバグになるので、両方を見る。
 */

import { allFiles, lineOf } from '../lib/sources.mjs'
import { loadTable } from '../lib/archive.mjs'

/**
 * 文面から可変部分を落として「種類」にする。
 * これが指紋になるので、**同じ病気で毎晩鳴らないために**しっかり潰す。
 */
export function normalizeMessage(msg) {
  return String(msg ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    // ⚠ 引用符の中身を無条件に潰すと、**別の変数の同じ型のバグが同じ指紋になる**。
    //    `Cannot access 'attachments'` と `'supportedAttachments'` が1件に見えて、
    //    2件目が永久に鳴らなくなる（このテストで実際に捕まえた）。
    //    識別子らしいものは原因の一部なので残す。潰すのはデータらしい長い文字列だけ。
    .replace(/(['"`])([^'"`]{0,200})\1/g, (m, _q, inner) => (
      /^[A-Za-z_$][\w$]*$/.test(inner) || inner.length <= 24 ? m : '<str>'
    ))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** エラーらしい式に対する切り詰め。この長さ以下なら「原因が消えうる」 */
const TRUNCATE_RE = /\b(?:String\(\s*(?:e|err|error|ex)\s*\)|(?:e|err|error|ex)\.message|(?:e|err|error|ex)\?\.message)\s*\.(?:slice|substring)\(\s*0\s*,\s*(\d{1,4})\s*\)/g

/** 原因が先に来ていると認める語 */
const DIAGNOSTIC_RE = /\b(?:status|HTTP|code|errno|reason|statusText)\b/i

/**
 * 「長くなりうる値」らしい式。
 * 問題になるのは**先頭が長い値**のときだけ。`${table}` のような短い定数が先にあっても
 * 300文字を食い潰さないので所見にしない（1回目の実行で8件の誤検出を出した）。
 */
const LONG_VALUE_RE = /\b(?:path|pathq|url|uri|query|qs|body|text|html|sql|subject|payload|json|params|resp(?:onse)?)\b|await\s/i

export default {
  id: 'error-visibility',
  title: 'エラーが溜まっているのに読まれていない／切られて読めない',

  run() {
    const findings = []

    // ================= A. 控えのエラー種別 =================
    const logs = loadTable('ai_logs')
    if (logs) {
      const byKind = new Map()
      for (const r of logs) {
        if (!r.error_message) continue
        const k = normalizeMessage(r.error_message)
        if (!k) continue
        if (!byKind.has(k)) byKind.set(k, { n: 0, sample: String(r.error_message).slice(0, 200), last: r.created_at, type: r.type })
        const e = byKind.get(k)
        e.n++
        if (r.created_at && (!e.last || r.created_at > e.last)) e.last = r.created_at
      }
      for (const [kind, e] of [...byKind].sort((a, b) => b[1].n - a[1].n)) {
        findings.push({
          key: `ai-log-error:${kind}`,
          // 保存に失敗している＝人材がそのまま消えている。他のエラーより重い
          severity: /保存エラー|before initialization|null|undefined is not/i.test(kind) ? 'error' : 'warn',
          title: `ai_logs にエラーが ${e.n} 件溜まっている: ${kind.slice(0, 70)}`,
          detail: `最後に出たのは ${e.last ?? '不明'}（type=${e.type ?? '?'}）。`
            + `実物: ${JSON.stringify(e.sample.slice(0, 120))}。`
            + `保存に失敗したメールは人材として入らず、メールも7日で消えるので取り返せない。`,
        })
      }
    } else {
      findings.push({
        key: 'archive-missing:ai_logs',
        severity: 'info',
        title: '控えに ai_logs が無く、溜まっているエラーを数えられない',
        detail: 'node scripts/archive_local.mjs を先に走らせる。',
      })
    }

    // ================= B. 切り詰めと組み立ての順序 =================
    const truncators = []
    for (const f of allFiles()) {
      if (f.kind !== 'code') continue
      for (const m of f.text.matchAll(TRUNCATE_RE)) {
        const n = Number(m[1])
        if (n > 1000) continue
        truncators.push({ rel: f.rel, line: lineOf(f.text, m.index), n })
      }
    }

    for (const f of allFiles()) {
      if (f.kind !== 'code') continue
      // `throw new Error(`…`)` のテンプレートリテラルだけを見る
      for (const m of f.text.matchAll(/new Error\(\s*`([^`]{1,400})`/g)) {
        const tpl = m[1]
        const first = tpl.indexOf('${')
        if (first < 0) continue
        const head = tpl.slice(0, first)
        // 先頭がほぼ即・補間で始まり、原因語はその後ろにしか無い
        if (head.replace(/\s+/g, '').length > 12) continue
        if (DIAGNOSTIC_RE.test(head)) continue
        if (!DIAGNOSTIC_RE.test(tpl.slice(first))) continue
        // 最初の補間そのものが原因（`${res.status} …`）なら順序は正しい
        const firstExpr = tpl.slice(first + 2, tpl.indexOf('}', first))
        if (DIAGNOSTIC_RE.test(firstExpr)) continue
        // 先頭の値が短い定数なら切り詰めの害が無い
        if (!LONG_VALUE_RE.test(firstExpr)) continue
        const near = truncators.filter((t) => t.rel === f.rel)
        findings.push({
          key: `message-order:${f.rel}:${lineOf(f.text, m.index)}`,
          severity: near.length ? 'warn' : 'info',
          title: `例外の文面が可変長の値から始まり、原因がその後ろにある`,
          detail: `${f.rel}:${lineOf(f.text, m.index)} — \`${tpl.slice(0, 70)}\`。`
            + (near.length
              ? `同じファイルで slice(0, ${near[0].n}) して保存しているので、`
                + `値が長いと原因が切り落とされる（box 取り込みで実際に起きた）。`
              : `今は切り詰めていないが、保存するようになると原因が消える。`)
            + ` ステータスを先・長い値を後ろにする。`,
        })
      }
    }

    return findings
  },
}
