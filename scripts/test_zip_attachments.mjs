// ZIP添付展開のテスト。
//
// 判定ロジック（isZipAttachment / planZipEntries）は _extractors.gen.mjs 経由で
// index.ts の実物を読む。手書きレプリカを持たないので本番と食い違わない。
// index.ts を変更したら先に `node scripts/sync_extractors.mjs` を実行すること。
//
//   node scripts/test_zip_attachments.mjs
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { zipSync, unzipSync } from 'fflate'
import XLSX from 'xlsx'
import { isZipAttachment, planZipEntries } from './_extractors.gen.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TESTDATA = join(__dirname, 'testData')

// index.ts の expandZipAttachments と同じ組み立て。
// 採否は planZipEntries（本番の実物）に委ね、ここは unzip と base64 化だけを行う。
const toBase64 = (u8) => {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH))
  return btoa(s)
}
const fromBase64 = (b64) => {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

function expandZipAttachments(attachments) {
  const out = [], notes = [], skipped = []
  if (!attachments.some(isZipAttachment)) return { attachments, notes, skipped }
  for (const att of attachments) {
    if (!isZipAttachment(att)) { out.push(att); continue }
    const zipLabel = att.name ?? 'archive.zip'
    let files
    try {
      files = unzipSync(fromBase64(att.data))
    } catch (e) {
      skipped.push(`${zipLabel}: 展開失敗 (${String(e).slice(0, 80)})`)
      continue
    }
    const plan = planZipEntries(zipLabel, Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length })))
    for (const p of plan.picks) out.push({ data: toBase64(files[p.path]), mimeType: p.mimeType, name: p.name })
    skipped.push(...plan.skipped)
    notes.push(`${zipLabel}: ${plan.picks.length}件展開`)
  }
  return { attachments: out, notes, skipped }
}

const xlsxFiles = readdirSync(TESTDATA).filter(f => f.endsWith('.xlsx')).slice(0, 3)
if (xlsxFiles.length < 2) {
  console.error(`テスト用xlsxが足りません（${TESTDATA} に2件以上必要）。`)
  console.error('PIIのため git 管理外です。node scripts/download_failing_excels.mjs で取得してください。')
  process.exit(1)
}
const xlsxBytes = (i) => new Uint8Array(readFileSync(join(TESTDATA, xlsxFiles[i])))
console.log(`テスト素材: ${xlsxFiles.join(', ')}\n`)

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// --- ケース1: 日本語名xlsxを2つ入れた通常のZIP（スキルシート.zip の実態） ---
{
  const zip = zipSync({ 'スキルシート_A.xlsx': xlsxBytes(0), 'スキルシート_B.xlsx': xlsxBytes(1) })
  const att = { data: toBase64(zip), mimeType: 'application/octet-stream', name: 'スキルシート.zip' }
  const { attachments, notes } = expandZipAttachments([att])

  check('ケース1: ZIPが2件のxlsxに展開される', attachments.length === 2, notes.join(' / '))
  check('ケース1: ZIP自体は結果に残らない', !attachments.some(a => /\.zip$/i.test(a.name)))
  check('ケース1: mimeTypeがxlsxに補正される', attachments.every(a => a.mimeType.includes('spreadsheetml')))
  check('ケース1: 名前にZIP名が残り出所が追える', attachments.every(a => a.name.startsWith('スキルシート.zip:')))

  const info = []
  let parsedOk = 0
  for (const a of attachments) {
    try {
      const wb = XLSX.read(fromBase64(a.data), { type: 'array', cellDates: true })
      if (wb.SheetNames.length > 0) { parsedOk++; info.push(`${a.name}→${wb.SheetNames.length}シート`) }
    } catch (e) { info.push(`${a.name}→失敗 ${String(e).slice(0, 60)}`) }
  }
  check('ケース1: 展開結果が既存Excelパーサで読める', parsedOk === 2, info.join(', '))

  const orig = xlsxBytes(0)
  const got = fromBase64(attachments.find(a => a.name.endsWith('_A.xlsx')).data)
  check('ケース1: バイト列が元ファイルと完全一致', orig.length === got.length && orig.every((b, i) => b === got[i]))
}

