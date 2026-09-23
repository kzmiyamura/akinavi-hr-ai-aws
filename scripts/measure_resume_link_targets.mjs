#!/usr/bin/env node
/**
 * 未対応の経歴書リンクを実際に辿って、「何が置いてあるか／落とせるか／容量は」を測る（2026-09-23）。
 *
 * 前段（measure_resume_link_domains.mjs）で分かったこと:
 *   直近7日の「経歴書の文脈」のURL 2,920件のうち、**1,079件(37%) が未対応**。
 *   最大は bit.ly 365件。次いで配信サービスのクリック追跡ドメイン、Box、SharePoint。
 *
 * ここで測るのは3つ:
 *   ① リダイレクトを追うと最終的にどこへ着くか（Google Drive なら既存の経路に乗る）
 *   ② 認証なしで実体が取れるか（取れないなら落とせない）
 *   ③ 取れるなら1件あたりの容量（ローカル控えの見積もりに要る）
 *
 * **本番は引かない。** 控えの message.json からURLを集め、外部サイトにだけ当たる。
 * 実体は受け取らず Range: bytes=0-0 で容量だけ見る。
 *
 * 実行:
 *   node scripts/measure_resume_link_targets.mjs [--days 7] [--sample 40]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/akinavi-archive/mail'
const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const DAYS = argOf('days', 7)
const SAMPLE = argOf('sample', 40)

const RESUME_HINT = /スキルシート|経歴書|技術経歴|職務経歴|レジュメ|skill\s*sheet|プロフィールシート/i
const URL_RE = /https?:\/\/[^\s"'<>）」】、,]+/g
const SUPPORTED = /^(docs|drive)\.google\.com$/

const dayDirs = fs.readdirSync(ROOT)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-DAYS)

/** 未対応ドメインの「経歴書の文脈」URLを集める（重複除く） */
const urls = new Set()
for (const day of dayDirs) {
  const dayPath = path.join(ROOT, day)
  let entries
  try { entries = fs.readdirSync(dayPath) } catch { continue }
  for (const e of entries) {
    const mj = path.join(dayPath, e, 'message.json')
    if (!fs.existsSync(mj)) continue
    let msg
    // message.json は BOM 付き。剥がさないと全件パース失敗する
    try { msg = JSON.parse(fs.readFileSync(mj, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const body = String(msg.body ?? '')
    for (const m of body.matchAll(URL_RE)) {
      let host
      try { host = new URL(m[0]).hostname.replace(/^www\./, '') } catch { continue }
      if (SUPPORTED.test(host)) continue
      const around = body.slice(Math.max(0, m.index - 120), m.index + 120)
      if (RESUME_HINT.test(around)) urls.add(m[0])
    }
  }
}

const all = [...urls]
// 先頭に偏らないよう等間隔で抜く
const picked = all.length > SAMPLE
  ? all.filter((_, i) => i % Math.ceil(all.length / SAMPLE) === 0).slice(0, SAMPLE)
  : all

/** リダイレクトを手で追う（最終URL・ステータス・種別・容量を返す） */
async function trace(url) {
  let cur = url
  for (let hop = 0; hop < 6; hop++) {
    let res
    try {
      res = await fetch(cur, {
        method: 'GET',
        redirect: 'manual',
        headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0' },
      })
    } catch (e) { return { final: cur, status: 'ERR', note: String(e).slice(0, 40) } }
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      try { cur = new URL(loc, cur).toString() } catch { return { final: cur, status: res.status } }
      continue
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]
    const cr = res.headers.get('content-range')
    const size = cr ? Number(cr.split('/')[1]) : Number(res.headers.get('content-length') ?? 0)
    return { final: cur, status: res.status, type, size: Number.isFinite(size) ? size : 0 }
  }
  return { final: cur, status: 'LOOP' }
}

console.log(`未対応の経歴書URL（直近${dayDirs.length}日・重複除く）: ${all.length}件`)
console.log(`うち ${picked.length}件 を実際に辿ります（実体は受け取らない）\n`)

const byFinalHost = new Map()
const results = []
for (let i = 0; i < picked.length; i += 5) {
  const got = await Promise.all(picked.slice(i, i + 5).map(trace))
  for (let j = 0; j < got.length; j++) {
    const r = got[j]
    results.push({ src: picked[i + j], ...r })
    let h = '(不明)'
    try { h = new URL(r.final).hostname.replace(/^www\./, '') } catch { /* noop */ }
    const cur = byFinalHost.get(h) ?? { n: 0, ok: 0, bytes: 0, types: new Set() }
    cur.n++
    if (r.status === 200 || r.status === 206) { cur.ok++; cur.bytes += r.size ?? 0 }
    if (r.type) cur.types.add(r.type)
    byFinalHost.set(h, cur)
  }
}

console.log('■ リダイレクトを追った先')
console.log(`${'最終ドメイン'.padEnd(32)} 件数  取得可  平均容量  種別`)
console.log('-'.repeat(84))
const rows = [...byFinalHost.entries()].sort((a, b) => b[1].n - a[1].n)
for (const [host, v] of rows) {
  const avg = v.ok ? `${Math.round(v.bytes / v.ok / 1024)}KB` : '—'
  const t = [...v.types].map((x) => x.replace('application/', '').slice(0, 24)).join(',').slice(0, 30)
  console.log(`${host.padEnd(32)} ${String(v.n).padStart(4)}  ${String(v.ok).padStart(5)}  ${avg.padStart(8)}  ${t}`)
}

const okAll = results.filter((r) => r.status === 200 || r.status === 206)
const googleAfter = results.filter((r) => /(?:docs|drive)\.google\.com/.test(r.final))
console.log('-'.repeat(84))
console.log(`辿った ${results.length}件 のうち`)
console.log(`  200/206 で中身に届いた        : ${okAll.length}件`)
console.log(`  追った先が Google Drive/Docs  : ${googleAfter.length}件 ← 既存の取得経路にそのまま乗る`)
console.log('\n■ 例（先頭8件）')
for (const r of results.slice(0, 8)) {
  console.log(`  ${String(r.status).padStart(3)} ${(r.type ?? '').padEnd(26)} ${r.src.slice(0, 36)}`)
  console.log(`      → ${String(r.final).slice(0, 96)}`)
}
