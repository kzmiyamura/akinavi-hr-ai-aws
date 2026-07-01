import { readdirSync } from 'fs'
import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testData/excel')
const files = readdirSync(dir).filter(f => /\.(xlsx?|xls)$/i.test(f))

for (const file of files) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`FILE: ${file}`)
  const wb = XLSX.readFile(join(dir, file))
  const sheetName = wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].map(c => String(c ?? '').split(/[\r\n]/)[0].trim())
    if (cells.some(c => c)) {
      console.log(`  [${i}] ${cells.slice(0, 9).join(' | ')}`)
    }
  }
}
