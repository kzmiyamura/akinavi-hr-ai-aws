#!/usr/bin/env node
/**
 * review_candidates.mjs — 7日間の人材データを1件ずつ確認・修正・更新
 *
 * 使い方:
 *   node scripts/review_candidates.mjs           # インタラクティブ（1件ずつ確認）
 *   node scripts/review_candidates.mjs --auto    # 自動モード（確認なしで更新）
 *   node scripts/review_candidates.mjs --days 3  # 直近3日（既定7日）
 *   node scripts/review_candidates.mjs --null    # from_company / employmentType が NULL のみ
 *   node scripts/review_candidates.mjs --dry     # DB更新しない（確認のみ）
 *
 * 更新対象フィールド:
 *   - from_company     : エージェント会社名（メール署名から抽出）
 *   - raw_profile.employmentType : 正社員/フリーランス/業務委託/SES/契約社員/派遣社員
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// --- .env.local 読み込み ---
function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

// --- Supabase REST API ---
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

async function supabaseQuery(path, options = {}) {
  const { headers: extraHeaders = {}, ...restOptions } = options
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...extraHeaders,
    },
    ...restOptions,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase error ${res.status}: ${text}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('json')) return res.json()
  return null
}

// --- 抽出ロジック（inbound-email と同等） ---

const OWN_COMPANY_NAMES = ['株式会社ボイス', 'i-voice', 'アキナビ', 'akinavi', '株式会社アキナビ']

function sanitizeFromCompany(value) {
  if (!value) return null
  let trimmed = value.trim()
  if (!trimmed) return null
  for (const own of OWN_COMPANY_NAMES) {
    if (trimmed.toLowerCase().includes(own.toLowerCase())) return null
  }
  const preM = trimmed.match(/^((?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[^\sの　\n、。！（）【】「」]{2,20})/)
  if (preM) trimmed = preM[1]
  const postM = trimmed.match(/^([^\sの　\n、。！（）【】「」]{2,20}(?:株式会社|有限会社|合同会社))/)
  if (postM) trimmed = postM[1]
  trimmed = trimmed.replace(/の[^\s　]{1,15}(?:でございます|です|と申します|でした).*$/, '')
  // 法人格のみ（識別名なし）は無効
  if (/^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)$/.test(trimmed)) return null
  return trimmed || null
}

function isSalutation(text, matchIndex, matchLen) {
  const after = text.slice(matchIndex + matchLen, matchIndex + matchLen + 40)
  return /^[\r\n　 ]*(?:様|御中|ご担当|担当者様|採用担当|ご関係者)/.test(after)
}

function extractFromCompany(bodyText, attachText = '') {
  const allBodyText = (bodyText || '') + '\n' + (attachText || '')
  const sigArea = allBodyText.slice(-1200)

  let fromCompany = null

  // 「株式会社XXX」前置パターン
  const PRE_RE = /(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[　 ]?([^（(（\s　\n、。！【】「」]{2,20})/g
  let bestPre = null, m
  while ((m = PRE_RE.exec(sigArea)) !== null) {
    if (!isSalutation(sigArea, m.index, m[0].length)) bestPre = m
  }
  if (bestPre) {
    const prefix = bestPre[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]
    fromCompany = sanitizeFromCompany(`${prefix}${bestPre[1]}`)
  }

  // 「XXX株式会社」後置パターン
  if (!fromCompany) {
    const POST_RE = /([^（(（\s　\n、。！【】「」]{2,20})[　 ]?(?:株式会社|有限会社|合同会社)/g
    let bestPost = null
    while ((m = POST_RE.exec(sigArea)) !== null) {
      if (!isSalutation(sigArea, m.index, m[0].length)) bestPost = m
    }
    if (bestPost) {
      const suffix = bestPost[0].match(/株式会社|有限会社|合同会社/)?.[0]
      fromCompany = sanitizeFromCompany(`${bestPost[1]}${suffix}`)
    }
  }

  return fromCompany
}

function extractEmploymentType(bodyText, attachText = '') {
  const t = (bodyText || '') + ' ' + (attachText || '')

  // ラベルあり
  const labelM = t.match(/(?:雇用形態|就業形態|立場|エンジニアの立場|現在の立場|契約形態|ご状況|属性)[　 ]*[：:][　 ]*([^\n]{1,30})/)
  if (labelM) {
    const val = labelM[1].trim()
    if (/フリーランス|フリー|個人事業/.test(val)) return 'フリーランス'
    if (/正社員/.test(val)) return '正社員'
    if (/契約社員/.test(val)) return '契約社員'
    if (/派遣社員|派遣/.test(val)) return '派遣社員'
    if (/業務委託/.test(val)) return '業務委託'
    if (/SES/.test(val)) return 'SES'
  }

  // コンテキスト判定
  if (/弊社[　 ]*(正社員|社員)/.test(t)) return '正社員'
  if (/[（(]正社員[）)]|正社員として登録|正社員エンジニア/.test(t)) return '正社員'
  if (/弊社正社員|弊社.*正社員|弊社.*所属.*正社員/.test(t)) return '正社員'
  if (/【所　属】.*正社員|【所属】.*正社員/.test(t)) return '正社員'
  if (/フリーランス(エンジニア|技術者|の方|候補|案件)?|個人事業主/.test(t)) return 'フリーランス'
  if (/弊社直個人|直個人事業主|協力会社代表/.test(t)) return 'フリーランス'
  if (/業務委託(契約|のみ|希望|での)?/.test(t)) return '業務委託'
  if (/弊社SES|SES(エンジニア|技術者|正社員|社員)?/.test(t)) return 'SES'
  if (/契約社員/.test(t)) return '契約社員'
  if (/派遣社員/.test(t)) return '派遣社員'
  return null
}

// --- インタラクティブ readline ヘルパー ---
function createReadline() {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

// --- メール署名から派遣許可番号を抽出 ---
function extractHakenFromBody(bodyText) {
  const FAKE = new Set(['派01-000001', '派13-307608'])
  const sigArea = (bodyText || '').slice(-1200)
  const matches = [...sigArea.matchAll(/派\d{2}-\d{6}/g)]
    .map(m => m[0])
    .filter(s => !FAKE.has(s))
  return [...new Set(matches)]
}

// --- agent_companies モード ---
async function runAgentMode(searchTerm, dryRun) {
  const rl = createReadline()

  // 検索ワードが未指定なら入力を促す
  let term = searchTerm
  if (!term) {
    term = (await ask(rl, 'エージェント会社名（部分一致）> ')).trim()
    if (!term) { rl.close(); return }
  }

  // agent_companies を検索
  const companies = await supabaseQuery(
    `agent_companies?select=domain,company_name,haken_number,shokai_number,license_status,verified_at&company_name=ilike.*${encodeURIComponent(term)}*&order=domain`,
    { headers: { Prefer: 'return=representation' } }
  )

  if (!companies || companies.length === 0) {
    console.log(`\n「${term}」に一致するエージェントが見つかりませんでした。`)
    rl.close(); return
  }

  console.log(`\n${companies.length}件ヒット:\n`)
  for (const ac of companies) {
    console.log(`${'='.repeat(70)}`)
    console.log(`ドメイン    : ${ac.domain}`)
    console.log(`会社名（現在）: ${ac.company_name ?? '(null)'}`)
    console.log(`派遣許可（現在）: ${ac.haken_number ?? '(null)'}`)
    console.log(`確認日      : ${ac.verified_at?.slice(0, 10) ?? '未確認'}`)
    console.log()

    // そのドメインの候補者メールを1件取得
    const rows = await supabaseQuery(
      `candidates?select=raw_profile,name,created_at&data_env=eq.prod&raw_profile->>from=ilike.*${encodeURIComponent('@' + ac.domain)}*&order=created_at.desc&limit=1`,
      { headers: { Prefer: 'return=representation' } }
    )

    const sample = rows?.[0]
    if (!sample) {
      console.log('（候補者メールなし）')
    } else {
      const bodyText = sample.raw_profile?.text || ''
      console.log(`サンプル    : ${sample.name ?? '不明'} (${sample.created_at?.slice(0, 10)})`)
      console.log()
      console.log('--- メール本文（末尾600字）---')
      console.log(bodyText.slice(-600))
      console.log()

      // 抽出
      const extractedCompany = extractFromCompany(bodyText)
      const extractedHaken   = extractHakenFromBody(bodyText)

      console.log(`会社名（抽出）: ${extractedCompany ?? '(抽出不可)'}`)
      console.log(`派遣許可（署名）: ${extractedHaken.length ? extractedHaken.join(', ') : '(本文中に記載なし)'}`)
      console.log()
    }

    // 操作説明
    console.log('操作:')
    console.log('  Enter       → 変更なし（スキップ）')
    console.log('  会社名を入力 → company_name を更新')
    console.log('  派遣番号を入力（派XX-XXXXXX）→ haken_number を更新')
    console.log('  両方入力する場合は会社名を先に、次に派遣番号')
    console.log()

    // 会社名入力
    const companyInput = (await ask(rl, `会社名 [${ac.company_name ?? 'null'}] > `)).trim()
    const hakenInput   = (await ask(rl, `派遣許可番号 [${ac.haken_number ?? 'null'}] > `)).trim()

    const newCompany = companyInput === '' ? ac.company_name
                     : companyInput === '-' ? null
                     : companyInput
    const newHaken   = hakenInput === '' ? ac.haken_number
                     : hakenInput === '-' ? null
                     : hakenInput

    const companyChanged = newCompany !== ac.company_name
    const hakenChanged   = newHaken   !== ac.haken_number

    if (!companyChanged && !hakenChanged) {
      console.log('→ 変更なし\n')
      continue
    }

    console.log(`→ 確定: 会社名="${newCompany ?? 'null'}"  派遣許可="${newHaken ?? 'null'}"`)

    if (!dryRun) {
      const patch = {}
      if (companyChanged) patch.company_name = newCompany
      if (hakenChanged) {
        patch.haken_number = newHaken
        patch.verified_at  = new Date().toISOString()
        patch.verified_by  = 'manual'
        if (newHaken) patch.license_status = 'haken'
        else if (!newHaken && !ac.shokai_number) patch.license_status = 'none'
      }
      await supabaseQuery(`agent_companies?domain=eq.${encodeURIComponent(ac.domain)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })

      // candidates.from_company も同期
      if (companyChanged && newCompany) {
        await supabaseQuery(
          `candidates?data_env=eq.prod&raw_profile->>from=ilike.*${encodeURIComponent('@' + ac.domain)}*`,
          {
            method: 'PATCH',
            body: JSON.stringify({ from_company: newCompany }),
          }
        )
        console.log(`  → candidates.from_company も "${newCompany}" に更新`)
      }
      console.log()
    } else {
      console.log('  （ドライランのため DB 更新なし）\n')
    }
  }

  rl.close()
  console.log('完了')
}

// --- メイン ---
const args = process.argv.slice(2)
const AUTO_MODE  = args.includes('--auto')
const NULL_ONLY  = args.includes('--null')
const DRY_RUN    = args.includes('--dry')
const AGENT_MODE = args.includes('--agent')
const daysArg    = args.indexOf('--days')
const DAYS       = daysArg !== -1 ? parseInt(args[daysArg + 1]) || 7 : 7
// --agent の次の引数を検索ワードとして使う（省略可）
const agentArgIdx = args.indexOf('--agent')
const agentSearchTerm = agentArgIdx !== -1 && args[agentArgIdx + 1] && !args[agentArgIdx + 1].startsWith('--')
  ? args[agentArgIdx + 1] : null

// --agent モードは別処理
if (AGENT_MODE) {
  await runAgentMode(agentSearchTerm, DRY_RUN)
  process.exit(0)
}

console.log(`\n=== review_candidates.mjs ===`)
console.log(`モード: ${AUTO_MODE ? '自動' : 'インタラクティブ'}${DRY_RUN ? ' (ドライラン)' : ''}`)
console.log(`対象: 直近${DAYS}日 / ${NULL_ONLY ? 'NULL項目のみ' : '全件'}`)
console.log()

// 候補者取得（ページネーション対応）
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()
let baseUrl = `candidates?select=id,name,from_company,experience_years,raw_profile,created_at&data_env=eq.prod&created_at=gte.${since}&order=created_at.asc`
if (NULL_ONLY) {
  baseUrl += '&or=(from_company.is.null,raw_profile->>employmentType.is.null)'
}

const PAGE = 500
let candidates = []
let offset = 0
while (true) {
  const page = await supabaseQuery(baseUrl, {
    headers: {
      Prefer: 'return=representation',
      Range: `${offset}-${offset + PAGE - 1}`,
    },
  })
  if (!page || page.length === 0) break
  candidates = candidates.concat(page)
  if (page.length < PAGE) break
  offset += PAGE
}
console.log(`取得: ${candidates.length}件\n`)

if (candidates.length === 0) {
  console.log('対象データなし。終了します。')
  process.exit(0)
}

let updated = 0, skipped = 0, unchanged = 0

const rl = AUTO_MODE ? null : createReadline()

for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i]
  const raw = c.raw_profile || {}
  const bodyText = raw.text || ''
  const currentCompany = c.from_company
  const currentEmployment = raw.employmentType

  // 抽出
  const extractedCompany = extractFromCompany(bodyText)
  const extractedEmployment = extractEmploymentType(bodyText)

  // 変更なし判定
  const companyChanged = extractedCompany !== currentCompany
  const employmentChanged = extractedEmployment !== currentEmployment

  if (!companyChanged && !employmentChanged) {
    unchanged++
    if (AUTO_MODE) {
      if ((i + 1) % 50 === 0) process.stdout.write(`. ${i + 1}/${candidates.length}\n`)
      continue
    }
  }

  // --- 表示 ---
  console.log(`\n${'='.repeat(70)}`)
  console.log(`[${i + 1}/${candidates.length}] ${c.name || '不明'} (${c.id.slice(0, 8)}...)`)
  console.log(`登録日: ${c.created_at?.slice(0, 10)}  経験: ${c.experience_years ?? '?'}年`)
  console.log(`差出人: ${raw.from || '?'}`)
  console.log()

  // メール本文（末尾600字を表示）
  const bodyTail = bodyText.slice(-600)
  console.log('--- メール本文（末尾600字）---')
  console.log(bodyTail)
  console.log()

  // 現在値 vs 抽出値
  console.log(`エージェント会社名:`)
  console.log(`  現在   : ${currentCompany ?? '(null)'}`)
  console.log(`  抽出値 : ${extractedCompany ?? '(null)'}  ${companyChanged ? '← 変更' : '(変更なし)'}`)
  console.log(`雇用形態:`)
  console.log(`  現在   : ${currentEmployment ?? '(null)'}`)
  console.log(`  抽出値 : ${extractedEmployment ?? '(null)'}  ${employmentChanged ? '← 変更' : '(変更なし)'}`)
  console.log()

  let finalCompany = extractedCompany
  let finalEmployment = extractedEmployment

  if (!AUTO_MODE) {
    // --- インタラクティブ確認 ---
    console.log('操作:')
    console.log('  Enter / y   → 抽出値で更新')
    console.log('  s           → スキップ（更新しない）')
    console.log('  会社名を入力 → その値で会社名を上書き')
    console.log('  雇用形態を入力 → 正社員/フリーランス/業務委託/SES/契約社員/派遣社員')
    console.log()

    // 会社名確認
    const companyPrompt = `会社名 [${extractedCompany ?? 'null'}] > `
    const companyInput = (await ask(rl, companyPrompt)).trim()

    if (companyInput === 's') {
      console.log('→ スキップ')
      skipped++
      continue
    }
    if (companyInput !== '' && companyInput !== 'y') {
      finalCompany = companyInput === '-' ? null : companyInput
    }

    // 雇用形態確認
    const empPrompt = `雇用形態 [${extractedEmployment ?? 'null'}] > `
    const empInput = (await ask(rl, empPrompt)).trim()

    if (empInput !== '' && empInput !== 'y') {
      finalEmployment = empInput === '-' ? null : empInput
    }

    console.log(`→ 確定: 会社名="${finalCompany ?? 'null'}"  雇用形態="${finalEmployment ?? 'null'}"`)
  }

  // --- DB 更新 ---
  if (!DRY_RUN) {
    const newRawProfile = { ...raw, employmentType: finalEmployment }

    await supabaseQuery(`candidates?id=eq.${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        from_company: finalCompany,
        raw_profile: newRawProfile,
      }),
    })
  }
  updated++
}

if (rl) rl.close()

console.log(`\n${'='.repeat(70)}`)
console.log(`完了: 更新=${updated}件 / スキップ=${skipped}件 / 変更なし=${unchanged}件 / 合計=${candidates.length}件`)
if (DRY_RUN) console.log('※ ドライランのため DB は更新されていません')
