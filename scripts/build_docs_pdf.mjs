#!/usr/bin/env node
/**
 * build_docs_pdf.mjs — 設定画面から開くドキュメントの HTML/PDF を Markdown から作り直す
 *
 * 設定画面の「ドキュメント」は `public/docs/*.pdf` を開いている。これが手作業生成で、
 * 2026-05-23 の内容のまま更新されていなかった（環境構築ガイドが古い、の原因）。
 * Markdown を正として毎回作り直せるようにする。
 *
 * 使い方:
 *   node scripts/build_docs_pdf.mjs          # HTML を生成（PDF は macOS のみ自動）
 *   node scripts/build_docs_pdf.mjs --html   # HTML だけ
 *
 * PDF 化は macOS 標準の cupsfilter を使う（追加インストール不要）。
 * cupsfilter が無い環境（Windows/Linux）では HTML までを生成し、
 * ブラウザで開いて Ctrl+P →「PDFとして保存」で作れる旨を表示する。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 設定画面のリンクに載っているものだけを対象にする（SettingsPage.tsx と対応） */
const DOCS = [
  { md: 'docs/Sales_Manual.md', out: 'Sales_Manual', title: '操作マニュアル（営業向け）' },
  { md: 'docs/HandsOn_Setup.md', out: 'HandsOn_Setup', title: '環境構築ガイド' },
  { md: 'README.md', out: 'README', title: 'システム概要' },
  { md: 'docs/DataEnv_Demo_Prod.md', out: 'DataEnv_Demo_Prod', title: 'デモ／本番環境の説明' },
  { md: 'docs/Outlook_AutoForward_Setup.md', out: 'Outlook_AutoForward_Setup', title: 'Outlook自動転送設定' },
]

/** 印刷したときに読める体裁。日本語フォントは OS 標準を順に当てる */
const CSS = `
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", system-ui, sans-serif;
         font-size: 10.5pt; line-height: 1.75; color: #1f2937; max-width: 900px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20pt; border-bottom: 3px solid #2563eb; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 15pt; border-bottom: 1px solid #d1d5db; padding-bottom: 5px; margin-top: 28px;
       page-break-after: avoid; }
  h3 { font-size: 12.5pt; color: #1d4ed8; margin-top: 20px; page-break-after: avoid; }
  code { font-family: "SF Mono", Consolas, monospace; font-size: 9.5pt;
         background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 3px solid #2563eb;
        padding: 10px 12px; border-radius: 4px; overflow-x: auto; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; page-break-inside: avoid; }
  th, td { border: 1px solid #d1d5db; padding: 5px 9px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-weight: 600; }
  blockquote { border-left: 3px solid #fbbf24; background: #fffbeb; margin: 12px 0;
               padding: 8px 14px; color: #78350f; }
  blockquote p { margin: 4px 0; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  li { margin: 3px 0; }
  a { color: #2563eb; }
  .built { color: #9ca3af; font-size: 9pt; margin-bottom: 20px; }
`

const htmlOnly = process.argv.includes('--html')
// 生成日は引数で渡せる（渡さなければ実行日）
const stamp = new Date().toISOString().slice(0, 10)

let pdfOk = 0
let pdfSkipped = 0
const hasCupsfilter = (() => {
  try { execFileSync('which', ['cupsfilter'], { stdio: 'pipe' }); return true } catch { return false }
})()

for (const { md, out, title } of DOCS) {
  const src = resolve(ROOT, md)
  if (!existsSync(src)) { console.log(`⚠ 見つからない: ${md}`); continue }

  const body = marked.parse(readFileSync(src, 'utf8'))
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — AkiNavi HR-AI</title>
<style>${CSS}</style></head>
<body><p class="built">AkiNavi HR-AI ／ ${title} ／ ${stamp} 時点（${md} から自動生成）</p>
${body}</body></html>`

  const htmlPath = resolve(ROOT, 'public/docs', `${out}.html`)
  writeFileSync(htmlPath, html, 'utf8')
  console.log(`✅ ${out}.html`)

  if (htmlOnly || !hasCupsfilter) { pdfSkipped++; continue }
  try {
    const pdf = execFileSync('cupsfilter', ['-t', title, htmlPath], {
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    writeFileSync(resolve(ROOT, 'public/docs', `${out}.pdf`), pdf)
    console.log(`✅ ${out}.pdf (${Math.round(pdf.length / 1024)}KB)`)
    pdfOk++
  } catch {
    console.log(`⚠ ${out}.pdf の生成に失敗（HTML は作成済み）`)
    pdfSkipped++
  }
}

console.log(`\nHTML: ${DOCS.length}件 / PDF: ${pdfOk}件生成・${pdfSkipped}件スキップ`)
if (!hasCupsfilter) {
  console.log('cupsfilter が無いため PDF は作れません（macOS 以外）。')
  console.log('public/docs/*.html をブラウザで開き、Ctrl+P →「PDFとして保存」で作成してください。')
}
