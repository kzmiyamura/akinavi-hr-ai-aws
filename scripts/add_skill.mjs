#!/usr/bin/env node
/**
 * add_skill.mjs — skill_master にスキルを追加する
 *
 * 使い方:
 *   node scripts/add_skill.mjs "AS/400" others
 *   node scripts/add_skill.mjs "AS/400" others '["AS400","AS／400"]'
 *   node scripts/add_skill.mjs --list             # 登録済みスキルを検索
 *   node scripts/add_skill.mjs --search "RPG"     # 部分一致で検索
 *
 * カテゴリ一覧:
 *   languages frameworks libraries os databases dwh
 *   clouds infrastructures tools methodologies certifications
 *   design marketing others
 *
 * 環境変数: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY（.env.local から自動読み込み）
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim()
    if (!process.env[k]) process.env[k] = v
  }
}
loadEnv()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ANON_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

const VALID_CATEGORIES = [
  'languages', 'frameworks', 'libraries', 'os', 'databases', 'dwh',
  'clouds', 'infrastructures', 'tools', 'methodologies', 'certifications',
  'design', 'marketing', 'others',
]

const args = process.argv.slice(2)

async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${text}`)
  return text ? JSON.parse(text) : []
}

// --list または --search モード
if (args[0] === '--list' || args[0] === '--search') {
  const searchTerm = args[0] === '--search' ? args[1] : null
  const qs = searchTerm
    ? `select=name,category,match_count,aliases&name=ilike.*${encodeURIComponent(searchTerm)}*&order=name`
    : `select=name,category,match_count,aliases&order=match_count.desc&limit=50`
  try {
    const skills = await rest('GET', `skill_master?${qs}`)
    if (skills.length === 0) {
      console.log(searchTerm ? `"${searchTerm}" に一致するスキルなし` : 'スキルなし')
    } else {
      console.log(`\n${searchTerm ? `"${searchTerm}" の検索結果` : 'skill_master 上位50件'}:`)
      skills.forEach(s => {
        const aliases = Array.isArray(s.aliases) ? ` aliases=[${s.aliases.join(',')}]` : ''
        console.log(`  ${s.name.padEnd(25)} ${s.category.padEnd(15)} matches=${s.match_count ?? 0}${aliases}`)
      })
    }
  } catch (e) {
    console.error(`検索失敗: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

const skillName = args[0]
const category = args[1]
const aliasesRaw = args[2]

if (!skillName || !category) {
  console.error('使い方: node scripts/add_skill.mjs <スキル名> <カテゴリ> [<エイリアスJSON>]')
  console.error('例: node scripts/add_skill.mjs "AS/400" others \'["AS400","AS／400"]\'')
  console.error('\nカテゴリ: ' + VALID_CATEGORIES.join(' | '))
  process.exit(1)
}

if (!VALID_CATEGORIES.includes(category)) {
  console.error(`❌ 無効なカテゴリ: "${category}"`)
  console.error('カテゴリ: ' + VALID_CATEGORIES.join(' | '))
  process.exit(1)
}

let aliases = null
if (aliasesRaw) {
  try {
    aliases = JSON.parse(aliasesRaw)
    if (!Array.isArray(aliases)) throw new Error('配列ではありません')
  } catch (e) {
    console.error(`❌ エイリアスのパース失敗: ${e.message}`)
    console.error('例: \'["AS400","AS／400"]\'')
    process.exit(1)
  }
}

console.log(`\n🔧 skill_master に追加: "${skillName}" (${category})${aliases ? ` aliases=${JSON.stringify(aliases)}` : ''}`)

try {
  const payload = { name: skillName, category, source: 'seed' }
  if (aliases) payload.aliases = aliases

  const result = await rest('POST', 'skill_master', payload)
  console.log(`  ✅ 追加/更新完了`)

  // 追加結果を確認
  const check = await rest('GET', `skill_master?name=eq.${encodeURIComponent(skillName)}&select=id,name,category,aliases,match_count`)
  if (check.length > 0) {
    const s = check[0]
    console.log(`  ID:${s.id.slice(0, 8)}  name:${s.name}  category:${s.category}  aliases:${JSON.stringify(s.aliases)}  matches:${s.match_count ?? 0}`)
  }
} catch (e) {
  console.error(`  ❌ 追加失敗: ${e.message}`)
  process.exit(1)
}

console.log('\n完了 ✅')
