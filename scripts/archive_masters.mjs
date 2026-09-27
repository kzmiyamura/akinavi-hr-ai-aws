#!/usr/bin/env node
/**
 * 「作り直せない表」をまるごと控える（スナップショット）。2026-09-28
 *
 *   node scripts/archive_masters.mjs --dry-run   # 件数と転送見込みだけ
 *   node scripts/archive_masters.mjs             # 取得して保存
 *   node scripts/archive_masters.mjs --include-secrets   # トークンも控える（既定は伏せる）
 *
 * ■ なぜ archive_local.mjs と別なのか
 *   あちらは**増えるだけの表**（candidates / ai_logs）を追記で貯める作りで、
 *   「どこまで取ったか」を watermark に持つ。
 *   こちらが対象にするのは **書き換わる小さい表**で、行が編集・削除される。
 *   追記では削除が追えないので、**毎回まるごと撮り直して世代で残す**。
 *
 * ■ なぜ今必要か（2026-09-28）
 *   Supabase を Pro から Free に落とすと **バックアップが無くなる**
 *   （Pro は日次7日分）。人材は7日で消える設計なので失っても痛くないが、
 *   下の表は消えると作り直せない。特に skill_master は手で育てたもので、
 *   マッチングのスキル一致判定の土台そのもの。
 *
 * ■ 秘密の扱い
 *   `app_config` には Microsoft の refresh token（`graph_rt_*`）が入っている。
 *   **既定では値を伏せる。** 平文でディスクに残す方が事故が大きく、
 *   トークンは Microsoft 再連携でいつでも取り直せるため、控える価値が低い。
 *   それでも要るなら `--include-secrets`。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ENV_PATH = join(homedir(), '.akinavi_shadow.env')

/**
 * 控える表と、ページングに使う並び順の列。
 * **PostgREST は1000行で黙って切る**ので、必ず並び順を固定して offset で回す。
 * 並び順が無いと、ページの境目で行が重複したり抜けたりする。
 */
export const MASTER_TABLES = [
  // 手で育てた辞書。消すとスキル一致判定が壊れる（マッチングの土台）
  { table: 'skill_master', order: 'id' },
  // 別名では表せない包含関係（MySQL→SQL 等）。これも手作り。
  // この表に id 列は無い（child, parent, note, created_at）
  { table: 'skill_implications', order: 'child' },
  // ── ここには入れないもの ────────────────────────────────
  // station_master（12,666行・1.7MB）
  //   git に2重に入っている: 20260527_add_station_master.sql ほかのマイグレーションと、
  //   Edge Function に同梱している station_data.json（861KB・全件）。
  //   毎日1.7MB引く価値がない（月51MB）。2026-09-28 に外した。
  // candidates_archive_light（19,871行・13.9MB）
  //   増えるだけの表なので archive_local.mjs の増分取得に移した（月417MB→ほぼゼロ）。
  // 営業が画面で作ったもの。どこにも他に無い
  { table: 'notification_rules', order: 'id' },
  // 設定一式。トークンは既定で伏せる（下の maskSecrets 参照）
  { table: 'app_config', order: 'key' },
  // 派遣・紹介会社の免許情報。厚労省サイトを引き直すのは重い
  { table: 'agent_companies', order: 'domain' },
  // 提案履歴。261行・300KB と小さく、しかも **status が後から書き換わる**
  // （pending → sent → accepted）。増分では状態変化を追えないので毎回撮り直す。
  { table: 'submissions', order: 'id' },
]

/** 値を伏せる app_config のキー。Microsoft の refresh token と、それを含む復旧用リンク */
const SECRET_KEY_RE = /(^|_)graph_rt(_|$)|token|secret|password/i

function maskSecrets(table, rows) {
  if (table !== 'app_config') return { rows, masked: 0 }
  let masked = 0
  const out = rows.map((r) => {
    if (!SECRET_KEY_RE.test(String(r.key ?? ''))) return r
    masked++
    // 「あった」ことは残す。復旧時に再連携が要ると分かるようにするため
    return { ...r, value: '<伏せた・Microsoft再連携で取り直す>' }
  })
  return { rows: out, masked }
}

function loadEnv(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) {
    console.error(`env ファイルを読めません: ${path}\n${e.message}`); process.exit(1)
  }
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const PAGE = 1000  // PostgREST の既定上限。これ以上を一度に頼んでも黙って切られる

