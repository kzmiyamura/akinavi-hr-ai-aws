/**
 * ソースを読むための共通部品。**リポジトリの中だけを読む。本番は引かない。**
 *
 * 夜間健診（scripts/selfcheck/run.mjs）の検出器が共有する。
 * egress ゼロ・トークンゼロで回ることが前提なので、ここに外部通信を足さないこと。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** リポジトリのルート（このファイルは scripts/selfcheck/lib/ にある） */
export const REPO = resolve(import.meta.dirname, '..', '..', '..')

/**
 * 歩かないディレクトリ。
 * `scripts/testData` は PII で git 管理外、`_extractors.gen.mjs` は自動生成なので
 * 「コメントだけのフラグ」などを数えても意味がない。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.claude', '.vercel', '.vite', 'testData', '.temp',
])

const SKIP_FILES = new Set(['_extractors.gen.mjs', 'station_data.json', 'package-lock.json'])

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql'])
const DOC_EXT = new Set(['.md'])

function walk(dir, out) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

let _cache = null

/**
 * リポジトリ内の全ファイルを1回だけ読んでキャッシュする。
 * 検出器が3つとも同じファイル群を見るので、毎回歩くと3倍かかる。
 *
 * @returns {{path: string, rel: string, ext: string, kind: 'code'|'doc'|'other', text: string}[]}
 */
export function allFiles() {
  if (_cache) return _cache
  const out = []
  for (const full of walk(REPO, [])) {
    const dot = full.lastIndexOf('.')
    const ext = dot < 0 ? '' : full.slice(dot).toLowerCase()
    const kind = CODE_EXT.has(ext) ? 'code' : DOC_EXT.has(ext) ? 'doc' : 'other'
    if (kind === 'other') continue
    let text
    try { text = readFileSync(full, 'utf8') } catch { continue }
    // 生成物を外すための上限。
    // ⚠ **inbound-email/index.ts が既に 821KB ある。** 1MB にしていると、
    //    この一番大事なファイルが育った日に黙って検査対象から外れる
    //    （「保険が機能していない」のいつもの形）。余裕を持たせる。
    if (text.length > 4_000_000) continue
    out.push({ path: full, rel: relative(REPO, full).split(sep).join('/'), ext, kind, text })
  }
  _cache = out
  return out
}

/** 拡張子でもパスの前方一致でも絞れる取り出し口 */
export function filesUnder(prefix) {
  return allFiles().filter((f) => f.rel.startsWith(prefix))
}

/**
 * コメントだけを取り出す。
 *
 * ⚠ 完全な字句解析ではない。文字列リテラルの中の `//` もコメント扱いになりうる。
 *    「コメントが約束しているのに実装が無い」を探す用途では、取りこぼすより
 *    多めに拾って baseline で落とす方が安全なのでこれで足りる。
 */
export function commentsOf(text, ext) {
  const parts = []
  if (ext === '.sql') {
    for (const m of text.matchAll(/--[^\n]*/g)) parts.push(m[0])
    for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) parts.push(m[0])
  } else {
    for (const m of text.matchAll(LINE_COMMENT_RE)) parts.push(m[0])
    for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) parts.push(m[0])
  }
  return parts
}

/**
 * 行コメント。**`://` をコメント開始と見ないこと。**
 * `https://sheets.googleapis.com/...` の `//` でコメント扱いすると、
 * **その行の残りが実装として見えなくなる**。初回実行で
 * `INSERT_ROWS`（URL の中の API 定数）が「コメントにしか無い」と誤検出された。
 */
const LINE_COMMENT_RE = /(?<!:)\/\/[^\n]*/g

/** コメントを取り除いた本体。識別子が「実装として」存在するかを見るのに使う */
export function stripComments(text, ext) {
  if (ext === '.sql') {
    return text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  }
  return text.replace(LINE_COMMENT_RE, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** 行番号（findings に「どこ」を書くため。1 始まり） */
export function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++
  return n
}

/** 正規表現の特殊文字を潰す */
export function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
