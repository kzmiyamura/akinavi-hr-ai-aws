#!/usr/bin/env node
// bulk_replay_missing_skillyears.mjs — 経歴書があるのに skillYears が空の人材を一括再解析する
//
// 背景（2026-08-12）: PDFの行復元・縦積みヘッダー9Pass・添付割当の管理番号マッチ等、
// 抽出器は直近で大きく改善されたが、過去に取り込んだ人材は旧抽出器の結果のまま。
// アプリの「再解析」ボタンと同じ経路（inbound-email force + target_candidate_id）で
// 現行の抽出器を過去分に適用し直す。AI は使わない（inbound-email はルールベース）。
//
// 使い方:
//   node scripts/bulk_replay_missing_skillyears.mjs            # ドライラン（対象一覧のみ）
//   node scripts/bulk_replay_missing_skillyears.mjs --run      # 実行
//   node scripts/bulk_replay_missing_skillyears.mjs --run --limit 20
//   node scripts/bulk_replay_missing_skillyears.mjs 3 --run    # 対象期間を3日に
//   node scripts/bulk_replay_missing_skillyears.mjs 365 --run --excel   # Excel経歴書だけ
//
// 先に node scripts/audit_replay_experience_impact.mjs で経験年数がどう動くか測れる（DB変更なし）
//
// 対象: prod・merged なし・resume_url が自前 Storage・skillYears 空（_キー除く）
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }

const args = process.argv.slice(2)
const RUN = args.includes('--run')
const limitAt = args.indexOf('--limit')
const LIMIT = Number(limitAt >= 0 ? args[limitAt + 1] : 0) || Infinity
// 日数は素の数値引数。--limit の値を日数と誤認しないよう除外する
const DAYS = Number(args.find((a, i) => /^\d+$/.test(a) && i !== limitAt + 1) ?? 7)
const idAt = args.indexOf('--id')
const ONLY_ID = idAt >= 0 ? args[idAt + 1] : null
// skillYears が取れるのは実質 Excel だけ。PDF/Word を混ぜると無駄打ちになる
// （2026-08-12 実測: 対象241件のうち152件がPDFで、再解析しても空のまま）
const EXCEL_ONLY = args.includes('--excel')
const since = new Date(Date.now() - DAYS * 86400000).toISOString()

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`, { headers })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const hasSy = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length > 0

// 一覧は軽い項目のみ（本文 text は再解析する1件ごとに個別取得して egress を抑える）
const rows = await fetchAll(
  'candidates?select=id,name,resume_url,experience_years,sy:raw_profile->skillYears,' +
  'subject:raw_profile->>subject,mailfrom:raw_profile->>from' +
  `&data_env=eq.prod&merged_into=is.null&created_at=gte.${since}&resume_url=not.is.null`)

const targets = ONLY_ID
  // --id 指定時は skillYears 空の条件を外す（抽出器の修正を1人で検証し直す用途）
  ? rows.filter((c) => c.id === ONLY_ID)
  : rows.filter((c) => !hasSy(c.sy) && String(c.resume_url).includes('supabase.co/storage')
      && (!EXCEL_ONLY || /\.(xlsx?|xlsm)($|\?)/i.test(String(c.resume_url))))
console.log(ONLY_ID
  ? `対象: ${targets.length}件（--id 指定）`
  : `対象: ${targets.length}件（直近${DAYS}日・resume_url=Storage・skillYears空` +
    `${EXCEL_ONLY ? '・Excelのみ' : ''}）` +
    (Number.isFinite(LIMIT) ? ` → 先頭${LIMIT}件のみ実行` : ''))

if (!RUN) {
  for (const c of targets.slice(0, 30)) {
    console.log(`  ${String(c.name ?? '').padEnd(12)} exp=${c.experience_years ?? '—'}  ${String(c.resume_url).split('/').pop()?.slice(0, 50)}`)
  }
  if (targets.length > 30) console.log(`  …他${targets.length - 30}件`)
  console.log('\nドライランです。実行するには --run を付けてください')
  process.exit(0)
}

let ok = 0, improved = 0, failed = 0
for (const c of targets.slice(0, LIMIT)) {
  const tag = `${String(c.name ?? '').padEnd(12)} ${c.id.slice(0, 8)}`
  try {
    // 本文テキスト（この1件のみ・JSONパスで text だけ）
    const tRes = await fetch(`${URL}/rest/v1/candidates?id=eq.${c.id}&select=txt:raw_profile->>text`, { headers })
    const txt = (await tRes.json())[0]?.txt ?? ''
    // 経歴書ファイル（自前 Storage・公開URL）
    const fRes = await fetch(c.resume_url)
    if (!fRes.ok) { console.log(`SKIP ${tag} 経歴書取得 ${fRes.status}`); failed++; continue }
    const buf = Buffer.from(await fRes.arrayBuffer())
    if (buf.length === 0 || buf.length > 15 * 1024 * 1024) { console.log(`SKIP ${tag} サイズ異常 ${buf.length}`); failed++; continue }
    const name = decodeURIComponent(String(c.resume_url).split('/').pop() ?? 'resume.bin').split('?')[0]
    const mimeType = fRes.headers.get('content-type') ?? 'application/octet-stream'

    const res = await fetch(`${URL}/functions/v1/inbound-email`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: c.subject ?? `【再解析】${c.name ?? ''}`,
        body: txt,
        from: c.mailfrom ?? `replay+${c.id}@replay.invalid`,
        attachments: [{ data: buf.toString('base64'), mimeType, name }],
        mode: 'prod',
        type: 'candidate',
        force: true,
        target_candidate_id: c.id,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.ok === false) { console.log(`FAIL ${tag} ${res.status} ${JSON.stringify(json).slice(0, 120)}`); failed++; continue }
    ok++
    // 再解析後に skillYears が入ったか確認（この1件のみ）
    const vRes = await fetch(`${URL}/rest/v1/candidates?id=eq.${c.id}&select=sy:raw_profile->skillYears,experience_years`, { headers })
    const v = (await vRes.json())[0]
    const got = hasSy(v?.sy)
    if (got) improved++
    console.log(`${got ? 'OK  ' : 'ok- '} ${tag} skillYears=${got ? Object.keys(v.sy).filter((k) => !k.startsWith('_')).length + '件' : '空のまま'} exp=${v?.experience_years ?? '—'}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${tag} ${String(e).slice(0, 140)}`)
  }
  await new Promise((r) => setTimeout(r, 400))   // Edge Function への負荷を平準化
}
console.log(`\n完了: 実行${ok} / skillYears回復${improved} / 失敗${failed}`)