/** 本体を受け取らずに件数だけ数える。
 *  select する列は表ごとの並び順の列を使う。`id` 決め打ちにすると
 *  主キーが違う表（agent_companies は domain）で 400 になる。 */
async function countRows(base, key, table, orderCol) {
  const res = await fetch(`${base}/rest/v1/${table}?select=${orderCol}&limit=1`, {
    method: 'HEAD',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
  })
  if (!res.ok) throw new Error(`${table} count HTTP ${res.status}`)
  return Number((res.headers.get('content-range') || '').split('/')[1])
}

/** 1表まるごと引く。1000行で切られるので必ずページングする */
async function fetchAll(base, key, { table, order }) {
  const rows = []
  let bytes = 0
  for (let offset = 0; ; offset += PAGE) {
    const url = `${base}/rest/v1/${table}?select=*&order=${order}.asc&limit=${PAGE}&offset=${offset}`
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) throw new Error(`${table} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const text = await res.text()
    bytes += Buffer.byteLength(text)
    const page = JSON.parse(text)
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return { rows, bytes }
}

/** 古い世代を間引く。直近 keep 世代だけ残す */
function pruneHistory(dir, keep) {
  let files
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() } catch { return 0 }
  const drop = files.slice(0, Math.max(0, files.length - keep))
  for (const f of drop) { try { unlinkSync(join(dir, f)) } catch { /* ignore */ } }
  return drop.length
}

export async function run({ dir, dryRun = false, includeSecrets = false, keep = 7 } = {}) {
  const env = loadEnv(ENV_PATH)
  const base = env.SUPABASE_URL
  const key = env.SUPABASE_SERVICE_KEY
  if (!base || !key) { console.error('env に SUPABASE_URL / SUPABASE_SERVICE_KEY がありません'); process.exit(1) }

  const root = join(dir, 'masters')
  const day = new Date().toISOString().slice(0, 10)
  if (!dryRun) mkdirSync(root, { recursive: true })

  let totalRows = 0, totalBytes = 0, totalMasked = 0
  for (const t of MASTER_TABLES) {
    try {
      if (dryRun) {
        const n = await countRows(base, key, t.table, t.order)
        console.log(`  ${t.table.padEnd(26)} ${String(n).padStart(6)} 行`)
        totalRows += n
        continue
      }
      const { rows, bytes } = await fetchAll(base, key, t)
      const { rows: safe, masked } = includeSecrets ? { rows, masked: 0 } : maskSecrets(t.table, rows)
      totalMasked += masked

      const body = safe.map((r) => JSON.stringify(r)).join('\n') + '\n'
      // 最新版。復旧のときはこれを見る
      writeFileSync(join(root, `${t.table}.jsonl`), body, 'utf8')
      // 世代。直すつもりが壊した、を巻き戻せるようにする
      const histDir = join(root, 'history', t.table)
      mkdirSync(histDir, { recursive: true })
      writeFileSync(join(histDir, `${day}.jsonl`), body, 'utf8')
      const pruned = pruneHistory(histDir, keep)

      totalRows += rows.length
      totalBytes += bytes
      const note = masked ? `・${masked}件は値を伏せた` : ''
      const pn = pruned ? `・古い世代${pruned}件を削除` : ''
      console.log(`  ${t.table.padEnd(26)} ${String(rows.length).padStart(6)} 行 ${(bytes / 1024).toFixed(0)}KB${note}${pn}`)
    } catch (e) {
      // 1表が失敗しても他は控える。全部落とす方が危ない
      console.error(`  ${t.table.padEnd(26)} 失敗: ${String(e).slice(0, 160)}`)
    }
  }

  if (dryRun) {
    console.log(`\n合計 ${totalRows} 行（--dry-run のため転送していません）`)
  } else {
    console.log(`\n合計 ${totalRows} 行 / 受信 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
    if (totalMasked) {
      console.log(`※ ${totalMasked} 件のトークンは値を伏せました。復旧時は Microsoft 再連携が要ります`)
      console.log('   （値ごと控えるなら --include-secrets。平文で残るので既定にはしていません）')
    }
  }
  return { totalRows, totalBytes }
}

// 直接叩かれたときだけ実行する（archive_local.mjs からは import して呼ぶ）
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2)
  const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null
  const dir = resolve(dirArg ?? process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))
  console.log(`控え先: ${join(dir, 'masters')}`)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await run({
    dir,
    dryRun: args.includes('--dry-run'),
    includeSecrets: args.includes('--include-secrets'),
  })
}
