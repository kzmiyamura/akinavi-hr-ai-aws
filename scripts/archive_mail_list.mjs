#!/usr/bin/env node
/**
 * 回収したメール（outlook_export.ps1 の出力）を一覧する。**本番は引かない。**
 *
 *   node scripts/archive_mail_list.mjs                 # 添付ありのメールを新しい順
 *   node scripts/archive_mail_list.mjs --ext xlsx      # 拡張子で絞る
 *   node scripts/archive_mail_list.mjs --grep 名簿      # 件名・添付名で絞る
 *   node scripts/archive_mail_list.mjs --all           # 添付なしも含める
 *
 * 保存先は既定 D:\akinavi-archive\mail（AKINAVI_MAIL_DIR で変更可）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.env.AKINAVI_MAIL_DIR ?? 'D:\\akinavi-archive\\mail')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : null
}
const ext = flag('ext')
const grep = flag('grep')
const showAll = args.includes('--all')

if (!existsSync(ROOT)) {
  console.error(`回収先が見つかりません: ${ROOT}`)
  process.exit(1)
}

/** PowerShell の Out-File は BOM を付ける。Node の JSON.parse は BOM で落ちる */
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

const rows = []
for (const day of readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
  for (const msg of readdirSync(join(ROOT, day))) {
    const dir = join(ROOT, day, msg)
    const metaPath = join(dir, 'message.json')
    if (!existsSync(metaPath)) continue
    let meta
    try { meta = readJson(metaPath) } catch { continue }
    const atts = (meta.attachments ?? []).map((a) => ({
      ...a,
      path: join(dir, a.file),
      bytes: existsSync(join(dir, a.file)) ? statSync(join(dir, a.file)).size : 0,
    }))
    rows.push({ day, dir, subject: meta.subject ?? '', from: meta.from ?? '', received: meta.receivedTime, atts })
  }
}

let list = showAll ? rows : rows.filter((r) => r.atts.length > 0)
if (ext) list = list.filter((r) => r.atts.some((a) => a.file.toLowerCase().endsWith(`.${ext.toLowerCase()}`)))
if (grep) {
  const g = grep.toLowerCase()
  list = list.filter((r) =>
    r.subject.toLowerCase().includes(g) || r.atts.some((a) => (a.original ?? '').toLowerCase().includes(g)))
}

for (const r of list) {
  console.log(`${r.received}  ${r.subject}`)
  for (const a of r.atts) {
    console.log(`    ${(a.bytes / 1024).toFixed(0).padStart(5)} KB  ${a.original}`)
    console.log(`           ${a.path}`)
  }
}
console.log(`\n${list.length} 通 / 回収先 ${ROOT}`)
