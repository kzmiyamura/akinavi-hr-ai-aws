#!/usr/bin/env node
/**
 * audit_resume_mismatch.mjs — resume_url の添付内容に候補者本人の名前が
 * 一切含まれていない（＝他人の経歴書が紐付いている疑いがある）候補者を洗い出す。
 *
 * 使い方: node scripts/audit_resume_mismatch.mjs
 * 環境変数: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY（.env.local から自動読み込み）
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'
import mammoth from 'mammoth'

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
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, ANON_KEY)

function normalize(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/[.\s　・【】\[\]()（）]/g, '')
}

async function extractText(buf, url) {
  const lower = url.toLowerCase()
  try {
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const wb = XLSX.read(buf, { type: 'buffer' })
      let text = ''
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' })
        text += rows.flat().join(' ') + '\n'
      }
      return text
    }
    if (lower.endsWith('.docx')) {
      const r = await mammoth.extractRawText({ buffer: buf })
      return r.value
    }
  } catch (e) {
    return null
  }
  return null // .doc 等の非対応形式
}

async function main() {
  console.log('候補者一覧を取得中...')
  let all = []
  let from = 0
  const pageSize = 500
  while (true) {
    const { data, error } = await supabase
      .from('candidates')
      .select('id, name, resume_url')
      .eq('data_env', 'prod')
      .not('resume_url', 'is', null)
      .like('resume_url', '%/storage/v1/object/public/attachments/resumes/%')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) { console.error(error); process.exit(1) }
    all = all.concat(data)
    if (data.length < pageSize) break
    from += pageSize
  }
  console.log(`対象: ${all.length}件\n`)

  const mismatches = []
  const skipped = []
  let checked = 0

  for (const cand of all) {
    checked++
    const normName = normalize(cand.name)
    if (!cand.name || normName.length < 2 || /^不明$/.test(cand.name)) {
      skipped.push({ ...cand, reason: '名前が短すぎる/不明' })
      continue
    }
    try {
      const res = await fetch(cand.resume_url)
      if (!res.ok) {
        skipped.push({ ...cand, reason: `HTTP_${res.status}` })
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const text = await extractText(buf, cand.resume_url)
      if (text === null) {
        skipped.push({ ...cand, reason: '非対応形式(.doc等)またはパース失敗' })
        continue
      }
      const normText = normalize(text)
      if (!normText.includes(normName)) {
        mismatches.push(cand)
        console.log(`  [MISMATCH] ${cand.name} (id=${cand.id})`)
      }
    } catch (e) {
      skipped.push({ ...cand, reason: `ERROR:${e.message}` })
    }
    if (checked % 50 === 0) console.log(`... ${checked}/${all.length} 件チェック済み（不一致 ${mismatches.length}件）`)
  }

  console.log(`\n=== 総計 ===`)
  console.log(`チェック対象: ${all.length}`)
  console.log(`不一致（疑いあり）: ${mismatches.length}`)
  console.log(`スキップ: ${skipped.length}`)

  writeFileSync('/tmp/resume_mismatch_result.json', JSON.stringify({ mismatches, skipped }, null, 2))
  console.log('\n詳細を /tmp/resume_mismatch_result.json に保存しました')
}

main()
