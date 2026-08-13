// pdf_text.mjs — 本番 inbound-email の extractPdfText と同じ手順で PDF からテキストを復元する
//
// 本番（index.ts:3151 extractPdfText）は Y座標で行を復元してから regex に渡す。
// 調査ツールが違う作り方をすると「本番では取れないのにローカルでは取れる」を再生産する
// （probe_skillyears で実際にやらかした。HANDOFF「調査ツールと本番で入力が違う」参照）。
// PDF を読むツールは必ずここを通すこと。
//
// 本番は unpdf(pdf.js) / ここは pdfjs-dist。どちらも pdf.js なので TextItem の形は同じ。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** PDF バイト列から行復元済みの行配列を返す（本番 extractPdfText の①と同じ） */
export async function extractPdfLines(bytes) {
  const pdf = await getDocument({ data: bytes, useSystemFonts: true }).promise
  const lines = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent()
    const byRow = new Map()
    for (const it of content.items) {
      const s = it.str ?? ''
      if (!s.trim()) continue
      const tr = it.transform
      if (!Array.isArray(tr) || tr.length < 6) continue
      const key = Math.round(tr[5])          // transform[5] = Y
      if (!byRow.has(key)) byRow.set(key, [])
      byRow.get(key).push({ x: tr[4], s })   // transform[4] = X
    }
    // Y は下から上に増えるので降順、行内は X 昇順
    for (const y of [...byRow.keys()].sort((a, b) => b - a)) {
      const raw = byRow.get(y).sort((a, b) => a.x - b.x).map((v) => v.s).join(' ')
      const line = raw
        .replace(/(\d)\s+([年月日])/g, '$1$2')
        .replace(/([年月])\s+(\d)/g, '$1$2')
        .replace(/(\d)\s+[\/／]\s+(\d)/g, '$1/$2')
        .trim()
      if (line) lines.push(line)
    }
  }
  return { lines, numPages: pdf.numPages }
}

/** 本番同様、添付テキストは 8000 字で切って下流に渡される（index.ts の slice(0,8000) に合わせる） */
export const ATTACH_TEXT_LIMIT = 8000
