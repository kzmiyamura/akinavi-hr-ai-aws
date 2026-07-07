#!/usr/bin/env node
// =============================================================================
// 1メール複数人材（multi-candidate）添付ファイル割当 ホワイトボックステスト
// =============================================================================
// 目的: labelToAttachment ラベル衝突バグ・ケースB複数人共有バグ・年齢抽出バグの
//       再発を検知する回帰テスト。実際にデプロイ済みの inbound-email 関数を
//       demo環境で叩き、DBに正しく反映されるかを確認する。
//
// 使い方:
//   node scripts/verify_multi_candidate.mjs               # 全10シナリオ実行
//   node scripts/verify_multi_candidate.mjs --scenario 3   # 特定シナリオのみ
//   node scripts/verify_multi_candidate.mjs --keep         # demoデータを削除しない（手動確認用）
//
// 前提: SUPABASE_URL / SUPABASE_ANON_KEY 環境変数、または下記デフォルト値を使用。
//       Supabase MCP等で直接 candidates テーブルを SELECT/DELETE できる権限が別途必要
//       （このスクリプト自体はDB直接アクセスせず、関数呼び出し結果のIDのみ出力する）。
// =============================================================================

import XLSX from 'xlsx'
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://argizomylbolpqxgmvim.supabase.co'
const ANON_KEY = process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyZ2l6b215bGJvbHBxeGdtdmltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MDIwNTYsImV4cCI6MjA5MzA3ODA1Nn0.ilicFkGA6rO2cbVklC5IulPvCW0twk072_FBM3fXh1s'

// ── 5人材テンプレート（実データ「株式会社ai・more」の形式に準拠。年齢表記を意図的に散らす） ──
function baseCandidates(tag) {
  return [
    { initial: `${tag}A`, age: 37, ageFmt: '（37）', gender: '男性', station: '小岩駅', line: '中央総武線', rate: '88万～', skill: 'C#.NET、VB.NET、ASP.NET' },
    { initial: `${tag}B`, age: 31, ageFmt: '（31）', gender: '男性', station: '浦安駅', line: '東西線', rate: '83万～', skill: 'PHP,SQL,HTML/CSS' },
    { initial: `${tag}C`, age: 42, ageFmt: '（42）', gender: '男性', station: '茅ヶ崎駅', line: '東海道線', rate: '133万～', skill: 'C言語,C++,Java' },
    { initial: `${tag}D`, age: 35, ageFmt: '（35歳）', gender: '男性', station: '中野駅', line: '', rate: '58万～', skill: 'C言語、C#、C++' },
    { initial: `${tag}E`, age: 25, ageFmt: '（25）', gender: '男性', station: '蓮根駅', line: '都営三田線', rate: '43万～', skill: 'Java、OutSystems' },
  ]
}

function buildBody(cands) {
  const header = `株式会社検証テスト\nご担当者様\n\nいつもお世話になっております。\n下記要員に見合います案件がございましたら宜しくお願い致します。\n\n`
  const blocks = cands.map(c => (
`*****************************************\n` +
`名前　　　：${c.initial}${c.ageFmt}${c.gender}\n` +
`最寄り駅　：${c.line}　${c.station}\n` +
`稼動可能日：即日\n` +
`希望単価　：${c.rate}\n` +
`スキル　　：${c.skill}\n` +
`*****************************************\n`
  )).join('')
  const footer = `\n以上になります。\nよろしくお願いいたします。\n\n株式会社ベリファイテスト(旧社名からの変更ではありません)\n検証担当　090-0000-0000\n〒000-0000 検証県検証市1-1-1\n`
  return header + blocks + footer
}

function makeXlsxBase64(marker, extraRows = []) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['識別マーカー', marker],
    ['スキル', 'サンプル 3年'],
    ...extraRows,
  ])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return buf.toString('base64')
}

