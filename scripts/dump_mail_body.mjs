#!/usr/bin/env node
// ローカル控え（D:\akinavi-archive\mail\<日付>\<messageId>\message.json）から
// 本文・件名・添付一覧を取り出して表示する。本番は引かない（egress ゼロ）。
//
//   node scripts/dump_mail_body.mjs <message.json のパス> [--head N] [--raw]
import fs from 'node:fs'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
if (!file) { console.error('使い方: node scripts/dump_mail_body.mjs <message.json> [--head N] [--raw]'); process.exit(1) }
const headArg = args.indexOf('--head')
const head = headArg >= 0 ? Number(args[headArg + 1]) : 0
const raw = args.includes('--raw')

// outlook_export.ps1 が BOM 付きで書くので剥がしてから読む
const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
// 控えは2形: outlook_export.ps1 は body を素の文字列、Graph は {contentType, content}
const body = typeof m.body === 'string' ? m.body : (m.body?.content ?? m.bodyPreview ?? '')
const isHtml = typeof m.body === 'string'
  ? /<(?:html|body|div|br|p)\b/i.test(body)
  : (m.body?.contentType ?? '').toLowerCase() === 'html'

function htmlToText(h) {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
}

console.log('件名:', m.subject ?? '')
console.log('From:', typeof m.from === 'string' ? m.from : (m.from?.emailAddress?.address ?? ''))
console.log('受信:', m.receivedTime ?? m.receivedDateTime ?? '')
console.log('添付:', (m.attachments ?? []).length, '件',
  (m.attachments ?? []).map(a => a.name ?? a.fileName ?? a).join(' / '))
console.log('本文形式:', isHtml ? 'html' : 'text')
console.log('='.repeat(70))
const text = raw ? body : (isHtml ? htmlToText(body) : body)
const lines = text.split(/\r?\n/)
console.log(head > 0 ? lines.slice(0, head).join('\n') : text)
if (head > 0 && lines.length > head) console.log(`… （残り ${lines.length - head} 行）`)
