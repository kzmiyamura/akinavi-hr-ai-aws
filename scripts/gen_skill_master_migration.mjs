#!/usr/bin/env node
/**
 * git のどこにも無い skill_master の行を、マイグレーションに起こす。2026-09-28
 *
 *   node scripts/gen_skill_master_migration.mjs                      # 調べるだけ
 *   node scripts/gen_skill_master_migration.mjs --out supabase/migrations/20260928_seed_skill_master_manual.sql
 *
 * ■ なぜ要るか
 *   `scripts/add_skill.mjs` はコマンドから skill_master に行を足せる（POST）。
 *   足した行はコミット済みファイルのどこにも残らないので、**本番にしか存在しない**。
 *   Supabase を Free に落とすと自動バックアップが無くなるため、
 *   その状態で行を壊すと戻す先が無い。git に入れておけばいつでも戻せる。
 *
 * ■ 判定の仕方
 *   **印では見分けられない。** `add_skill.mjs` は source に 'seed' を書くので、
 *   マイグレーションが入れた行と区別が付かない。
 *   created_at とマイグレーションの日付を突き合わせる手もあるが、
 *   UTC と JST で1日ずれるため当てにならない。
 *   そこで「その名前が **skill_master への INSERT/UPDATE 文の中に** 出てくるか」で見る。
 *   出てくれば git から復元できる＝起こす必要が無い。
 *   （日付での突き合わせとこの方法は、2026-09-28 時点でどちらも26行で一致した）
 *
 * ■ egress を使わない
 *   本番は引かない。ローカル控え（archive_masters.mjs が撮ったスナップショット）
 *   だけを読む。控えが無ければ先に `node scripts/archive_masters.mjs` を回すこと。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const OUT = outArg >= 0 ? args[outArg + 1] : null
const dirArg = args.indexOf('--dir')
const ARCHIVE = dirArg >= 0 ? args[dirArg + 1]
  : (process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))

const SNAPSHOT = join(ARCHIVE, 'masters', 'skill_master.jsonl')

/** 生成物の目印。これが入っているファイルは「git にあるか」の判定から除く。 */
export const GENERATED_MARK =
  '-- add_skill.mjs で手で足され、git のどこにも残っていなかった skill_master の行。'

// テストから import できるよう、実際に動くのは直接叩かれたときだけにする。
// これが無いと、判定関数を読むだけで控えを探して process.exit してしまう。
const IS_CLI = import.meta.url === `file:///${(process.argv[1] ?? '').replace(/\\/g, '/')}`

/**
 * コミット済みの .sql から **skill_master へ INSERT している部分だけ** を集める。
 *
 * ⚠ ファイル全体を文字列検索してはいけない。
 *   最初そうしたら「社内SE」が `20260916_role_pdm_sre_joushisu.sql` の
 *   **役割テーブル**への INSERT に当たり、skill_master に入っていないのに
 *   「git にある」と誤判定した。監査クエリやコメントにも名前は出てくる。
 *   INSERT 文の範囲（`INSERT INTO skill_master` から次の `;` まで）に絞る。
 */
export function extractSkillMasterStatements(text) {
  const parts = []
  for (const re of [/INSERT\s+INTO\s+(?:public\.)?skill_master\b/gi,
                    // 別名だけを後から足している UPDATE も「git にある」根拠になる
                    /UPDATE\s+(?:public\.)?skill_master\b/gi]) {
    let m
    while ((m = re.exec(text)) !== null) {
      const end = text.indexOf(';', m.index)
      parts.push(text.slice(m.index, end === -1 ? text.length : end))
    }
  }
  return parts.join('\n')
}

function readCommittedSkillInserts() {
  const parts = []
  for (const dir of ['supabase/migrations', 'scripts/sql']) {
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.sql')) continue
      let text
      try { text = readFileSync(join(dir, n), 'utf8') } catch { continue }
      // ⚠ 自分が過去に生成したファイルを読むと、全部「git にある」ことになり
      //    次回から0件になる（2026-09-28 に実際にそうなった）。印を見て飛ばす。
      //    --out の指定有無に関わらず効くよう、ファイル名ではなく中身で判定する。
      if (text.includes(GENERATED_MARK)) continue
      parts.push(extractSkillMasterStatements(text))
    }
  }
  return parts.join('\n')
}

