// llm_extract/textract.mjs — docx / pdf の経歴書をテキスト行に落とす
// xlsx のグリッドと違い構造は失われるが、行の並び（期間→技術の近接）は保たれるので
// 転記プロンプト(TEXT版) + 既存の機械検証（行集合ベース）がそのまま使える。

/** docx → テキスト。表は行優先で cell ごとに改行される（mammoth の仕様） */
export async function extractDocxText(filePath) {
  const mammoth = (await import('mammoth')).default
  const { value } = await mammoth.extractRawText({ path: filePath })
  return value
}

/** pdf → テキスト。y座標でグルーピングして「視覚上の1行 = 1行」に再構成する */
export async function extractPdfText(filePath) {
  const fs = await import('fs')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await getDocument({
    data: new Uint8Array(fs.readFileSync(filePath)),
    verbosity: 0,
    useSystemFonts: true,
  }).promise
  const pages = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      // y(transform[5]) を丸めて行にまとめ、行内は x(transform[4]) 順
      const lines = new Map()
      for (const it of tc.items) {
        const s = String(it.str ?? '')
        if (!s.trim()) continue
        const y = Math.round(it.transform[5] / 4) * 4
        if (!lines.has(y)) lines.set(y, [])
        lines.get(y).push({ x: it.transform[4], s })
      }
      const ordered = [...lines.entries()].sort((a, b) => b[0] - a[0])
        .map(([, items]) => items.sort((a, b) => a.x - b.x).map(i => i.s).join(' '))
      pages.push(ordered.join('\n'))
    }
  } finally {
    await doc.destroy()
  }
  return pages.join('\n')
}

/** 拡張子に応じてテキスト抽出。対応外は null */
export async function extractResumeText(filePath, ext) {
  if (ext === 'docx') return extractDocxText(filePath)
  if (ext === 'pdf') return extractPdfText(filePath)
  return null
}
