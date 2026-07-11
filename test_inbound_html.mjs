#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
/**
 * test_inbound_html.mjs — inbound-email ローカル完全テスト（v2）
 *
 * 前提:
 *   1. ローカル Supabase 起動済み（supabase start）
 *   2. スキーマ・シード適用済み（scripts/local_test_seed.sql ほか）
 *   3. inbound-email がローカル Supabase 向け env で起動済み:
 *        SUPABASE_URL=http://127.0.0.1:54321 \
 *        SUPABASE_SERVICE_ROLE_KEY=<supabase status の service_role key> \
 *        deno run --allow-all supabase/functions/inbound-email/index.ts
 *
 * 実行:
 *   SERVICE_ROLE_KEY=<key> deno run --allow-read --allow-write --allow-net --allow-env test_inbound_html.mjs
 *
 * 検証方式:
 *   POST → レスポンスの candidate id → ローカルDBから raw_profile.pipeline_trace を取得して検証
 *   （レスポンス自体には raw_profile が含まれないため）
 */

import { encode } from "https://deno.land/std@0.208.0/encoding/base64.ts"

const ENDPOINT = Deno.env.get('INBOUND_URL') ?? 'http://localhost:8000'
const LOCAL_API = Deno.env.get('LOCAL_SUPABASE_URL') ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? ''
const TEST_DATA_DIR = 'testData/test_real'
const RUN_ID = Date.now().toString(36) // 実行ごとに件名を変えて dedup 衝突を防ぐ

if (!SERVICE_KEY) {
  console.error('❌ SERVICE_ROLE_KEY 環境変数が未設定です（supabase status で確認）')
  Deno.exit(1)
}

// ============================================================
// ローカルDBヘルパー
// ============================================================

