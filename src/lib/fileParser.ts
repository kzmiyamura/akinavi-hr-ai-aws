/** Excel ファイル (.xlsx / .xls) から全シートのテキストを抽出する（xlsx を遅延ロード） */
export async function extractTextFromExcel(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const text = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    if (text.trim()) {
      parts.push(`[シート: ${sheetName}]\n${text}`)
    }
  }
  return parts.join('\n\n')
}

/** Word ファイル (.docx) から本文テキストを抽出する（mammoth を遅延ロード） */
export async function extractTextFromWord(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
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
