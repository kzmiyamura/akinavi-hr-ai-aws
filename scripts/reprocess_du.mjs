#!/usr/bin/env node
/**
 * reprocess_du.mjs — D.U の Excel ファイルを最新コードで再解析
 * resume_url のファイルを取得して inbound-email に force=true で投入する
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
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY

// D.U の Excel ファイル (f871776a レコードの resume_url)
const EXCEL_URL = 'https://argizomylbolpqxgmvim.supabase.co/storage/v1/object/public/attachments/resumes/1781350716475_5fellf.xlsx'

console.log('=== D.U Excel 再解析スクリプト ===')
console.log(`SUPABASE_URL: ${SUPABASE_URL}`)
console.log(`Excel URL: ${EXCEL_URL}`)

// 1. Excel ファイルをダウンロード
console.log('\n[1] Excel ファイルをダウンロード中...')
const fileRes = await fetch(EXCEL_URL)
if (!fileRes.ok) {
  console.error(`Excel ダウンロード失敗: ${fileRes.status} ${fileRes.statusText}`)
  process.exit(1)
}
const buf = await fileRes.arrayBuffer()
const base64 = Buffer.from(buf).toString('base64')
console.log(`    ダウンロード完了: ${buf.byteLength} bytes`)

// 2. inbound-email に投入
console.log('\n[2] inbound-email に force=true で投入中...')
const payload = {
  force: true,
  from: 'du-reprocess@test.local',
  subject: 'D.U スキルシート（再解析）',
  body: '',
  mode: 'prod',
  data_env: 'prod',
  attachments: [
    {
      data: base64,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      name: 'D.U.xlsx',
    },
  ],
}

const res = await fetch(`${SUPABASE_URL}/functions/v1/inbound-email`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ANON_KEY}`,
  },
  body: JSON.stringify(payload),
})

const text = await res.text()
console.log(`    HTTP ${res.status}`)
try {
  const json = JSON.parse(text)
  console.log(JSON.stringify(json, null, 2))
} catch {
  console.log(text)
}
