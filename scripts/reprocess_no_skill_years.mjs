/**
 * reprocess_no_skill_years.mjs
 * 直近N日間で skillYears が取れていない候補者を再投入する。
 *
 * 優先順位:
 *   1. resume_url が Supabase Storage の .xlsx → Excel をダウンロードして添付として送信
 *   2. raw_profile.attachmentText がある → attachmentText を添付テキストとして送信
 *   3. どちらもなければ本文のみ送信（効果は限定的）
 *
 * Usage:
 *   node scripts/reprocess_no_skill_years.mjs [--dry-run] [--days 7] [--limit 100]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL     = `${SUPABASE_URL}/functions/v1`
const supabase     = createClient(SUPABASE_URL, ANON_KEY)

const DRY_RUN     = process.argv.includes('--dry-run')
const DAYS        = parseInt(process.argv[process.argv.indexOf('--days') + 1] ?? '7', 10)
const LIMIT       = parseInt(process.argv[process.argv.indexOf('--limit') + 1] ?? '200', 10)
const CONCURRENCY = parseInt(process.argv[process.argv.indexOf('--concurrency') + 1] ?? '1', 10)

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const WORD_MIME  = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function main() {
  console.log(`=== reprocess_no_skill_years ${DRY_RUN ? '[DRY-RUN]' : ''} days=${DAYS} limit=${LIMIT} ===`)

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString()

  const { data: all, error } = await supabase
    .from('candidates')
    .select('id, name, drive_url, resume_url, raw_profile')
    .eq('data_env', 'prod')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(LIMIT)

  if (error) { console.error('取得失敗:', error.message); process.exit(1) }

  // skillYears が空のもののみ対象
  const rows = (all ?? []).filter(r => {
    const sy = r.raw_profile?.skillYears ?? {}
    const realKeys = Object.keys(sy).filter(k => !k.startsWith('_'))
    return realKeys.length === 0
  })

  if (rows.length === 0) { console.log('対象者なし。終了。'); return }
  console.log(`対象: ${rows.length} 件\n`)

  // 戦略別に分類
  const withStorageFile   = rows.filter(r => isStorageFile(r.resume_url))   // Excel / Word
  const withGoogleSheets  = rows.filter(r => !isStorageFile(r.resume_url) && isGoogleSheets(r.resume_url))
  const withAttachText    = rows.filter(r => !isStorageFile(r.resume_url) && !isGoogleSheets(r.resume_url) && r.raw_profile?.attachmentText)
  const bodyOnly          = rows.filter(r => !isStorageFile(r.resume_url) && !isGoogleSheets(r.resume_url) && !r.raw_profile?.attachmentText)
  console.log(`  Strategy A (Storage Excel/Word ダウンロード): ${withStorageFile.length} 件`)
  console.log(`  Strategy D (Google Sheets XLSX ダウンロード): ${withGoogleSheets.length} 件`)
  console.log(`  Strategy B (attachmentText 再投入):           ${withAttachText.length} 件`)
  console.log(`  Strategy C (本文のみ・効果限定):              ${bodyOnly.length} 件\n`)

  let ok = 0, ng = 0, skip = 0

  async function processOne(row) {
    const rp   = row.raw_profile ?? {}
    const text = rp.text ?? ''

    if (!text) {
      console.log(`  SKIP ${row.name} — raw_profile.text なし`)
      skip++
      return
    }

    const strategy = isStorageFile(row.resume_url) ? 'A'
      : isGoogleSheets(row.resume_url) ? 'D'
      : rp.attachmentText ? 'B'
      : 'C'

    if (DRY_RUN) {
      console.log(`  [DRY][${strategy}] ${row.name} | ${(row.resume_url ?? '').slice(0, 70)}`)
      ok++
      return
    }

    try {
      let attachments = undefined

      // Strategy A: Supabase Storage から Excel / Word をダウンロード
      if (strategy === 'A') {
        const fileBase64 = await fetchFileAsBase64(row.resume_url)
        if (fileBase64) {
          const ext = row.resume_url.split('.').pop().toLowerCase()
          const mime = ext === 'xlsx' ? EXCEL_MIME
            : ext === 'xls' ? 'application/vnd.ms-excel'
            : ext === 'docx' ? WORD_MIME
            : ext === 'doc' ? 'application/msword'
            : EXCEL_MIME
          attachments = [{ data: fileBase64, mimeType: mime, name: `resume.${ext}` }]
        } else {
          console.log(`  WARN ${row.name} — ファイルダウンロード失敗、本文のみで再投入`)
        }
      }

      // Strategy D: Google Sheets を XLSX でダウンロード
      if (strategy === 'D') {
        const sheetsId = row.resume_url.match(/spreadsheets\/d\/([a-zA-Z0-9_-]{25,})/)?.[1]
        if (sheetsId) {
          const xlsxUrl = `https://docs.google.com/spreadsheets/d/${sheetsId}/export?format=xlsx`
          const xlsxBase64 = await fetchFileAsBase64(xlsxUrl)
          if (xlsxBase64) {
            attachments = [{ data: xlsxBase64, mimeType: EXCEL_MIME, name: 'skillsheet.xlsx' }]
          } else {
            console.log(`  WARN ${row.name} — Google Sheets XLSXダウンロード失敗（非公開？）、本文のみで再投入`)
          }
        }
      }

      // Strategy B: attachmentText を疑似添付として本文末尾に追加
      // inbound-email は本文から skillYears を読み取れないが、
      // skill_master 照合の attachText として流れるため最寄駅・スキル補完には効果あり
      // Strategy B: body が大きすぎると 546 になるため 3000 文字に切り詰め
      const bodyWithAttach = strategy === 'B'
        ? `${text.slice(0, 3000)}\n\n--- 添付テキスト ---\n${rp.attachmentText}`
        : text

      const payload = {
        force: true,
        mode: 'prod',
        type: 'candidate',
        target_candidate_id: row.id,
        subject: rp.subject ?? '再解析',
        from: rp.from ?? '',
        body: bodyWithAttach,
        ...(attachments ? { attachments } : {}),
      }

      const resp = await fetch(`${EDGE_URL}/inbound-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
        body: JSON.stringify(payload),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok || json?.ok === false) {
        console.log(`  NG  [${strategy}] ${row.name} (${resp.status}) ${json?.error ?? ''}`)
        ng++
      } else {
        console.log(`  OK  [${strategy}] ${row.name}`)
        ok++
      }
    } catch (e) {
      console.error(`  ERR ${row.name}: ${e.message}`)
      ng++
    }
  }

  const SKIP_A = process.argv.includes('--skip-a')
  // Strategy A → B → C の順で処理（D は Google Sheets 非公開のため body-only フォールバックで非効率 → スキップ）
  const sortedRows = [...(SKIP_A ? [] : withStorageFile), ...withAttachText, ...bodyOnly]
  console.log(`  Strategy D (Google Sheets) はスキップ: ${withGoogleSheets.length} 件`)
  if (SKIP_A) console.log(`  Strategy A (Storage) はスキップ: ${withStorageFile.length} 件（--skip-a 指定）`)
  console.log()

  for (let i = 0; i < sortedRows.length; i += CONCURRENCY) {
    const chunk = sortedRows.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(r => processOne(r)))
    console.log(`進捗: ${Math.min(i + CONCURRENCY, sortedRows.length)} / ${sortedRows.length}`)
    // 546エラー防止: Supabase Edgeワーカー負荷軽減のため短いウェイト
    if (i + CONCURRENCY < sortedRows.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  console.log(`\n完了: OK=${ok} / NG=${ng} / SKIP=${skip}`)
  console.log(`\n再取得率を確認するには:`)
  console.log(`  node scripts/quality_check.mjs --days ${DAYS} | grep skillYears`)
}

function isStorageFile(url) {
  if (!url) return false
  return url.includes('supabase.co/storage') && /\.(xlsx?|xls|ods|docx?|doc)$/i.test(url)
}

function isGoogleSheets(url) {
  if (!url) return false
  return /docs\.google\.com\/spreadsheets\/d\//.test(url)
}

async function fetchFileAsBase64(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) {
      console.warn(`  [fetch] ${resp.status} ${url.slice(-40)}`)
      return null
    }
    const buf = await resp.arrayBuffer()
    return Buffer.from(buf).toString('base64')
  } catch (e) {
    console.warn(`  [fetch] エラー: ${e.message}`)
    return null
  }
}

main().catch(e => { console.error(e); process.exit(1) })
