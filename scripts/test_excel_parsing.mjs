/**
 * ローカルExcelファイルに対してskillYears抽出ロジックをテストする
 * inbound-email/index.ts の extractSkillYearsFromSheetData をJS移植して試す
 */
import { readdirSync } from 'fs'
import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testData/excel')

// ── 移植: inbound-email/index.ts から ──────────────────────────────

function parseDurationToMonths(text) {
  if (!text || typeof text !== 'string') return null
  const t = text.trim()
  let months = 0
  const yearMatch = t.match(/(\d+)\s*年/)
  const monthMatch = t.match(/(\d+)\s*[ヶか]月/)
  if (yearMatch) {
    const y = parseInt(yearMatch[1])
    if (y > 50) return null
    months += y * 12
  }
  if (monthMatch) months += parseInt(monthMatch[1])
  return months > 0 ? months : null
}

function excelSerialToDateStr(s) {
  const n = parseInt(s)
  if (isNaN(n) || n < 36526 || n > 50000) return s
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`
}

function calcMonthsFromDates(start, end) {
  const parseYM = (s) => {
    const normalized = excelSerialToDateStr(s.trim())
    const m = normalized.match(/(\d{2,4})[\/\-年](\d{1,2})/)
    if (!m) return null
    let year = parseInt(m[1])
    if (year < 100) year = year < 50 ? 2000 + year : 1900 + year
    return { year, month: parseInt(m[2]) }
  }
  const s = parseYM(start)
  const e = parseYM(end)
  if (!s || !e) return null
  const months = (e.year - s.year) * 12 + (e.month - s.month) + 1
  return months > 0 ? months : null
}

/** セル内に "2025年3月\n～\n2026年2月" 形式で開始〜終了が入っている場合に月数を抽出 */
function calcMonthsFromMultilineCell(cellValue) {
  const parts = cellValue.split(/[\r\n]+/).map(s => s.trim())
    .filter(s => s && !/^[～~〜\-－]$/.test(s) && s !== '現在' && s !== '継続中')
  if (parts.length < 2) return null
  return calcMonthsFromDates(parts[0], parts[parts.length - 1])
}

function extractSkillYearsFromSheetData(data) {
  const EXP_LABEL = /IT経験|開発経験|エンジニア歴|経験年数|総経験|業務経験/
  for (let i = 0; i < Math.min(30, data.length); i++) {
    const row = data[i]
    for (let j = 0; j < row.length; j++) {
      const v = String(row[j] ?? '').trim()
      if (!EXP_LABEL.test(v)) continue
      if (/凡例|◎＝|○＝|◇＝|△＝|▲＝/.test(v)) continue
      const inCell = parseDurationToMonths(v)
      if (inCell) return { _totalProjectMonths: inCell }
      for (let k = j + 1; k <= Math.min(row.length - 1, j + 3); k++) {
        const adj = parseDurationToMonths(String(row[k] ?? ''))
        if (adj) return { _totalProjectMonths: adj }
      }
    }
  }

  // Method 1
  let langColIdx = -1, fwColIdx = -1, headerRowIdx = -1
  for (let i = 0; i < Math.min(60, data.length); i++) {
    const row = data[i]
    for (let j = 0; j < row.length; j++) {
      const v = String(row[j] ?? '').split(/[\r\n]/)[0].trim()
      if ((v.includes('使用言語') || v === '言語' || v.includes('使用技術') || v.includes('技術スタック') || v === '技術' || v === '言語/技術'
           || v.includes('開発言語')  // "OS・DB・開発言語" 等の複合ヘッダー対応
           || (v.includes('言語') && (v.includes('FW') || v.includes('ツール') || v.includes('技術')))
         ) && langColIdx < 0) { langColIdx = j; headerRowIdx = i }
      if ((v.includes('FW') || v.includes('ツール') || v.includes('フレームワーク') || v.includes('ミドル')) && fwColIdx < 0 && j !== langColIdx) fwColIdx = j
    }
    if (langColIdx >= 0) break
  }
  if (langColIdx >= 0) {
    const skillMonths = {}
    const projectPeriods = []
    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const row = data[i]
      const noCell = String(row[0] ?? '').trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      if (!noCell || !/^\d+$/.test(noCell)) continue
      const langCell = String(row[langColIdx] ?? '').trim()
      const fwCell = fwColIdx >= 0 ? String(row[fwColIdx] ?? '').trim() : ''
      let months = null
      for (let di = 1; di <= 3 && !months; di++) {
        if (i + di < data.length) {
          months = parseDurationToMonths(String(data[i + di][1] ?? ''))
               ?? parseDurationToMonths(String(data[i + di][2] ?? ''))
        }
      }
      // 開始〜終了が同一セル内（"2025年3月\n～\n2026年2月"）の場合
      if (!months) months = calcMonthsFromMultilineCell(String(row[1] ?? ''))
      // col[1]/col[3] が別々の日付の場合
      if (!months) months = calcMonthsFromDates(String(row[1] ?? ''), String(row[3] ?? ''))
      if (!months || months <= 0) {
        // デバッグ出力
        process.stdout.write(`    [DBG] row${i} no=${noCell} lang="${langCell}" months=null (row1="${String(row[1]??'').trim().slice(0,15)}" row3="${String(row[3]??'').trim().slice(0,15)}")\n`)
        continue
      }
      projectPeriods.push({ start: String(row[1] ?? ''), end: String(row[3] ?? ''), months })
      const skillTexts = (langCell + '\n' + fwCell).split(/[\n\r、，,]+/).map(s => s.trim())
        .filter(s => s && s !== '-' && s !== '－' && !/^[\s\-－]+$/.test(s))
      for (const skill of skillTexts) skillMonths[skill] = (skillMonths[skill] ?? 0) + months
    }
    if (Object.keys(skillMonths).length > 0) return skillMonths
    else process.stdout.write(`    [DBG] Method1: langColIdx=${langColIdx} but all skills empty\n`)
  }

  // Method 3
  const EXP_YEAR_HEADER = /^(経験年数|経験年|経験\(年\)|年数|年|Years?|Exp\.?)$/i
  const SKILL_COL_HEADER = /^(スキル名?|技術名?|使用技術|言語|技術スタック|item|技術項目)$/i
  let expYrCol = -1, skillCol3 = -1, hdrRow3 = -1
  for (let i = 0; i < Math.min(60, data.length); i++) {
    const row = data[i]
    for (let j = 0; j < row.length; j++) {
      const v = String(row[j] ?? '').trim()
      if (EXP_YEAR_HEADER.test(v) && expYrCol < 0) { expYrCol = j; hdrRow3 = i }
      if (SKILL_COL_HEADER.test(v) && skillCol3 < 0) skillCol3 = j
    }
    if (expYrCol >= 0 && skillCol3 >= 0) break
  }
  if (expYrCol >= 0 && skillCol3 >= 0 && skillCol3 !== expYrCol) {
    const SM3 = {}
    const BLOCKLIST3 = /^(自己PR|PR|備考|補足|資格|氏名|年齢|性別|国籍|住所|学歴|経歴|担当|役割|役職|ポジション|立場|評価|合計|スコア|レベル|プロジェクト名|企業名|規模|人数|期間|開始|終了|弊社社員|自社社員|社員|派遣|契約|フリー)$/
    for (let i = hdrRow3 + 1; i < data.length; i++) {
      const row = data[i]
      const expRaw = String(row[expYrCol] ?? '').trim()
      const yearsNum = parseFloat(expRaw)
      if (isNaN(yearsNum) || yearsNum <= 0 || yearsNum > 50) continue
      const skillName = String(row[skillCol3] ?? '').trim()
      if (!skillName || skillName.length < 2 || /^\d+$/.test(skillName) || BLOCKLIST3.test(skillName)) continue
      SM3[skillName] = Math.max(SM3[skillName] ?? 0, Math.round(yearsNum * 12))
    }
    if (Object.keys(SM3).length > 0) return SM3
  }

  return {}
}

// ── テスト実行 ──────────────────────────────────────────────────────

const files = readdirSync(dir).filter(f => /\.(xlsx?|xls)$/i.test(f))

for (const file of files) {
  console.log(`\n${'='.repeat(50)}`)
  console.log(`${file}`)
  const wb = XLSX.readFile(join(dir, file))
  for (const sheetName of wb.SheetNames.slice(0, 2)) {
    const ws = wb.Sheets[sheetName]
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      .map(row => row.map(c => String(c ?? '')))
    const result = extractSkillYearsFromSheetData(data)
    const skills = Object.entries(result).filter(([k]) => !k.startsWith('_'))
    if (skills.length > 0) {
      console.log(`  ✅ ${skills.length}スキル取得: ${skills.slice(0,5).map(([k,v])=>`${k}(${Math.round(v/12)}年)`).join(', ')}`)
    } else if (result._totalProjectMonths) {
      console.log(`  ⚠️  スキルなし / 総月数=${result._totalProjectMonths}ヶ月`)
    } else {
      console.log(`  ❌ 取得ゼロ`)
    }
  }
}
