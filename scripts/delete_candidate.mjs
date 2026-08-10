#!/usr/bin/env node
// delete_candidate.mjs — 候補者1件の削除（UI「削除」ボタンのCLI版）
//
// 誤登録（案件メールの人材化等）のクリーンアップ用。uuid 完全一致の1件のみ削除する。
// candidate_skills は FK ON DELETE CASCADE で自動削除される。
// 恒久許可: "Bash(node scripts/delete_candidate.mjs *)"（node scripts/* に包含）
//
// 使い方: node scripts/delete_candidate.mjs <candidate_id> [--dry]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv[2]
const dry = process.argv.includes('--dry')
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }
if (!/^[0-9a-f-]{36}$/.test(id ?? '')) { console.error('使い方: node scripts/delete_candidate.mjs <candidate_id(uuid)> [--dry]'); process.exit(1) }

const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const rows = await (await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=id,name,data_env,created_at,from_company`, { headers: h })).json()
if (!rows[0]) { console.error('候補者が見つかりません:', id); process.exit(1) }
console.log('対象:', JSON.stringify(rows[0]))
if (dry) { console.log('（--dry のため削除せず終了）'); process.exit(0) }

const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${id}`, {
  method: 'DELETE', headers: { ...h, Prefer: 'return=representation' },
})
const deleted = await res.json()
console.log(res.ok && deleted.length === 1 ? `✅ 削除完了: ${deleted[0].name}` : `❌ ${res.status}`)
