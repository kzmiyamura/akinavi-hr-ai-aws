#!/usr/bin/env node
/**
 * ローカル控えにあるのに本番 DB に無い人材を洗い出す SQL を生成する。
 *
 *   node scripts/archive_missing_in_db.mjs            # 直近10日ぶんの prod を対象
 *   node scripts/archive_missing_in_db.mjs --days 30
 *   node scripts/archive_missing_in_db.mjs --all      # 控えの全期間（SQL が数MBになる）
 *   node scripts/archive_missing_in_db.mjs --env all --sample 100
 *
 * 生成した SQL を流す:
 *   npx supabase db query --linked --output-format json -f <出力パス>
 *
 * ## egress を食わない理由
 *
 * 突き合わせを「行を引いてきて JS で比べる」でやると、控えの件数ぶん本番から
 * 本体を受け取ることになる（人材1件35KB・数千件で100MB超）。
 *
 * そこで**向きを逆にする**。ID の一覧は SQL 文に `VALUES` で埋めて**送る側**に回し、
 * 本番からは「居た／居ない」の**集計と少量のサンプルだけ**を受け取る。
 *
 *   送信（上り・課金対象外）  … 控えの ID 数千件ぶんの SQL 文
 *   受信（下り・egress）      … JSON 1行（数百バイト〜数KB）
 *
 * ## 「無い」を即「消えた」と読まない
 *
 * 人材は `candidate_retention_days`（既定7日）で candidates から消え、
 * `candidates_archive_light` に移る。だから控えの古い行が candidates に
 * 無いのは**正常**。このスクリプトは3つに分けて数える:
 *
 *   in_candidates     … 本番の candidates に居る
 *   in_archive_light  … 掃除済みで人材マップ側に居る（正常）
 *   in_neither        … **どちらにも居ない＝本当に失われている**
 *
 * さらに「保持期間内なのに candidates に居ない」を別建てで出す。
 * これが0でないなら掃除ではなく取りこぼし・誤削除の疑いになる。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

/** 控えの場所。archive_local.mjs と同じ既定に合わせ、db/ 配下にテーブルが並ぶ */
const ARCHIVE_DIR = resolve(
  process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'),
)

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

const ALL = has('--all')
const DAYS = Number(flag('--days', '10'))
const ENV = flag('--env', 'prod')          // prod | demo | all
const SAMPLE = Number(flag('--sample', '40'))
const RETENTION_DAYS = Number(flag('--retention', '7'))
const OUT = resolve(flag('--out', join(process.cwd(), 'scripts', 'sql', 'archive_missing_in_db.gen.sql')))

/** テーブル名の JSONL をすべて読む。控えは日次の増分なので同じ id が複数回現れる */
function* rows(table) {
  // db/<table>/ と <table>/ の両方を見る（控えの作られた時期で階層が違う）
  const dirs = [join(ARCHIVE_DIR, 'db', table), join(ARCHIVE_DIR, table)]
  const dir = dirs.find((d) => existsSync(d))
  if (!dir) {
    console.error(`控えが見つからない: ${dirs.join(' / ')}`)
    return
  }
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* 壊れた行は飛ばす */ }
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const cutoff = ALL ? null : new Date(Date.now() - DAYS * 86400_000).toISOString()

/** id → 控えの中で最も新しいスナップショット */
const local = new Map()
let scanned = 0, skippedEnv = 0, skippedOld = 0, skippedMerged = 0
for (const r of rows('candidates')) {
  scanned++
  if (!r.id || !UUID_RE.test(String(r.id))) continue
  if (ENV !== 'all' && r.data_env !== ENV) { skippedEnv++; continue }
  // merged_into が入っている行は意図的に統合された側。DB に無くて当然なので外す
  if (r.merged_into) { skippedMerged++; continue }
  const created = String(r.created_at ?? '')
  if (cutoff && created < cutoff) { skippedOld++; continue }
  const prev = local.get(r.id)
  if (!prev || String(prev.created_at ?? '') < created) local.set(r.id, r)
}

if (local.size === 0) {
  console.error('対象が0件。--days を広げるか --all を試す')
  process.exit(1)
}

// SQL 側に渡すのは id と created_at だけ。氏名や本文は送らない（PII を SQL 文に載せない）
const values = [...local.values()]
  .map((r) => `('${r.id}'::uuid,'${new Date(r.created_at).toISOString()}'::timestamptz)`)
  .join(',\n  ')

const sql = `-- 自動生成: scripts/archive_missing_in_db.mjs
-- 控え ${ARCHIVE_DIR}
-- 対象 ${local.size} 件（env=${ENV} / ${ALL ? '全期間' : `直近${DAYS}日`} / merged_into は除外）
--
-- ID の一覧は「送る側」に積んであり、本番から受け取るのは下の JSON 1行だけ。
-- in_neither が 0 でなければ、掃除ではなく**本当に失われている**人材が居る。
with local(id, created_at) as (values
  ${values}
),
j as (
  select l.id, l.created_at,
         (c.id is not null) as in_cand,
         (a.id is not null) as in_light
    from local l
    left join candidates c on c.id = l.id
    left join candidates_archive_light a on a.id = l.id
)
select json_build_object(
  'local_total',       (select count(*) from local),
  'in_candidates',     (select count(*) from j where in_cand),
  'in_archive_light',  (select count(*) from j where in_light and not in_cand),
  'in_neither',        (select count(*) from j where not in_cand and not in_light),
  -- 保持期間内（${RETENTION_DAYS}日）なのに candidates に無い＝掃除では説明できない
  'recent_missing',    (select count(*) from j
                         where not in_cand
                           and created_at > now() - interval '${RETENTION_DAYS} days'),
  -- どちらにも居ない行を日別に。偏りがあれば原因の当たりがつく
  'neither_by_day',    (select json_object_agg(d, n) from (
                          select to_char(created_at,'MM-DD') d, count(*) n from j
                           where not in_cand and not in_light
                           group by 1 order by 1 desc limit 30) q),
  -- 現物を見るための ID サンプル（氏名は返さない）
  'neither_sample',    (select json_agg(id) from (
                          select id from j where not in_cand and not in_light
                           order by created_at desc limit ${SAMPLE}) q),
  'recent_missing_sample', (select json_agg(id) from (
                          select id from j
                           where not in_cand
                             and created_at > now() - interval '${RETENTION_DAYS} days'
                           order by created_at desc limit ${SAMPLE}) q)
) as j;
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, sql, 'utf8')

const kb = (Buffer.byteLength(sql) / 1024).toFixed(0)
console.log(`控え: ${ARCHIVE_DIR}`)
console.log(`走査 ${scanned} 行 → 対象 ${local.size} 件（env違い ${skippedEnv} / 期間外 ${skippedOld} / 統合済み ${skippedMerged} を除外）`)
console.log(`出力: ${OUT}  (${kb}KB・これは"送る"側なので egress には乗らない)`)
console.log('')
console.log('次:')
console.log(`  npx supabase db query --linked --output-format json -f "${OUT}"`)