// ── 各シナリオの添付ファイル戦略を定義 ──
// attachmentsFor(cands, tag) -> { attachments: [{data,mimeType,name}], expected: Map<initial, 'own'|'null'|'anyOf:<markers>'> }
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const scenarios = [
  {
    id: 1,
    name: 'ファイル名に候補者名を含む（パス1: 名前マッチ）',
    build: (cands, tag) => {
      const attachments = cands.map(c => ({
        data: makeXlsxBase64(`MARK_${c.initial}`),
        mimeType: XLSX_MIME,
        name: `${c.initial}_経歴書.xlsx`,
      }))
      const expected = new Map(cands.map(c => [c.initial, `MARK_${c.initial}`]))
      return { attachments, expected }
    },
  },
  {
    id: 2,
    name: 'ファイル名に最寄駅のみを含む（パス2: 駅名マッチ）',
    build: (cands) => {
      const attachments = cands.map(c => ({
        data: makeXlsxBase64(`MARK_${c.initial}`),
        mimeType: XLSX_MIME,
        name: `${c.station}.xlsx`,
      }))
      const expected = new Map(cands.map(c => [c.initial, `MARK_${c.initial}`]))
      return { attachments, expected }
    },
  },
  {
    id: 3,
    name: '全員が同一の汎用ファイル名（labelToAttachmentラベル衝突ストレステスト）',
    build: (cands) => {
      const attachments = cands.map(c => ({
        data: makeXlsxBase64(`MARK_${c.initial}`, [['氏名', c.initial]]),
        mimeType: XLSX_MIME,
        name: `スキルシート.xlsx`,
      }))
      // ファイル名は全部同じだが、内容にイニシャルが埋め込まれているのでパス2.5で個別マッチできるはず
      const expected = new Map(cands.map(c => [c.initial, `MARK_${c.initial}`]))
      return { attachments, expected }
    },
  },
  {
    id: 4,
    name: '3人は名前一致ファイル・2人は同名汎用ファイル（混在）',
    build: (cands) => {
      const attachments = cands.map((c, i) => ({
        data: makeXlsxBase64(`MARK_${c.initial}`, i >= 3 ? [['氏名', c.initial]] : []),
        mimeType: XLSX_MIME,
        name: i < 3 ? `${c.initial}_経歴書.xlsx` : `職務経歴書.xlsx`,
      }))
      const expected = new Map(cands.map(c => [c.initial, `MARK_${c.initial}`]))
      return { attachments, expected }
    },
  },
  {
    id: 5,
    name: '5人中3人分の添付のみ（2人未確定・共有禁止の確認）',
    build: (cands) => {
      const withAttach = cands.slice(0, 3)
      const attachments = withAttach.map(c => ({
        data: makeXlsxBase64(`MARK_${c.initial}`),
        mimeType: XLSX_MIME,
        name: `${c.initial}_経歴書.xlsx`,
      }))
      const expected = new Map(cands.map(c => [
        c.initial,
        withAttach.includes(c) ? `MARK_${c.initial}` : 'null',
      ]))
      return { attachments, expected }
    },
  },
  {
    id: 6,
    name: '5人中4人分の添付のみ（1人だけ未確定・1:1残余マッチングの確認）',
    build: (cands) => {
      const withAttach = cands.slice(0, 4)
      const attachments = withAttach.map(c => ({
        data: makeXlsxBase64(`MARK_${c.initial}`),
        mimeType: XLSX_MIME,
        name: `${c.initial}_経歴書.xlsx`,
      }))
      // 4人はファイル名マッチ、残り1人は「唯一の未割当添付」が存在しない（全部割当済み）ので
      // このシナリオでは実は5人目に割り当てる残り添付が無い＝null が正しい。
      // 1:1残余マッチングを狙うには、5人目の添付を「誰にもファイル名マッチしない」形で1件用意する必要がある。
      const extra = { data: makeXlsxBase64('MARK_EXTRA'), mimeType: XLSX_MIME, name: 'ランダムXYZ123.xlsx' }
      attachments.push(extra)
      const missing = cands[4]
      const expected = new Map(cands.map(c => [
        c.initial,
        c === missing ? 'MARK_EXTRA' : `MARK_${c.initial}`,
      ]))
      return { attachments, expected }
    },
  },
  {
    id: 7,
    name: 'ファイル名は無関係な連番・内容のイニシャルのみで判別（パス2.5専用）',
    build: (cands) => {
      const attachments = cands.map((c, i) => ({
        data: makeXlsxBase64(`MARK_${c.initial}`, [['氏名', c.initial]]),
        mimeType: XLSX_MIME,
        name: `IMG_${1000 + i}.xlsx`,
      }))
      const expected = new Map(cands.map(c => [c.initial, `MARK_${c.initial}`]))
      return { attachments, expected }
    },
  },
  {
    id: 8,
    name: '敵対的ファイル名（他人のイニシャルを含む・誤割当されないか確認）',
    build: (cands) => {
      // 各ファイル名にわざと「次の人」のイニシャルも混入させる（曖昧化）
      const attachments = cands.map((c, i) => {
        const other = cands[(i + 1) % cands.length].initial
        return {
          data: makeXlsxBase64(`MARK_${c.initial}`, [['氏名', c.initial]]),
          mimeType: XLSX_MIME,
          name: `${other}案件用_${c.initial}資料.xlsx`,
        }
      })
      const expected = new Map(cands.map(c => [c.initial, `MARK_${c.initial}`]))
      return { attachments, expected }
    },
  },
  {
    id: 9,
    name: '全員同名・同一内容（完全に判別不能な最悪ケース）',
    build: (cands) => {
      const sharedData = makeXlsxBase64('MARK_SHARED_NOBODY')
      const attachments = cands.map(() => ({
        data: sharedData,
        mimeType: XLSX_MIME,
        name: 'スキルシート.xlsx',
      }))
      // 5人全員が同時に曖昧（unmatchedNameBlockCount=5）なので全員 null が正しい
      const expected = new Map(cands.map(c => [c.initial, 'null']))
      return { attachments, expected }
    },
  },
  {
    id: 10,
    name: '実際のバグ再現形（1人だけ名前一致・残り4人は同名汎用ファイルで曖昧）',
    build: (cands) => {
      const attachments = cands.map((c, i) => ({
        data: makeXlsxBase64(`MARK_${c.initial}`, i === 3 ? [] : [['氏名', 'ダミー']]),
        mimeType: XLSX_MIME,
        name: i === 3 ? `${c.initial}_経歴書.xlsx` : `shared_dup.xlsx`,
      }))
      const matched = cands[3]
      const expected = new Map(cands.map(c => [
        c.initial,
        c === matched ? `MARK_${c.initial}` : 'null',
      ]))
      return { attachments, expected }
    },
  },
]

