/** 装飾・罫線系の記号パターン（Excelスキルシートによく含まれる） */
const DECORATION_RE = /^[\s★■□●◆◇▼▽△▲◎○※・－—─━═＝=\-─*#~_|/\\]+$/

/**
 * HTML テーブルを 2D グリッドに展開する（rowspan/colspan 対応）。
 * SheetJS の sheet_to_html / mammoth の convertToHtml 両方に対応。
 * Edge Function 側の parseHtmlTableToGrid と同一ロジック。
 */
function parseHtmlTableToGrid(html: string): string[][] {
  const grid: string[][] = []
  const occupied = new Map<string, string>()
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let ri = 0
  let trM: RegExpExecArray | null
  while ((trM = trRe.exec(html)) !== null) {
    let ci = 0
    const cellRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi
    let cellM: RegExpExecArray | null
    while ((cellM = cellRe.exec(trM[1])) !== null) {
      const attrs = cellM[1]
      const rawVal = cellM[2]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, c => { const n = parseInt(c.slice(2)); return isNaN(n) ? c : String.fromCharCode(n) })
        .trim()
      const colspan = parseInt(attrs.match(/colspan="(\d+)"/)?.[1] ?? '1')
      const rowspan = parseInt(attrs.match(/rowspan="(\d+)"/)?.[1] ?? '1')
      while (occupied.has(`${ri},${ci}`)) ci++
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          while (grid.length <= ri + dr) grid.push([])
          grid[ri + dr][ci + dc] = rawVal
          occupied.set(`${ri + dr},${ci + dc}`, rawVal)
        }
      }
      ci += colspan
    }
    ri++
  }
  return grid
}

/**
 * 2D グリッドを読みやすいテキストに変換する。
 * - 空セル・装飾セルを除去
 * - 連続する同値セル（colspan展開の重複）を排除
 * - 2セル行は「ラベル：値」形式、それ以外はスペース区切り
 * Edge Function 側の gridToText と同一ロジック。
 */
function gridToText(grid: string[][], maxChars = 6000): string {
  const lines: string[] = []
  for (const row of grid) {
    const cells: string[] = []
    let prev = ''
    for (const c of row) {
      const v = c?.trim() ?? ''
      if (!v || DECORATION_RE.test(v)) continue
      if (v !== prev) cells.push(v)
      prev = v
    }
    if (cells.length === 0) continue
    lines.push(cells.length === 2 ? `${cells[0]}：${cells[1]}` : cells.join(' '))
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...(省略)' : text
}

/**
 * Word ファイル (.docx) から構造化テキストを抽出する。
 * convertToHtml → parseHtmlTableToGrid でテーブル構造を保持。
 * Edge Function 側の extractWordText と同じルート。
 */
export async function extractTextFromWord(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  try {
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer })
    const html = htmlResult.value
    if (html.trim()) {
      // テーブル部分: parseHtmlTableToGrid → gridToText
      const grid = parseHtmlTableToGrid(html)
      const tableText = gridToText(grid)

      // テーブル外の段落・リスト: DOMParser で取得
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const paragraphs: string[] = []
      for (const el of Array.from(doc.querySelectorAll('p, li'))) {
        if (el.closest('table')) continue
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text) paragraphs.push(text)
      }

      const combined = [tableText, ...paragraphs].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim()
      if (combined) return combined
    }
  } catch {
    // フォールバックへ
  }
  // フォールバック: extractRawText（テーブル構造なし）
  const rawResult = await mammoth.extractRawText({ arrayBuffer })
  return rawResult.value
}

/**
 * Excel ファイル (.xlsx / .xls) から構造化テキストを抽出する。
 * sheet_to_html → parseHtmlTableToGrid → gridToText でセル結合を保持。
 * Edge Function 側の extractExcelAll と同じルート。
 */
export async function extractTextFromExcel(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const PRIORITY_KEYWORDS = ['スキル', '経歴', '職務', 'スキルシート', 'skill', 'career', 'profile', '人材']
  const sortedNames = [...workbook.SheetNames].sort((a, b) => {
    const ap = PRIORITY_KEYWORDS.some(kw => a.toLowerCase().includes(kw.toLowerCase())) ? 0 : 1
    const bp = PRIORITY_KEYWORDS.some(kw => b.toLowerCase().includes(kw.toLowerCase())) ? 0 : 1
    return ap - bp
  })
  const parts: string[] = []
  for (const sheetName of sortedNames.slice(0, 3)) {
    const sheet = workbook.Sheets[sheetName]
    const html = XLSX.utils.sheet_to_html(sheet)
    const grid = parseHtmlTableToGrid(html)
    const text = gridToText(grid)
    if (text.trim()) parts.push(`[シート: ${sheetName}]\n${text}`)
  }
  return parts.join('\n\n')
}

/** 画像ファイルを base64 に変換する（Gemini multimodal 用） */
export async function imageFileToBase64(
  file: File,
): Promise<{ mimeType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      resolve({ mimeType: file.type, data: base64 })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** ファイルの種類を判定する */
export function getFileCategory(
  file: File,
): 'pdf' | 'excel' | 'word' | 'image' | 'unsupported' {
  if (file.type === 'application/pdf') return 'pdf'
  if (
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel' ||
    file.name.endsWith('.xlsx') ||
    file.name.endsWith('.xls')
  ) return 'excel'
  if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.name.endsWith('.docx')
  ) return 'word'
  if (file.type.startsWith('image/')) return 'image'
  return 'unsupported'
}
