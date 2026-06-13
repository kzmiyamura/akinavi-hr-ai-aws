#!/usr/bin/env node
/**
 * reanalyze_candidate.mjs — 候補者を再解析してDBを更新するスクリプト
 * 使い方: node scripts/reanalyze_candidate.mjs "D.U"
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '../.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim()
  }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

const query = process.argv[2]
const dataEnv = process.argv[3] ?? 'prod'

if (!query) {
  console.log('使い方: node scripts/reanalyze_candidate.mjs <ID or 名前> [prod|demo]')
  process.exit(0)
}

// 候補者取得
const isUuid = /^[0-9a-f-]{36}$/.test(query)
const filter = isUuid ? `id=eq.${query}` : `name=eq.${encodeURIComponent(query)}`
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/candidates?${filter}&select=id,name,raw_profile,resume_url&order=created_at.desc&limit=1`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
)
const rows = await res.json()

if (!rows || rows.length === 0) {
  console.log(`「${query}」に一致する候補者が見つかりませんでした`)
  process.exit(0)
}

const c = rows[0]
const rp = c.raw_profile ?? {}
const text = rp.text ?? ''
const resumeUrl = c.resume_url ?? ''

console.log(`再解析対象: ${c.name} (${c.id})`)
console.log(`本文長: ${text.length}文字  resume_url: ${resumeUrl || 'なし'}`)

// Supabase Storage から Excel を取得 (URLが storage のものだけ)
let attachments = []
const storageMatch = resumeUrl.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/)
if (storageMatch) {
  const bucket = storageMatch[1]
  const path = storageMatch[2]
  console.log(`Storage から取得中: bucket=${bucket} path=${path}`)
  const key = SUPABASE_SERVICE_KEY ?? SUPABASE_KEY
  const fileRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  )
  if (fileRes.ok) {
    const buf = await fileRes.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    }
    const b64 = btoa(binary)
    const ext = path.split('.').pop()?.toLowerCase()
    const mime = ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                : ext === 'xls' ? 'application/vnd.ms-excel'
                : 'application/octet-stream'
    attachments = [{ name: `resume.${ext}`, mimeType: mime, data: b64 }]
    console.log(`Excel 取得成功: ${buf.byteLength} bytes`)
  } else {
    console.log(`Storage 取得失敗: ${fileRes.status} ${fileRes.statusText}`)
  }
}

// inbound-email に POST
const EDGE_URL = `${SUPABASE_URL}/functions/v1/inbound-email`
const authKey = SUPABASE_SERVICE_KEY ?? SUPABASE_KEY
const body = {
  from: rp.from ?? `reanalyze@script`,
  subject: rp.subject ?? '再解析',
  text,
  html: '',
  attachments,
  data_env: dataEnv,
  force: true,
}

console.log(`inbound-email に送信中 (attachments: ${attachments.length}件)...`)
const eres = await fetch(EDGE_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: authKey,
    Authorization: `Bearer ${authKey}`,
  },
  body: JSON.stringify(body),
})
const result = await eres.json()
console.log(`レスポンス (${eres.status}):`, JSON.stringify(result, null, 2).slice(0, 500))