async function dbFetchCandidate(id) {
  const res = await fetch(
    `${LOCAL_API}/rest/v1/candidates?id=eq.${encodeURIComponent(id)}&select=id,name,resume_url,skills,raw_profile`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  if (!res.ok) throw new Error(`DB fetch ${res.status}: ${await res.text()}`)
  const rows = await res.json()
  return rows[0] ?? null
}

// ============================================================
// ファイル読み込み
// ============================================================

const testFiles = {}
const xlsxFiles = []
const docxFiles = []

console.log(`\n📁 Loading test files from ${TEST_DATA_DIR}...`)

for await (const file of Deno.readDir(TEST_DATA_DIR)) {
  if (!file.isFile) continue
  try {
    const binary = Deno.readFileSync(`${TEST_DATA_DIR}/${file.name}`)
    const mimeType = file.name.endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : file.name.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/octet-stream'
    testFiles[file.name] = { data: encode(binary), mimeType, size: binary.length }
    if (file.name.endsWith('.xlsx')) xlsxFiles.push(file.name)
    if (file.name.endsWith('.docx')) docxFiles.push(file.name)
    console.log(`  ✅ ${file.name} (${Math.round(binary.length / 1024)}KB)`)
  } catch (e) {
    console.error(`  ❌ ${file.name}: ${e.message}`)
  }
}
xlsxFiles.sort()
docxFiles.sort()

console.log(`\n📊 ${xlsxFiles.length} Excel / ${docxFiles.length} Word files\n`)

// ============================================================
// テストケース生成
// ============================================================

/** ファイル名からイニシャル部分を推定（例: 2026-05-19-09-50-08_A.M_.xlsx → A.M） */
function initialsFromFilename(name) {
  const m = name.match(/_([A-Z]\.?[A-Z])_?[^_]*\.(xlsx|docx)$/i)
  return m ? m[1] : null
}

const att = (name) => ({ name, mimeType: testFiles[name].mimeType, data: testFiles[name].data })

const testCases = []

// ① 各ファイル個別（ブラックボックス: 単一人材・添付1件）
for (const filename of [...xlsxFiles, ...docxFiles]) {
  const initials = initialsFromFilename(filename)
  testCases.push({
    category: filename.endsWith('.xlsx')
      ? 'BB-1: Excel単体（単一人材・添付1件）'
      : 'BB-2: Word単体（単一人材・添付1件）',
    name: filename,
    payload: {
      type: 'candidate', mode: 'demo', force: 'true',
      from: 'agent@example-test.co.jp',
      subject: `【テスト${RUN_ID}】${initials ?? 'テスト太郎'}さんのご紹介`,
      body: `お世話になっております。\n下記の人材をご紹介いたします。\n【氏名】${initials ?? 'テスト太郎'}\n【最寄駅】渋谷駅\nよろしくお願いいたします。`,
      attachments: [att(filename)],
    },
    expect: {
      registered: true,
      noInvariantViolations: true,
      traceHasAny: ['B-EXTRACT-OK', 'B-EXTRACT-EMPTY', 'C-ROSTER'],
    },
  })
}

// ② 単一人材・本人名一致ゲート（D-GATE-OK）: イニシャルがファイル名にあるものを利用
const gateFile = xlsxFiles.find(f => initialsFromFilename(f))
if (gateFile) {
  const ini = initialsFromFilename(gateFile)
  testCases.push({
    category: 'WB-D: 氏名照合ゲート',
    name: `D-GATE-OK: 本文の氏名(${ini})とファイル名が一致`,
    payload: {
      type: 'candidate', mode: 'demo', force: 'true',
      from: 'agent@example-test.co.jp',
      subject: `【テスト${RUN_ID}】${ini}さん スキルシート添付`,
      body: `お世話になっております。\n【氏名】${ini}\n【最寄駅】新宿駅\n経歴書を添付いたします。`,
      attachments: [att(gateFile)],
    },
    expect: {
      registered: true,
      noInvariantViolations: true,
      traceHasAny: ['D-GATE-OK', 'D-GATE-ALL'],
    },
  })
}

// ③ 単一人材・添付なし（ゲートは何もしない・登録のみ）
testCases.push({
  category: 'WB-D: 氏名照合ゲート',
  name: '添付なし単一人材（ベースライン）',
  payload: {
    type: 'candidate', mode: 'demo', force: 'true',
    from: 'agent@example-test.co.jp',
    subject: `【テスト${RUN_ID}】添付なし候補者`,
    body: `お世話になっております。\n【氏名】K.T\n【最寄駅】品川駅\n【経験年数】8年\n【スキル】Java, Spring Boot, AWS\nよろしくお願いいたします。`,
    attachments: [],
  },
  expect: { registered: true, noInvariantViolations: true },
})

// ④ 複数人材・区切り線ブロック + 添付2件（ファイル名で振り分け）
//    別人のイニシャルを持つ2ファイルを選ぶ（同一人物の重複DLファイルを避ける）。
//    各ブロックは50文字以上にする（splitMultiCandidateBody の最小ブロック長チェック対策）
if (xlsxFiles.length >= 2) {
  const f1 = xlsxFiles.find(f => initialsFromFilename(f)) ?? xlsxFiles[0]
  const i1raw = initialsFromFilename(f1)
  const f2 = xlsxFiles.find(f => f !== f1 && initialsFromFilename(f) && initialsFromFilename(f) !== i1raw)
    ?? xlsxFiles.find(f => f !== f1)
  const i1 = i1raw ?? 'A.A'
  const i2 = initialsFromFilename(f2) ?? 'B.B'
  testCases.push({
    category: 'BB-3: 複数人材（ブロック+添付2件）',
    name: `${i1} + ${i2} / ${f1} + ${f2}`,
    payload: {
      type: 'candidate', mode: 'demo', force: 'true',
      from: 'agent@example-test.co.jp',
      subject: `【テスト${RUN_ID}】2名のご紹介`,
      body: `お世話になっております。2名ご紹介いたします。ご検討のほどよろしくお願いいたします。\n【氏名】${i1}\n【最寄駅】渋谷駅\n【経験年数】5年\n【スキル】Java, Spring Boot, AWS, Docker\n【稼働開始】即日可能です\n************\n【氏名】${i2}\n【最寄駅】横浜駅\n【経験年数】3年\n【スキル】PHP, Laravel, MySQL, Linux\n【稼働開始】来月から可能です\n************\n以上です。よろしくお願いいたします。`,
      attachments: [att(f1), att(f2)],
    },
    expect: {
      multi: true,
      minCount: 2,
      noInvariantViolations: true,
    },
  })
}

// ⑤ Excel + Word 混合（単一人材）
if (xlsxFiles.length > 0 && docxFiles.length > 0) {
  testCases.push({
    category: 'BB-4: 混合形式（Excel+Word）',
    name: `${xlsxFiles[0]} + ${docxFiles[0]}`,
    payload: {
      type: 'candidate', mode: 'demo', force: 'true',
      from: 'agent@example-test.co.jp',
      subject: `【テスト${RUN_ID}】複合形式の候補者`,
      body: `お世話になっております。\n【氏名】M.E\n【最寄駅】池袋駅\nスキルシートと職務経歴書を添付します。`,
      attachments: [att(xlsxFiles[0]), att(docxFiles[0])],
    },
    expect: { registered: true, noInvariantViolations: true },
  })
}

// ⑥ 本物の名簿ファイル（アイスタンダード注力フリーランス一覧・117人規模）
//    「氏名」ヘッダ列なし・サマリー列に【氏名】：I.S 形式 → テキスト型名簿検出の検証
try {
  const rosterBin = Deno.readFileSync('testData/test_roster/roster_istandard.xlsx')
  testCases.push({
    category: 'BB-5: 本物の名簿（複数人材一覧Excel）',
    name: 'roster_istandard.xlsx（117人規模・リンク型名簿）',
    payload: {
      type: 'candidate', mode: 'demo', force: 'true',
      from: 'sales@i-standard-test.co.jp',
      subject: `【テスト${RUN_ID}】注力フリーランス一覧のご送付`,
      body: `お世話になっております。\n今月の弊社注力フリーランス一覧をお送りいたします。\nご検討のほどよろしくお願いいたします。\n（一覧はExcelファイルをご参照ください）`,
      attachments: [
        { name: '注力フリーランス一覧.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: encode(rosterBin) }
      ],
    },
    expect: {
      multi: true,
      minCount: 2,
      noInvariantViolations: true,
      traceHasAny: ['C-ROSTER'],
    },
  })
  console.log('  ✅ roster_istandard.xlsx を BB-5 として追加')
} catch { console.log('  （名簿ファイルなし: BB-5スキップ）') }

console.log(`✅ ${testCases.length} test cases generated\n`)
console.log(`🚀 Running against ${ENDPOINT} (verify via ${LOCAL_API})...\n`)

// ============================================================
// テスト実行
// ============================================================

const results = []
let passed = 0
let failed = 0

for (const tc of testCases) {
  const r = {
    category: tc.category, name: tc.name,
    passed: false, issues: [], trace: null, dbRecord: null, response: null, duration: 0,
  }

  try {
    const t0 = Date.now()
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tc.payload),
    })
    r.duration = Date.now() - t0
    const data = await res.json().catch(() => ({}))
    r.response = data

    if (!res.ok) {
      r.issues.push(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
    } else if (data.skipped) {
      r.issues.push(`スキップされた: reason=${data.reason}`)
    } else {
      // 登録された candidate id を取得（単一 or 複数）
      const ids = data.type === 'multi-candidate'
        ? (data.results ?? []).map(x => x.id ?? x.candidateId ?? x.candidate_id).filter(Boolean)
        : [data.id].filter(Boolean)

      if (tc.expect.registered && ids.length === 0) {
        r.issues.push(`候補者IDがレスポンスに無い: ${JSON.stringify(data).slice(0, 300)}`)
      }
      if (tc.expect.multi) {
        if (data.type !== 'multi-candidate') r.issues.push(`multi-candidate ではない: type=${data.type}`)
        else if ((data.count ?? 0) < (tc.expect.minCount ?? 2)) r.issues.push(`count=${data.count} < ${tc.expect.minCount}`)
      }

      // DBから pipeline_trace を取得して検証（先頭の候補者）
      if (ids.length > 0) {
        const cand = await dbFetchCandidate(ids[0])
        r.dbRecord = cand ? { id: cand.id, name: cand.name, resume_url: cand.resume_url, skills: (cand.skills ?? []).slice(0, 8) } : null
        r.trace = cand?.raw_profile?.pipeline_trace ?? null

        if (!cand) {
          r.issues.push(`DBに候補者が見つからない: id=${ids[0]}`)
        } else {
          if (!r.trace) {
            r.issues.push('pipeline_trace が raw_profile に無い（ゾーンT未通過）')
          } else {
            const violations = r.trace.invariantViolations ?? []
            if (tc.expect.noInvariantViolations && violations.length > 0) {
              r.issues.push(`不変条件違反: ${violations.join(', ')}`)
            }
            if (tc.expect.traceHasAny) {
              const s = JSON.stringify(r.trace)
              if (!tc.expect.traceHasAny.some(c => s.includes(c))) {
                r.issues.push(`期待コードなし: ${tc.expect.traceHasAny.join(' | ')}`)
              }
            }
          }
        }
      }
    }
  } catch (e) {
    r.issues.push(`Exception: ${e.message}`)
  }

  r.passed = r.issues.length === 0
  if (r.passed) passed++
  else failed++
  results.push(r)

  console.log(`${r.passed ? '✅' : '❌'} [${tc.category}] ${r.name} (${r.duration}ms)`)
  for (const i of r.issues) console.log(`     ${i}`)
}