// --- ケース2: 対応形式と非対応形式・OSのゴミが混在 ---
{
  const zip = zipSync({
    '経歴書.xlsx': xlsxBytes(0),
    '会社案内.pptx': new Uint8Array([1, 2, 3, 4]),
    'メモ.txt': new TextEncoder().encode('hello'),
    '__MACOSX/._経歴書.xlsx': new Uint8Array([0]),
    '.DS_Store': new Uint8Array([0]),
  })
  const { attachments, skipped } = expandZipAttachments([{ data: toBase64(zip), mimeType: 'application/zip', name: 'まとめ.zip' }])
  check('ケース2: 対応形式(xlsx)だけ拾う', attachments.length === 1 && attachments[0].name.includes('経歴書.xlsx'))
  check('ケース2: __MACOSX/.DS_Store は記録も残さず無視',
    !skipped.some(s => s.includes('MACOSX') || s.includes('DS_Store')))
  check('ケース2: 非対応形式は理由が残る',
    skipped.some(s => s.includes('pptx')) && skipped.some(s => s.includes('txt')), skipped.join(' / '))
}

// --- ケース3: ネストZIPは展開しない（再帰の入口を作らない） ---
{
  const inner = zipSync({ 'a.xlsx': xlsxBytes(0) })
  const zip = zipSync({ 'inner.zip': inner, '直下.xlsx': xlsxBytes(1) })
  const { attachments, skipped } = expandZipAttachments([{ data: toBase64(zip), mimeType: 'application/zip', name: 'nest.zip' }])
  check('ケース3: ネストZIPは再帰展開しない',
    attachments.length === 1 && attachments[0].name.includes('直下.xlsx'), skipped.join(' / '))
}

// --- ケース4: 壊れたZIPで例外を外に出さない ---
{
  const { attachments, skipped } = expandZipAttachments(
    [{ data: toBase64(new Uint8Array([80, 75, 3, 4, 9, 9, 9])), mimeType: 'application/zip', name: '壊れ.zip' }])
  check('ケース4: 壊れたZIPで落ちず理由が残る', attachments.length === 0 && skipped.length === 1, skipped.join(''))
}

// --- ケース5: ZIP以外の添付は素通し（既存挙動を壊さない） ---
{
  const plain = { data: toBase64(new Uint8Array([1, 2, 3])), mimeType: 'application/pdf', name: 'x.pdf' }
  const { attachments, notes } = expandZipAttachments([plain])
  check('ケース5: 非ZIP添付は素通し', attachments.length === 1 && attachments[0] === plain && notes.length === 0)
}

// --- ケース6: Shift_JIS(CP932)名のZIP（Windows製の実態） ---
{
  // fflateはファイル名をUTF-8前提で復号する。名前は化けるが拡張子(ASCII)は生き残ることを確認する。
  const zip = zipSync({ 'PLACEHOLDER.xlsx': xlsxBytes(0) })
  const buf = Buffer.from(zip)
  const target = Buffer.from('PLACEHOLDER.xlsx', 'ascii')
  const cp932Base = Buffer.from([0x8c, 0x6f, 0x97, 0xf0, 0x8f, 0x91]) // 「経歴書」のCP932
  const ext = Buffer.from('.xlsx', 'ascii')
  const padded = Buffer.concat([cp932Base, Buffer.alloc(target.length - cp932Base.length - ext.length, 0x5f), ext])
  let idx = 0
  while ((idx = buf.indexOf(target, idx)) !== -1) { padded.copy(buf, idx); idx += padded.length }

  const { attachments } = expandZipAttachments([{ data: toBase64(new Uint8Array(buf)), mimeType: 'application/zip', name: 'win.zip' }])
  check('ケース6: CP932名でも拾えて拡張子判定が効く',
    attachments.length === 1 && attachments[0].mimeType.includes('spreadsheetml'),
    `復号名="${attachments[0]?.name ?? '(なし)'}"`)
}

// --- ケース7: zip爆弾の上限（件数） ---
{
  const entries = {}
  for (let i = 0; i < 25; i++) entries[`file${i}.csv`] = new TextEncoder().encode('a,b,c')
  const { attachments, skipped } = expandZipAttachments(
    [{ data: toBase64(zipSync(entries)), mimeType: 'application/zip', name: 'bomb.zip' }])
  check('ケース7: エントリ数上限で打ち切る',
    attachments.length === 20 && skipped.some(s => s.includes('エントリ数上限')), `展開${attachments.length}件`)
}

const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length) { console.log('失敗:', failed.map(f => f.name).join(', ')); process.exit(1) }
