#!/usr/bin/env node
/**
 * Box 自動取込の前後を比べる。
 * 「前」はローカル控え（今朝の時点）、「後」は現在のDB。**上書きで良くなったか悪くなったか**を数で見る。
 *
 *   node scripts/archive_diff_box.mjs
 *
 * Box の経歴書でメール添付の経歴書を上書きするので、
 * 詳細版に差し替わって良くなることもあれば、逆もあり得る。感覚で決めないための道具。
 * 「後」の取得は対象者ぶんだけ・必要な列だけ（egress は数十KB）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const DB_DIR = resolve(process.env.AKINAVI_ARCHIVE_DIR ?? 'D:\\akinavi-archive\\db')

function* rows(table) {
  const dir = join(DB_DIR, table)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

const skillYearKeys = (sy) => Object.keys(sy ?? {}).filter((k) => !k.startsWith('_')).length
const nSkills = (s) => (Array.isArray(s) ? s.length : 0)
const nProjects = (p) => (Array.isArray(p) ? p.length : 0)

// 「前」= 控えの中で Box URL を持っていた人
const before = new Map()
for (const c of rows('candidates')) {
  if (!c.box_url) continue
  before.set(c.id, c)
}
if (before.size === 0) {
  console.error('控えに Box URL を持つ人材がいません')
  process.exit(1)
}

// 「後」= 現在のDB。対象者ぶんだけ・必要な列だけ引く
const ids = [...before.keys()]
const q = `candidates?select=id,name,skills,experience_years,resume_url,box_status,box_error,`
  + `sy:raw_profile->skillYears,pj:raw_profile->projects&id=in.(${ids.join(',')})`
// sb-query.mjs は Windows で終了時に libuv の assertion で落ちることがある
// （データは stdout に出ている）。出力が取れていれば成功として扱う
let out
try {
  out = execFileSync('node', ['scripts/llm_extract/sb-query.mjs', q, '--raw'], { encoding: 'utf8' })
} catch (e) {
  out = String(e.stdout ?? '')
  if (!out.includes('[')) throw e
}
const after = new Map(JSON.parse(out.slice(out.indexOf('['))).map((r) => [r.id, r]))

const fmt = (a, b) => (a === b ? `${a}` : `${a} → ${b}`)
const mark = (a, b) => (b > a ? '↑' : b < a ? '↓' : ' ')

let better = 0, worse = 0, same = 0, failed = 0
const lines = []
for (const [id, b] of before) {
  const a = after.get(id)
  if (!a) continue
  if (a.box_status === 'failed') { failed++; lines.push(`  ${String(a.name).padEnd(6)} 取込失敗: ${a.box_error ?? '(理由なし)'}`); continue }
  const bs = nSkills(b.skills), as = nSkills(a.skills)
  const by = skillYearKeys(b.rp_skillYears), ay = skillYearKeys(a.sy)
  const bp = nProjects(b.rp_projects), ap = nProjects(a.pj)
  const be = b.experience_years ?? 0, ae = a.experience_years ?? 0
  const score = (as - bs) + (ay - by) + (ap - bp)
  if (score > 0) better++; else if (score < 0) worse++; else same++
  lines.push(
    `  ${String(a.name).padEnd(6)} スキル ${fmt(bs, as)}${mark(bs, as)}  ` +
    `スキル年数 ${fmt(by, ay)}${mark(by, ay)}  案件 ${fmt(bp, ap)}${mark(bp, ap)}  ` +
    `経験 ${fmt(be, ae)}年${mark(be, ae)}`)
}

console.log(`Box自動取込の前後（前=今朝の控え / 後=現在のDB）\n`)
console.log(lines.join('\n'))
console.log(`\n増えた ${better} 人 / 減った ${worse} 人 / 変化なし ${same} 人 / 取込失敗 ${failed} 人`)
console.log('※ 項目が増える＝経歴書が詳しくなった、が基本。減っていたら上書きで劣化した疑い')
