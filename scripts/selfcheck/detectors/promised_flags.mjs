/**
 * 検出器②「約束だけのフラグ」
 *
 * コメントやドキュメントが「このフラグで切り替えられる」と書いているのに、
 * **そのフラグを読むコードが存在しない**ものを出す。
 *
 * ## これで捕れた実際のバグ（2026-10-03）
 *
 * `inbound-email/index.ts` の先頭コメントに
 *   `INBOUND_RELEVANCE_CHECK: false で事前の無関係メール判定を無効化（既定は true）`
 * と書いてあったが、**判定も環境変数の読み取りも存在しなかった**。
 * そのため国税庁を騙るフィッシングが人材として登録されていた。
 * コメントは実装の証拠にならない。
 *
 * もう一つ同じ病気がある: CLAUDE.md が `email_classify_enabled` を挙げていたが
 * 「そのキーを読むコードは無い」（正しくは `email_use_ai_classification`）。
 * 設定キーも同じ検出器で見る。
 */

import { allFiles, commentsOf, stripComments, lineOf } from '../lib/sources.mjs'

/**
 * 大文字スネークの識別子。`_` を1つ以上要求して HTTP / JSON / UTF などの
 * 単独略語を落とす（それらは設定フラグではない）。
 */
const TOKEN_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

/**
 * フラグではないと分かっているもの。
 * **ここに足すのは「そういう名前の概念が外にある」場合だけ。**
 * 「実装が無いけど今は直せない」は baseline.json 側に理由付きで入れる。
 */
const NOT_A_FLAG = new Set([
  'CONTENT_TYPE', 'USER_AGENT', 'CACHE_CONTROL', 'SERVICE_ROLE', 'ANON_KEY',
  'ON_CONFLICT', 'ORDER_BY', 'GROUP_BY', 'PRIMARY_KEY', 'FOREIGN_KEY', 'NOT_NULL',
  'IF_EXISTS', 'IF_NOT_EXISTS', 'CREATE_TABLE', 'ALTER_TABLE', 'ON_DELETE',
  'NO_COLOR', 'TO_DO', 'AS_OF', 'README_MD', 'CLAUDE_MD', 'HANDOFF_MD',
  'AS_400', 'OS_390', 'SJIS_WIN', 'UTF_8', 'ISO_8859',
])

/**
 * ランタイムが投げるエラーコードの接頭辞。
 * 「このエラーが出る」と書いたコメントは約束ではないので除く
 * （1回目の実行で ERR_MODULE_NOT_FOUND / UV_HANDLE_CLOSING を拾った）。
 */
const RUNTIME_CODE_PREFIX = /^(?:ERR_|UV_|EAI_|ENOENT|ECONN|ETIMEDOUT|PGRST)/

/** 実装側に `<何か>_<tok>` があるか（接頭辞を省いて書かれた同じもの） */
function suffixOfImplemented(tok, implemented) {
  for (const impl of implemented) {
    if (impl.length > tok.length && impl.endsWith(`_${tok}`)) return true
  }
  return false
}

/** CLAUDE.md の app_config 表から設定キーを拾う（`|` 区切りの行の最初のバッククォート） */
function documentedConfigKeys() {
  const md = allFiles().find((f) => f.rel === 'CLAUDE.md')
  if (!md) return []
  const sec = md.text.split('### app_config')[1]
  if (!sec) return []
  const table = sec.split(/\n##[^#]/)[0]
  const keys = []
  for (const line of table.split('\n')) {
    if (!line.startsWith('|')) continue
    const m = line.match(/^\|\s*~*`([a-z][a-z0-9_]{3,})`/)
    if (m) keys.push({ key: m[1], struck: line.includes('~~'), line })
  }
  return keys
}

export default {
  id: 'promised-flags',
  title: '約束だけのフラグ（コメント・ドキュメントにしか存在しない切り替え）',

  run() {
    const files = allFiles()
    const findings = []

    // --- 実装側に出てくる全トークン（コメントを除いた本体） ---
    const implemented = new Set()
    // 小文字スネークで実在する識別子。文章では大文字で書かれることがあるので
    // 同一視する（`AUTO_MATCH_ENABLED` と `auto_match_enabled` は同じものを指す）
    const implementedLower = new Set()
    for (const f of files) {
      if (f.kind !== 'code') continue
      const body = stripComments(f.text, f.ext)
      for (const m of body.matchAll(TOKEN_RE)) implemented.add(m[0])
      for (const m of body.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) implementedLower.add(m[0])
    }

    // --- コメント／ドキュメントにしか無いトークン ---
    const promised = new Map()   // token -> {rel, line, kind}
    for (const f of files) {
      const chunks = f.kind === 'doc'
        ? [{ s: f.text, at: 0 }]
        : commentsOf(f.text, f.ext).map((c) => ({ s: c, at: f.text.indexOf(c) }))
      for (const ch of chunks) {
        for (const m of ch.s.matchAll(TOKEN_RE)) {
          const tok = m[0]
          if (NOT_A_FLAG.has(tok) || implemented.has(tok)) continue
          if (RUNTIME_CODE_PREFIX.test(tok)) continue
          if (implementedLower.has(tok.toLowerCase())) continue
          if (tok.length < 8) continue
          // 文書では接頭辞を省いて書かれる（`VITE_AI_PROVIDER` を `AI_PROVIDER` と）。
          // 実装側に `…_<tok>` があるなら同じものを指している
          if (suffixOfImplemented(tok, implemented)) continue
          // `HANDOFF_EXCEL_VERIFICATION.md` のようなファイル名は約束ではない
          if (/^\.(?:md|txt|json|sql|ts|mjs)\b/i.test(ch.s.slice(m.index + tok.length))) continue
          if (!promised.has(tok)) promised.set(tok, { rel: f.rel, line: lineOf(f.text, ch.at + m.index), kind: f.kind })
        }
      }
    }

    for (const [tok, w] of [...promised].sort()) {
      findings.push({
        key: `comment-only:${tok}`,
        // コードのコメントが約束しているほうが危ない（読んだ人が実装済みだと信じる）
        severity: w.kind === 'code' ? 'warn' : 'info',
        title: `${tok} は ${w.kind === 'code' ? 'コメント' : '文書'}にしか存在しない`,
        detail: `${w.rel}:${w.line}。この名前を読む実装がリポジトリに無い。`
          + `実装するか、約束している文を消すか、どちらか。`,
      })
    }

    // --- CLAUDE.md が挙げている app_config キーを読むコードがあるか ---
    const literals = new Set()
    for (const f of files) {
      if (f.kind !== 'code') continue
      for (const m of stripComments(f.text, f.ext).matchAll(/['"`]([a-z][a-z0-9_]{3,})['"`]/g)) literals.add(m[1])
    }
    for (const { key, struck } of documentedConfigKeys()) {
      if (struck) continue            // 取り消し線＝もう読まないと明記済み
      if (literals.has(key)) continue
      findings.push({
        key: `config-key-unread:${key}`,
        severity: 'warn',
        title: `app_config の '${key}' は CLAUDE.md にあるが、読むコードが無い`,
        detail: `設定画面で値を変えても何も起きない。キー名の誤記か、実装前の記載。`
          + `（前例: email_classify_enabled は email_use_ai_classification の誤記だった）`,
      })
    }

    return findings
  },
}
