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
 * ■ Box 由来はこちらから控えを作る（2026-10-04 追加）
 *   Box 取込（`box_fetch.mjs`）はメモリに持った buf をそのまま inbound-email に
 *   POST するだけで**ディスクに書いていなかった**。メール控えは Outlook の添付からしか
 *   作られないので、Box 由来は**必ずミス**する。控え実測で `box_url` ありの prod 人材44人・
 *   `resume_url` ありの35人は**全員ローカルに原本が無かった**（最古 2026-09-06）。
 *   しかも `cleanup-storage` が `resumes/` を7日で消すので、7日経つと原本は Box にしか無い。
 *   そこで取得した時点で `D:\akinavi-archive\box` に書き（`storeLocalResume`）、
 *   読む側は mail → box の順に探す。ハッシュは内容由来なので索引を歩く必要はなく、
 *   書いた時点で直接登録できる。
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
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'

export const ARCHIVE_ROOT = process.env.AKINAVI_ARCHIVE_MAIL ?? 'D:/akinavi-archive/mail'
/** Box など「メールに添付されていない経歴書」の控え先。ここは**このワーカーが書く** */
export const BOX_ROOT = process.env.AKINAVI_ARCHIVE_BOX ?? 'D:/akinavi-archive/box'

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

/** root ごとに索引を1つ持つ（mail と box を同時に使う） */
const caches = new Map()  // root -> index オブジェクト

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
  caches.set(root, index)
  return { indexed: Object.keys(index).length, added, scanned, ms: Date.now() - t0 }
}

/** その root の索引を返す（無ければ null）。ディスクは1度だけ読む */
function indexOf(root) {
  if (caches.has(root)) return caches.get(root)
  const index = readJson(join(root, INDEX_NAME), null)
  if (index) caches.set(root, index)
  return index
}

function lookupIn(root, hash) {
  const index = indexOf(root)
  const rel = index?.[hash]
  if (!rel) return null
  const abs = join(root, rel)
  // 控えが消えていることがある（人が消した・ドライブが外れた）。実在を必ず確かめる
  return existsSync(abs) ? abs : null
}

/**
 * Storage の URL に対応するローカルの実ファイルを返す。無ければ null。
 * **絶対に例外を投げない。** 呼び側は null のとき Storage から落とす。
 *
 * メール控え → Box 控えの順に探す。件数はメールが圧倒的なので順序はこのまま
 * （2026-10-04 実測: メール添付 1,993ファイル / Box 由来 44人）。
 */
export function resolveLocalResume(url, { root = ARCHIVE_ROOT, boxRoot = BOX_ROOT } = {}) {
  const hash = extractStorageHash(url)
  if (!hash) return null
  return lookupIn(root, hash) ?? (boxRoot ? lookupIn(boxRoot, hash) : null)
}

/**
 * メールに添付されていない経歴書（Box 等）をローカル控えに書き、索引に登録する。
 *
 * 呼ぶのは**取得した直後**。Storage は7日で消えるので、ここで書かないと原本が
 * どこにも残らない（`cleanup-storage` の `storage_retention_days`）。
 *
 * ハッシュは内容から作るので、`inbound-email` が Storage に付ける名前と必ず一致する
 * ＝走査せずに索引へ直接入れられる。**絶対に例外を投げない**（控えに失敗しても
 * 取り込み自体は続ける。読む側は Storage へ退避できる）。
 *
 * @returns {{path:string, hash:string, bytes:number, existed:boolean}|null}
 */
export function storeLocalResume(buf, filename, { root = BOX_ROOT, now = new Date() } = {}) {
  try {
    if (!buf || !buf.length) return null
    const ext = extname(String(filename ?? '')).toLowerCase()
    // inbound-email が経歴書として Storage に上げない形式は控えても使えない
    if (!RESUME_EXT.has(ext)) return null
    const hash = hashFileBytes(buf)
    const day = now.toISOString().slice(0, 10)
    const safe = String(filename).replace(/[^\w.\-]/g, '_')
    const rel = join(day, `${hash}_${safe}`)
    const abs = join(root, rel)
    const existed = existsSync(abs)
    if (!existed) {
      mkdirSync(join(root, day), { recursive: true })
      writeFileSync(abs, buf)
    }
    const index = indexOf(root) ?? {}
    index[hash] = rel
    caches.set(root, index)
    try { writeJsonAtomic(join(root, INDEX_NAME), index) } catch { /* 索引が書けなくてもファイルは残る */ }
    return { path: abs, hash, bytes: buf.length, existed }
  } catch {
    return null
  }
}

/** テスト用。読み込み済みの索引を捨てる */
export function _resetCache() { caches.clear() }
