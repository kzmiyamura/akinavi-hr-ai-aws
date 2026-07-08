#!/usr/bin/env node
// audit_resume_mismatch.mjs の結果(/tmp/resume_mismatch_result.json)を精査し、
// 「名前汚染による誤検出」か「本当に他人の経歴書が疑われるケース」かを分類する。
import { readFileSync, writeFileSync } from 'fs'
import XLSX from 'xlsx'
import mammoth from 'mammoth'

const data = JSON.parse(readFileSync('/tmp/resume_mismatch_result.json', 'utf-8'))
const mismatches = data.mismatches

function normalize(s) {
  return (s ?? '').toLowerCase().replace(/[.\s　・【】\[\]()（）]/g, '')
}

// コア名抽出: 先頭の「英字イニシャル(区切り記号入り)」または「漢字姓+英字」パターンのみを取り出す
function extractCoreName(name) {
  const m = name.match(/^([一-龥々]{1,3}[\s　]*[A-Za-zＡ-Ｚａ-ｚ]{1,4}|[A-Za-zＡ-Ｚａ-ｚ][.\s　・]?[A-Za-zＡ-Ｚａ-ｚ][.\s　・]?[A-Za-zＡ-Ｚａ-ｚ]?)/)
  return m ? m[1] : name
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
  } catch (e) { return null }
  return null
}

// 添付内で最も出現頻度の高い「氏名」ラベル直後の値を探す（誰の経歴書かのヒント）
function findNameLabelValues(text) {
  const results = new Set()
  const re = /(?:氏\s*名|技術者名|イニシャル|技術者氏名)[：:\s　]*([A-Za-zＡ-Ｚａ-ｚ.\s　・一-龥々]{2,15})/g
  let m
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim().split(/[\n\r]/)[0].trim()
    if (v && v.length <= 15) results.add(v)
  }
  return [...results].slice(0, 3)
}

const trueMismatch = []
const falsePositive = []

let i = 0
for (const cand of mismatches) {
  i++
  const coreName = extractCoreName(cand.name)
  const normCore = normalize(coreName)
  // ラベルそのものが名前として抽出されたケース（抽出失敗、他人混入ではない）
  const isLabelFailure = /^(性別|年齢|国籍|生年月日|TA|ＹＫ)[：:]?/.test(cand.name.trim()) && cand.name.trim().length <= 6

  if (isLabelFailure) {
    falsePositive.push({ ...cand, reason: '名前抽出失敗（フィールドラベルを氏名と誤認識）', coreName })
    continue
  }

  try {
    const res = await fetch(cand.resume_url)
    if (!res.ok) { falsePositive.push({ ...cand, reason: `再チェック時HTTPエラー${res.status}`, coreName }); continue }
    const buf = Buffer.from(await res.arrayBuffer())
    const text = await extractText(buf, cand.resume_url)
    if (text === null) { falsePositive.push({ ...cand, reason: '再チェック時パース失敗', coreName }); continue }
    const normText = normalize(text)
    if (normText.includes(normCore) && normCore.length >= 2) {
      falsePositive.push({ ...cand, reason: '名前欄への余分な説明文混入による誤検出（コア名は本文に一致）', coreName })
    } else {
      const hints = findNameLabelValues(text)
      trueMismatch.push({ ...cand, coreName, hints })
    }
  } catch (e) {
    falsePositive.push({ ...cand, reason: `再チェックエラー:${e.message}`, coreName })
  }
  if (i % 20 === 0) console.error(`... ${i}/${mismatches.length}`)
}

console.log(`\n=== 分類結果 ===`)
console.log(`本当に疑わしい: ${trueMismatch.length}`)
console.log(`誤検出（名前汚染等）: ${falsePositive.length}`)

writeFileSync('/tmp/mismatch_classified.json', JSON.stringify({ trueMismatch, falsePositive }, null, 2))
console.log('\n詳細を /tmp/mismatch_classified.json に保存しました')
