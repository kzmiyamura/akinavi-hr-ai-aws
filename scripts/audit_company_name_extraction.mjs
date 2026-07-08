#!/usr/bin/env node
// audit_company_name_extraction.mjs — 全候補者メールについて、本文中の会社名
// （前株/後株パターン）が正しく抽出できているか監査する。
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

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
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)

const HOJIN = '(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)'
const OWN_COMPANY_NAMES = ['株式会社ボイス', 'i-voice', 'アキナビ', 'akinavi', '株式会社アキナビ']
const isSalutation = (text, idx, len) => /^[\r\n　 ]*(?:様|御中|ご担当|担当者様|採用担当|ご関係者)/.test(text.slice(idx + len, idx + len + 40))

// index.ts の PRE_RE / POST_RE を移植（本文検出用）
const PRE_RE = new RegExp(`(?:${HOJIN})[　 ]?([^\\s　の\\n（(、。！【】「」]{2,30}(?:[ \\t]+[A-Za-z][A-Za-z \\t&.]{0,20})?)`, 'g')
const POST_RE = /([^（(（\s　\n、。！【】「」]{2,20})[　 ]?(?:株式会社|有限会社|合同会社)/g

function detectCompanyCandidates(bodyText) {
  const sigArea = bodyText.slice(-2000)
  const results = []
  let m
  const preRe2 = new RegExp(PRE_RE.source, 'g')
  while ((m = preRe2.exec(sigArea)) !== null) {
    if (isSalutation(sigArea, m.index, m[0].length)) continue
    const hojin = m[0].match(new RegExp(HOJIN))?.[0]
    const value = `${hojin}${m[1]}`
    if (OWN_COMPANY_NAMES.some(own => value.toLowerCase().includes(own.toLowerCase()))) continue
    results.push({ pattern: 'pre', value, core: m[1] })
  }
  const postRe2 = new RegExp(POST_RE.source, 'g')
  while ((m = postRe2.exec(sigArea)) !== null) {
    if (isSalutation(sigArea, m.index, m[0].length)) continue
    const hojin = m[0].match(/株式会社|有限会社|合同会社/)?.[0]
    const value = `${m[1]}${hojin}`
    if (OWN_COMPANY_NAMES.some(own => value.toLowerCase().includes(own.toLowerCase()))) continue
    results.push({ pattern: 'post', value, core: m[1] })
  }
  return results
}

function normalize(s) {
  return (s ?? '').replace(/[\s　]/g, '')
}

// 法人格の有無の表記ゆれを許容した一致判定
// （例: 検出値「株式会社フォスターネット」・DB値「フォスターネット」は一致とみなす）
function matchesAny(dbValue, candidates) {
  const normDb = normalize(dbValue)
  if (!normDb) return false
  return candidates.some(c => {
    const normFull = normalize(c.value)
    const normCore = normalize(c.core)
    return normFull === normDb || normCore === normDb || normFull.includes(normDb) || normDb.includes(normCore)
  })
}

const CACHE_PATH = '/tmp/company_audit_candidates_cache.json'

async function main() {
  let all
  if (existsSync(CACHE_PATH)) {
    console.log('キャッシュから読み込み中...')
    all = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
  } else {
    console.log('候補者データを取得中...')
    all = []
    const pageSize = 150
    let cursor = null
    while (true) {
      let q = supabase
        .from('candidates')
        .select('id, name, from_company, created_at, raw_profile->>text')
        .eq('data_env', 'prod')
        .order('created_at', { ascending: false })
        .limit(pageSize)
      if (cursor) q = q.lt('created_at', cursor)
      const { data, error } = await q
      if (error) { console.error(error); process.exit(1) }
      if (!data || data.length === 0) break
      all = all.concat(data)
      cursor = data[data.length - 1].created_at
      console.log(`  ... ${all.length}件取得`)
      if (data.length < pageSize) break
    }
    writeFileSync(CACHE_PATH, JSON.stringify(all))
  }
  console.log(`対象: ${all.length}件\n`)

  let noCandidateInBody = 0       // 本文に会社名パターン自体がない
  let correctlyExtracted = 0      // DBの値が検出候補のいずれかと一致
  let missingButDetectable = 0    // 本文にはあるのにfrom_companyがnull
  let wrongValue = 0              // from_companyがあるが検出候補と不一致（誤抽出の疑い）
  const wrongExamples = []
  const missingExamples = []

  for (const cand of all) {
    const bodyText = cand.text ?? ''
    if (!bodyText) { noCandidateInBody++; continue }
    const candidates = detectCompanyCandidates(bodyText)
    if (candidates.length === 0) { noCandidateInBody++; continue }

    const matched = matchesAny(cand.from_company, candidates)

    if (matched) {
      correctlyExtracted++
    } else if (!cand.from_company) {
      missingButDetectable++
      if (missingExamples.length < 15) {
        missingExamples.push({ id: cand.id, name: cand.name, detected: candidates.map(c => c.value).slice(0, 3) })
      }
    } else {
      wrongValue++
      if (wrongExamples.length < 15) {
        wrongExamples.push({ id: cand.id, name: cand.name, dbValue: cand.from_company, detected: candidates.map(c => c.value).slice(0, 3) })
      }
    }
  }

  const total = all.length
  console.log('=== 集計結果 ===')
  console.log(`総数: ${total}`)
  console.log(`本文に会社名パターンなし（判定対象外）: ${noCandidateInBody} (${(noCandidateInBody/total*100).toFixed(1)}%)`)
  const denominator = total - noCandidateInBody
  console.log(`--- 判定対象（本文に会社名パターンあり）: ${denominator} 件 ---`)
  console.log(`正しく抽出: ${correctlyExtracted} (${(correctlyExtracted/denominator*100).toFixed(1)}%)`)
  console.log(`未抽出（null）: ${missingButDetectable} (${(missingButDetectable/denominator*100).toFixed(1)}%)`)
  console.log(`誤抽出（別の値）: ${wrongValue} (${(wrongValue/denominator*100).toFixed(1)}%)`)

  writeFileSync('/tmp/company_audit_result.json', JSON.stringify({ wrongExamples, missingExamples }, null, 2))
  console.log('\n詳細例を /tmp/company_audit_result.json に保存')
}

main()
