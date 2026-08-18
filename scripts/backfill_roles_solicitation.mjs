#!/usr/bin/env node
// backfill_roles_solicitation.mjs — 営業定型文に由来する役割を既存データから取り除く（2026-08-17）
//
// 背景: 「以下要員以外にも多数 …ヘルプデスク,キッティング等 エンジニアがおります」という
// 売り込み文を本人の役割として拾っていた（stripAgentSolicitation で修正済み）。
// 修正は新着にしか効かないので、既存人材を洗い直す。
//
// 安全策:
//  ・**役割を減らすだけ**。増やさない。判定は「定型文を消すと消える役割」の差分のみ
//  ・複数人材メール由来は対象外（raw_profile.text がメール全文なので再計算すると悪化する）
//  ・本文＋添付テキスト（attachmentText）の両方を見る。添付由来の役割は消さない
//  ・既定はドライラン。--run で書き込む
//
// 使い方:
//   node scripts/backfill_roles_solicitation.mjs            # 何が変わるか見るだけ
//   node scripts/backfill_roles_solicitation.mjs --run      # 実際に更新
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { scoreProseRoles, stripAgentSolicitation } from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }
const APPLY = process.argv.includes('--run')
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

/** 対象の id 一覧（複数人材メールを除く）。SQL 側で絞って id だけ受け取る */
const idsFile = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
if (!idsFile) {
  console.error('使い方: node scripts/backfill_roles_solicitation.mjs <ids.json> [--run]')
  console.error('  ids.json は scripts/sql/list_role_backfill_targets.sql の出力（id の配列）')
  process.exit(1)
}
// PowerShell 5.1 の Out-File は UTF-8 BOM 付きで書くため、先頭の BOM を落とす
const ids = JSON.parse(readFileSync(idsFile, 'utf8').replace(/^﻿/, ''))
console.log(`対象 ${ids.length} 件（${APPLY ? '本番更新' : 'ドライラン'}）\n`)

let changed = 0, unchanged = 0
const failed = 0
const removedTally = {}
/** 生成する UPDATE 文 */
const updates = []

for (let i = 0; i < ids.length; i += 50) {
  const chunk = ids.slice(i, i + 50)
  const q = `${URL}/rest/v1/candidates?id=in.(${chunk.join(',')})` +
    `&select=id,name,roles:raw_profile->roles,body:raw_profile->>text,att:raw_profile->>attachmentText`
  const rows = await (await fetch(q, { headers: h })).json()
  if (!Array.isArray(rows)) { console.error('取得失敗:', rows); process.exit(1) }

  for (const r of rows) {
    const stored = Array.isArray(r.roles) ? r.roles : []
    if (stored.length === 0) { unchanged++; continue }
    const full = `${r.body ?? ''}\n${r.att ?? ''}`
    const stripped = `${stripAgentSolicitation(r.body ?? '')}\n${r.att ?? ''}`
    // 定型文があってもなくても出る役割は本人のもの。消えるものだけが定型文由来
    const withRoles = scoreProseRoles(full, full).roles
    const withoutRoles = new Set(scoreProseRoles(stripped, stripped).roles)
    const fromSolicitation = withRoles.filter((x) => !withoutRoles.has(x))
    if (fromSolicitation.length === 0) { unchanged++; continue }

    const next = stored.filter((x) => !fromSolicitation.includes(x))
    if (next.length === stored.length) { unchanged++; continue }

    for (const x of fromSolicitation) removedTally[x] = (removedTally[x] ?? 0) + 1
    console.log(`${r.name}: [${stored.join(', ')}] → [${next.join(', ') || '（なし）'}]  除去: ${fromSolicitation.join('・')}`)
    changed++

    // raw_profile の一部だけを差し替えるので UPDATE 文を出す。
    // PostgREST の PATCH は jsonb 列を丸ごと置き換えるため、
    // 更新のたびに 1件35KB を往復することになり egress が重い（2026-08-14 の方針）。
    updates.push(
      `UPDATE candidates SET raw_profile = jsonb_set(raw_profile, '{roles}', ` +
      `'${JSON.stringify(next).replace(/'/g, "''")}'::jsonb) WHERE id = '${r.id}';`,
    )
  }
}

console.log(`\n変更 ${changed} 件 / 変更なし ${unchanged} 件 / 失敗 ${failed} 件`)
if (Object.keys(removedTally).length) {
  console.log('除去された役割の内訳:')
  for (const [k, v] of Object.entries(removedTally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}件`)
}

if (updates.length > 0) {
  const outPath = 'scripts/sql/apply_role_backfill.sql'
  writeFileSync(outPath, [
    '-- 営業定型文に由来する役割を取り除く（backfill_roles_solicitation.mjs が生成・2026-08-17）',
    '-- 役割を減らすだけ。増やす更新は含まれない。',
    `-- 対象 ${updates.length} 件`,
    'BEGIN;',
    ...updates,
    'COMMIT;',
    '',
  ].join('\n'), 'utf8')
  console.log(`\nUPDATE 文を書き出しました: ${outPath}`)
  console.log('反映するには: npx supabase db query --linked -f scripts/sql/apply_role_backfill.sql')
}
if (!APPLY) console.log('※ これはドライランの集計です（DBは変更していません）')