// ============================================================
// HTML レポート生成
// ============================================================

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const suiteMap = new Map()
for (const r of results) {
  if (!suiteMap.has(r.category)) suiteMap.set(r.category, [])
  suiteMap.get(r.category).push(r)
}
const rate = passed + failed > 0 ? Math.round(passed / (passed + failed) * 100) : 0

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>inbound-email テスト結果 ${new Date().toLocaleDateString('ja-JP')}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Segoe UI",sans-serif; background:#f3f4f6; padding:2rem; color:#1f2937; }
.container { max-width:1100px; margin:0 auto; }
header { background:white; padding:1.5rem 2rem; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,.08); margin-bottom:1.5rem; }
h1 { font-size:1.4rem; margin-bottom:.25rem; }
.sub { color:#6b7280; font-size:.85rem; }
.summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:1rem; margin-bottom:1.5rem; }
.card { background:white; padding:1.25rem; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,.06); border-left:4px solid #6366f1; }
.card.ok { border-left-color:#10b981; } .card.ng { border-left-color:#ef4444; }
.card h3 { font-size:.75rem; color:#6b7280; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.4rem; }
.card .v { font-size:2rem; font-weight:700; }
.card.ok .v { color:#10b981; } .card.ng .v { color:#ef4444; }
.suite { background:white; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,.06); margin-bottom:1.25rem; overflow:hidden; }
.suite-h { background:#111827; color:white; padding:.9rem 1.5rem; display:flex; justify-content:space-between; align-items:center; }
.suite-h h2 { font-size:.9rem; font-weight:600; }
.suite-h .st { font-size:.8rem; opacity:.9; }
.t { padding:1rem 1.5rem; border-bottom:1px solid #f3f4f6; }
.t:last-child { border-bottom:none; }
.t-h { display:flex; gap:.6rem; align-items:center; }
.t-name { font-family:ui-monospace,Menlo,monospace; font-size:.82rem; word-break:break-all; flex:1; }
.badge { padding:.15rem .6rem; border-radius:10px; font-size:.7rem; font-weight:700; }
.badge.p { background:#d1fae5; color:#065f46; } .badge.f { background:#fee2e2; color:#991b1b; }
.meta { font-size:.72rem; color:#9ca3af; margin-top:.3rem; }
.iss { background:#fef2f2; border-left:3px solid #ef4444; padding:.6rem .9rem; border-radius:4px; font-size:.8rem; color:#7f1d1d; margin-top:.5rem; list-style:none; }
.iss li { margin:.15rem 0; }
.db { background:#eff6ff; border-left:3px solid #3b82f6; padding:.6rem .9rem; border-radius:4px; font-size:.75rem; margin-top:.5rem; font-family:ui-monospace,Menlo,monospace; word-break:break-all; }
details { margin-top:.5rem; } summary { cursor:pointer; color:#6366f1; font-size:.8rem; }
pre { background:#f9fafb; border:1px solid #e5e7eb; border-radius:4px; padding:.75rem; font-size:.7rem; max-height:280px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin-top:.4rem; }
footer { text-align:center; color:#9ca3af; font-size:.78rem; margin-top:2rem; }
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🧪 inbound-email 統一入力パイプライン テスト結果</h1>
  <p class="sub">実行: ${new Date().toLocaleString('ja-JP')} ｜ RUN_ID: ${RUN_ID} ｜ 環境: ローカルSupabase（本番egress消費ゼロ）</p>
</header>
<div class="summary">
  <div class="card ok"><h3>パス</h3><div class="v">${passed}</div></div>
  <div class="card ng"><h3>失敗</h3><div class="v">${failed}</div></div>
  <div class="card"><h3>成功率</h3><div class="v">${rate}%</div></div>
  <div class="card"><h3>テスト数</h3><div class="v">${results.length}</div></div>
</div>
${[...suiteMap.entries()].map(([cat, items]) => `
<div class="suite">
  <div class="suite-h"><h2>${esc(cat)}</h2><span class="st">✅ ${items.filter(i=>i.passed).length} / ❌ ${items.filter(i=>!i.passed).length}</span></div>
  ${items.map(it => `
  <div class="t">
    <div class="t-h">
      <span>${it.passed ? '✅' : '❌'}</span>
      <span class="t-name">${esc(it.name)}</span>
      <span class="badge ${it.passed ? 'p' : 'f'}">${it.passed ? 'PASS' : 'FAIL'}</span>
    </div>
    <div class="meta">⏱ ${it.duration}ms</div>
    ${it.issues.length ? `<ul class="iss">${it.issues.map(i => `<li>❌ ${esc(i)}</li>`).join('')}</ul>` : ''}
    ${it.dbRecord ? `<div class="db">DB: name=${esc(it.dbRecord.name)} ｜ resume_url=${esc(it.dbRecord.resume_url ?? 'null')} ｜ skills=[${esc((it.dbRecord.skills ?? []).join(', '))}]</div>` : ''}
    ${it.trace ? `<details><summary>📋 pipeline_trace</summary><pre>${esc(JSON.stringify(it.trace, null, 2))}</pre></details>` : ''}
    ${!it.passed && it.response ? `<details><summary>📨 レスポンス</summary><pre>${esc(JSON.stringify(it.response, null, 2).slice(0, 3000))}</pre></details>` : ''}
  </div>`).join('')}
</div>`).join('')}
<footer>inbound-email 設計書v4（ゾーンA〜E・T）検証 ｜ テストファイル: Excel ${xlsxFiles.length}件 + Word ${docxFiles.length}件</footer>
</div>
</body>
</html>`

Deno.writeTextFileSync('test_results.html', html)
console.log(`\n✅ test_results.html を生成しました`)
console.log(`📊 ${passed} passed / ${failed} failed (${rate}%)`)
