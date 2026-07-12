#!/usr/bin/env node
/**
 * sync_zone_functions.mjs — 分岐網羅テスト用にゾーン関数を index.ts から抽出する
 *
 * sync_extractors.mjs と違い TypeScript のまま抽出し（型ストリップなし）、
 * Deno で直接実行する（scripts/test_zone_branches.ts が import する）。
 * 外部依存（fetch・Excel/Word抽出・Storage等）は deps シム経由にして、
 * テスト側からモックを注入できるようにする。
 *
 * 使い方: node scripts/sync_zone_functions.mjs
 * 出力:   scripts/_zone_functions.gen.ts（自動生成・直接編集しない）
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../supabase/functions/inbound-email/index.ts')
const OUT = resolve(__dirname, '_zone_functions.gen.ts')

const src = readFileSync(SRC, 'utf-8')
const lines = src.split('\n')

/** トップレベル宣言（開始行の正規表現）から、カラム0の `}` 行までを抽出 */
function extractBlock(startRe) {
  const startIdx = lines.findIndex(l => startRe.test(l))
  if (startIdx === -1) throw new Error(`開始行が見つからない: ${startRe}`)
  // function/interface は常にカラム0の `}` までのブロック（シグネチャが複数行でもよい）。
  // const は `{`/`[` で終わる行のみ複数行ブロック、それ以外は1行宣言
  const first = lines[startIdx]
  const firstTrim = first.trimEnd()
  const isBlockDecl = /^(async )?function |^interface /.test(first)
  if (!isBlockDecl && !firstTrim.endsWith('{') && !firstTrim.endsWith('[')) return first
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '}' || lines[i] === ']') return lines.slice(startIdx, i + 1).join('\n')
  }
  throw new Error(`終了 } が見つからない: ${startRe}`)
}

/** 直前のdocコメント（/** ... *\/）も含めて抽出 */
function extractWithDoc(startRe) {
  const body = extractBlock(startRe)
  return body
}

const parts = []

parts.push(`// ═══════════════════════════════════════════════════════════════════════════
// 自動生成: node scripts/sync_zone_functions.mjs（直接編集しない）
// inbound-email/index.ts のゾーンA〜E/T関数を分岐網羅テスト用に抽出したもの。
// 外部依存は deps シム経由（テストがモックを注入する）。
// ═══════════════════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-explicit-any no-unused-vars

export const deps: Record<string, any> = {}
const fetchWithTimeout = (...a: any[]): Promise<Response> => deps.fetchWithTimeout(...a)
const extractExcelAll = (...a: any[]) => deps.extractExcelAll(...a)
const extractWordText = (...a: any[]) => deps.extractWordText(...a)
const extractPdfText = (...a: any[]) => deps.extractPdfText(...a)
const cleanseWordText = (t: string) => deps.cleanseWordText ? deps.cleanseWordText(t) : t
const uploadToStorage = (...a: any[]) => deps.uploadToStorage(...a)
const extractNameFallback = (...a: any[]) => deps.extractNameFallback(...a)
const extractSkillYearsFromSheetData = (...a: any[]) => deps.extractSkillYearsFromSheetData(...a)

interface Attachment { data: string; mimeType: string; name?: string }
`)

// 抽出対象（依存順）
const targets = [
  [/^function arrayBufferToBase64\(/, 'arrayBufferToBase64'],
  [/^interface SourceEntry \{/, null],
  [/^function createLedger\(/, 'createLedger'],
  [/^type Ledger = /, null],
  [/^function filenameFromDisposition\(/, 'filenameFromDisposition'],
  [/^function detectGoogleLinks\(/, 'detectGoogleLinks'],
  [/^async function fetchCsvFingerprint\(/, 'fetchCsvFingerprint'],
  [/^const XLSX_EXPORT_MIME = /, null],
  [/^const DOCX_EXPORT_MIME = /, null],
  [/^const DRIVE_SKIP_KEYWORDS = /, null],
  [/^const EXCEL_MIME = /, null],
  [/^const WORD_MIME = /, null],
  [/^async function fetchSheetsEntry\(/, 'fetchSheetsEntry'],
  [/^async function fetchDocsEntry\(/, 'fetchDocsEntry'],
  [/^async function fetchDriveEntry\(/, 'fetchDriveEntry'],
  [/^function matchSheetByFingerprint\(/, 'matchSheetByFingerprint'],
  [/^async function extractEntry\(/, 'extractEntry'],
  [/^const MULTI_CANDIDATE_FIELD_RE = /, null],
  [/^const MULTI_NAME_FIELD_RE = /, null],
  [/^function looksLikeRosterName\(/, 'looksLikeRosterName'],
  [/^function detectRoster\(/, 'detectRoster'],
  [/^async function fetchLinkedResume\(/, 'fetchLinkedResume'],
  [/^const ROSTER_MAX_ROWS = /, null],
  [/^async function expandRosterEntries\(/, 'expandRosterEntries'],
  [/^function gateSingleCandidate\(/, 'gateSingleCandidate'],
  [/^function promoteUnassignedRosterEntries\(/, 'promoteUnassignedRosterEntries'],
  [/^function pickBodyResumeLink\(/, 'pickBodyResumeLink'],
  [/^async function resolveResumeUrl\(/, 'resolveResumeUrl'],
  [/^function pickSkillYears\(/, 'pickSkillYears'],
]

const exportNames = ['deps']
for (const [re, exportName] of targets) {
  parts.push(extractWithDoc(re))
  if (exportName) exportNames.push(exportName)
}

parts.push(`\nexport {\n  ${exportNames.slice(1).join(',\n  ')},\n}\n`)
parts.push(`export type { SourceEntry, Ledger, Attachment }\n`)

writeFileSync(OUT, parts.join('\n\n'))
console.log(`✅ _zone_functions.gen.ts を生成しました（${exportNames.length - 1}関数）`)