function invoke(payload, retries = 2) {
  const tmpFile = join(tmpdir(), `mc_payload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  writeFileSync(tmpFile, JSON.stringify(payload))
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const out = execFileSync('curl', [
          '-sS', '--http1.1', '--max-time', '60',
          '-X', 'POST', `${SUPABASE_URL}/functions/v1/inbound-email`,
          '-H', `Authorization: Bearer ${ANON_KEY}`,
          '-H', 'Content-Type: application/json',
          '--data-binary', `@${tmpFile}`,
        ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
        let json
        try { json = JSON.parse(out) } catch { json = { raw: out } }
        return { status: 200, json }
      } catch (e) {
        if (attempt === retries) {
          return { status: 0, json: { error: String(e.message ?? e) } }
        }
      }
    }
  } finally {
    try { unlinkSync(tmpFile) } catch { /* noop */ }
  }
}

async function run() {
  const args = process.argv.slice(2)
  const scenarioArg = args.includes('--scenario') ? Number(args[args.indexOf('--scenario') + 1]) : null
  const targets = scenarioArg ? scenarios.filter(s => s.id === scenarioArg) : scenarios

  const manifest = []
  for (const scenario of targets) {
    const tag = `T${scenario.id}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
    const cands = baseCandidates(tag)
    const body = buildBody(cands)
    const { attachments, expected } = scenario.build(cands, tag)

    const payload = {
      subject: `【検証】ホワイトボックステスト シナリオ${scenario.id}`,
      body,
      // 送信者あたり日次上限(SENDER_DAILY_LIMIT)に引っかからないよう毎回ユニークな送信元にする
      from: `verify-multi-test-${tag.toLowerCase()}@example.invalid`,
      attachments,
      mode: 'demo',
      type: 'candidate',
    }

    process.stdout.write(`\n=== シナリオ${scenario.id}: ${scenario.name} ===\n`)
    const { status, json } = invoke(payload)
    if (status !== 200 || !json.ok) {
      console.log('  ❌ 関数呼び出し失敗:', status, JSON.stringify(json).slice(0, 300))
      manifest.push({ scenario: scenario.id, name: scenario.name, ok: false, error: json })
      continue
    }
    if (json.type !== 'multi-candidate' || json.count !== 5) {
      console.log(`  ⚠️  想定外のレスポンス型: type=${json.type} count=${json.count}`)
      console.log(`  raw: ${JSON.stringify(json).slice(0, 500)}`)
    }
    const byName = new Map((json.results ?? []).map(r => [r.name, r.id]))
    const entries = cands.map(c => ({
      initial: c.initial,
      id: byName.get(c.initial) ?? null,
      expectedMarker: expected.get(c.initial),
    }))
    manifest.push({ scenario: scenario.id, name: scenario.name, ok: true, entries })
    console.log(`  登録件数: ${json.count}`)
    entries.forEach(e => console.log(`    ${e.initial}: id=${e.id ?? '???'} 期待マーカー=${e.expectedMarker}`))
  }

  console.log('\n=== マニフェスト（検証・クリーンアップ用JSON） ===')
  console.log(JSON.stringify(manifest))
}

run().catch(err => { console.error(err); process.exit(1) })