/** スキル名がコミット済みの SQL に「行として」出てくるか。
 *
 *  SQL の値は必ず単引用符なので `'Cisco'` の形だけを探す。
 *  （素の部分一致にすると `Java` が `JavaScript` に当たる）
 *
 *  ⚠ 二重引用符 `"Cisco"` を混ぜてはいけない。
 *    別名は `'["単体テスト","UAT",...]'::jsonb` のように **jsonb 文字列の中**で
 *    二重引用符に挟まれて現れる。混ぜると「UAT」が
 *    スキル『テスト』の別名に当たり、独立した行として git にあると誤判定する
 *    （2026-09-28 に実際に取りこぼした）。
 *    コミット済みファイルは別名をすべて jsonb で書いており、
 *    `ARRAY['...']` 形式は1件も無いことを確認済み。 */
export function isRecoverableFromGit(name, statements) {
  return statements.includes(`'${name}'`)
}

if (IS_CLI) {
  if (!existsSync(SNAPSHOT)) {
    console.error(`控えがありません: ${SNAPSHOT}`)
    console.error('先に node scripts/archive_masters.mjs を回してください。')
    process.exit(1)
  }
  const rows = readFileSync(SNAPSHOT, 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))

  const committed = readCommittedSkillInserts()

  const inCommitted = (name) => isRecoverableFromGit(name, committed)

  const missing = rows.filter((r) => !inCommitted(r.name))

  console.log(`控えの skill_master : ${rows.length} 行`)
  console.log(`git に見当たらない  : ${missing.length} 行`)
  console.log('')
  for (const r of missing) {
    console.log(`  ${r.name}  [${r.category}]  一致${r.match_count ?? 0}回  別名${(r.aliases ?? []).length}件`)
  }

  if (!OUT) {
    console.log('')
    console.log('--out <ファイル> を付けるとマイグレーションを書き出します。')
    process.exit(0)
  }
  if (missing.length === 0) {
    console.log('\n起こすものがありません。')
    process.exit(0)
  }

  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const lines = missing.map((r) =>
    `  (${q(r.id)}, ${q(r.name)}, ${q(r.category)}, ${q(JSON.stringify(r.aliases ?? []))}::jsonb, ` +
    `${q(r.source ?? 'seed')}, ${r.is_generic ? 'true' : 'false'})`)

  // ⚠ このテンプレートリテラルの中は字下げしないこと。
  //    中身がそのまま .sql になるので、字下げすると SQL 側に紛れ込む。
  const sql = `${GENERATED_MARK}
-- scripts/gen_skill_master_migration.mjs が本番の控えから生成（${new Date().toISOString().slice(0, 10)}）。
--
-- なぜ要るか:
--   これらは**本番にしか存在しなかった**。Supabase を Free に落とすと
--   自動バックアップが無くなるので、壊したときに戻す先が無い。
--   git に入れておけば、控えが無くてもここから戻せる。
--
-- 実際に効いている行である（生成時点の一致回数）:
${missing.map((r) => `--   ${r.name} … ${r.match_count ?? 0}回`).join('\n')}
--
-- ⚠ 既にある行には触らない。
--   skill_master は**既存行を編集する**のが鉄則で、同じ意味の行を新しく作ると
--   正式名を奪って一致が壊れる（実績: 該当者が28人→1人）。
--   name に一意制約があるので ON CONFLICT DO NOTHING で素通りさせる。
--   match_count / last_matched_at は実行時に積み上がる値なので入れない。

INSERT INTO skill_master (id, name, category, aliases, source, is_generic) VALUES
${lines.join(',\n')}
ON CONFLICT (name) DO NOTHING;

-- 別名で引く辞書（マテリアライズドビュー）を貼り直す。
-- これをしないと、行はあるのに一致判定に出てこない。
REFRESH MATERIALIZED VIEW skill_norm_map;
`

  writeFileSync(OUT, sql, 'utf8')
  console.log(`\n書き出しました: ${OUT}（${missing.length} 行）`)
}
