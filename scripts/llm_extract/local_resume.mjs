/**
 * 経歴書をローカル控えから読む（Storage から落とし直さない）。2026-09-26
 *
 * ■ なぜ
 *   AI校正の egress の84%は経歴書のダウンロードだった（実測 156KB/件・約29MB/日）。
 *   だが同じファイルは `D:\akinavi-archive\mail` に原本ごと控えてある。
 *   メールは15分おきに3フォルダ（受信トレイ・削除済み・迷惑メール）から控えており、
 *   添付は無条件に全部保存している。引き直す理由がない。
 *
 * ■ 突き合わせの鍵は内容ハッシュ
 *   Storage のファイル名は inbound-email の `stableResumeName()` が付ける:
 *       `{名前}_{sha256Hex(dataB64).slice(0,20)}.{拡張子}`
 *   `dataB64` は Graph の contentBytes（標準base64・改行なし）。
 *   控えは復号後のバイト列なので **base64 に戻してから sha256** を取れば同じ値になる。
 *   内容ハッシュなので、ファイル名も送信元も違ってよい。同じ中身なら必ず当たる。
 *
 * ■ 当たらない分は今までどおり Storage から落とす
 *   実測の命中率は72%（2026-09-26・直近7日1,810件）。外れるのは主に
 *   **メール添付ではなくリンク（Google Drive 等）から取った経歴書**で、
 *   そもそもローカルに存在しない。だから100%にはならないし、する必要もない。
 *
 * ■ 索引は増分で更新する
 *   全件走査は 1.5GB / 105秒かかる。毎サイクル回せないので、
 *   **一度ハッシュしたファイルは覚えておき、新しいものだけ**を足す。
 *   これでワーカーのサイクル先頭から呼んでも数百ミリ秒で済む。
 *
 * ■ 壊れても止めない
 *   D: が見えない・索引が壊れている・控えが消えている、いずれの場合も
 *   例外を投げずに「当たらなかった」として扱う。Storage への退避が必ず残る。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'

export const ARCHIVE_ROOT = process.env.AKINAVI_ARCHIVE_MAIL ?? 'D:/akinavi-archive/mail'

const INDEX_NAME = '_resume_index.json'
const SEEN_NAME = '_resume_index_seen.json'

/** 控えの管理ファイルと原本メールは経歴書ではない */
const SKIP_NAMES = new Set(['message.json', 'message.msg'])

/** inbound-email が Storage に上げうる拡張子。ここに無いものは索引に入れない */
const RESUME_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.docx', '.doc', '.pdf', '.csv', '.ods'])

/**
 * Storage の URL からファイル名の内容ハッシュ（20桁）を取り出す。
 * 取れなければ null（＝ローカルとは突き合わせられない）。
 */
export function extractStorageHash(url) {
  if (!url || typeof url !== 'string') return null
  let name
  try { name = decodeURIComponent(url) } catch { name = url }
  const m = name.match(/_([0-9a-f]{20})\.[A-Za-z0-9]+(?:\?.*)?$/)
  return m ? m[1] : null
}

/** Storage 側と同じ手順でハッシュを作る。base64 文字列そのものを sha256 して先頭20桁 */
export function hashFileBytes(buf) {
  return createHash('sha256').update(buf.toString('base64')).digest('hex').slice(0, 20)
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

/** 書きかけの索引を読ませない。一時ファイルに書いてから置き換える */
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(obj), 'utf8')
  renameSync(tmp, path)
}

function walk(dir, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, out); continue }
    if (e.name.startsWith('_') || SKIP_NAMES.has(e.name)) continue
    if (!RESUME_EXT.has(extname(e.name).toLowerCase())) continue
    out.push(p)
  }
  return out
}

/** 控えは日付フォルダ（YYYY-MM-DD）で分かれている。増分のときは新しい方だけ見る */
function dateDirs(root, sinceDays) {
  let names
  try { names = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const dirs = names.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
  if (sinceDays == null) return dirs.map((e) => join(root, e.name))
  const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10)
  return dirs.filter((e) => e.name >= cutoff).map((e) => join(root, e.name))
}

let cache = null          // { index, mtimeKey }

/**
 * 索引を最新にする。既にハッシュ済みのファイルは読み直さない。
 * @param {object} opts
 * @param {number|null} opts.sinceDays  この日数ぶんの日付フォルダだけ見る（null で全件）
 * @param {string} opts.root
 * @returns {{indexed:number, added:number, scanned:number, ms:number}|null} 失敗時 null
 */
export function refreshLocalResumeIndex({ sinceDays = 3, root = ARCHIVE_ROOT } = {}) {
  const t0 = Date.now()
  if (!existsSync(root)) return null
  const indexPath = join(root, INDEX_NAME)
  const seenPath = join(root, SEEN_NAME)
  const index = readJson(indexPath, {})
  const seenList = readJson(seenPath, [])
  const seen = new Set(Array.isArray(seenList) ? seenList : [])

  let added = 0, scanned = 0
  for (const dir of dateDirs(root, sinceDays)) {
    for (const f of walk(dir, [])) {
      const rel = relative(root, f)
      scanned++
      if (seen.has(rel)) continue
      let buf
      // 控えを取っている最中のファイルは読めないことがある。次回に回す（seen に入れない）
      try { buf = readFileSync(f) } catch { continue }
      index[hashFileBytes(buf)] = rel
      seen.add(rel)
      added++
    }
  }

  if (added > 0) {
    try {
      writeJsonAtomic(indexPath, index)
      writeJsonAtomic(seenPath, [...seen])
    } catch { /* 書けなくても索引はメモリ上で使える。次回に持ち越す */ }
  }
  cache = { index, root }
  return { indexed: Object.keys(index).length, added, scanned, ms: Date.now() - t0 }
}

/**
 * Storage の URL に対応するローカルの実ファイルを返す。無ければ null。
 * **絶対に例外を投げない。** 呼び側は null のとき Storage から落とす。
 */
export function resolveLocalResume(url, { root = ARCHIVE_ROOT } = {}) {
  const hash = extractStorageHash(url)
  if (!hash) return null
  if (!cache || cache.root !== root) {
    const index = readJson(join(root, INDEX_NAME), null)
    if (!index) return null
    cache = { index, root }
  }
  const rel = cache.index[hash]
  if (!rel) return null
  const abs = join(root, rel)
  // 控えが消えていることがある（人が消した・ドライブが外れた）。実在を必ず確かめる
  return existsSync(abs) ? abs : null
}

/** テスト用。読み込み済みの索引を捨てる */
export function _resetCache() { cache = null }
