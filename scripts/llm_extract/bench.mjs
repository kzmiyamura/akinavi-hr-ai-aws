#!/usr/bin/env node
// llm_extract/bench.mjs — ルーター全体をベンチ入力で一括実行し、Fable基準と採点
//
// 使い方:
//   node scripts/llm_extract/bench.mjs <inputsディレクトリ> <refディレクトリ>
//   例: node scripts/llm_extract/bench.mjs $SP/bench/inputs ~/Downloads/model_bench_fable_golden_20260802
import fs from 'fs'
import path from 'path'
import { skillYearsFromProjects, normTech } from './lib.mjs'
import { extractProjects } from './run.mjs'

const [inputsDir, refDir] = process.argv.slice(2)
if (!inputsDir || !refDir) { console.error('usage: bench.mjs <inputsDir> <refDir>'); process.exit(1) }

const refs = fs.readdirSync(refDir).filter(f => f.endsWith('.json'))
const CONC = 3
const results = []

async function one(f) {
  const gridInput = JSON.parse(fs.readFileSync(path.join(inputsDir, f), 'utf8'))
  const ref = JSON.parse(fs.readFileSync(path.join(refDir, f), 'utf8'))
  const refSY = skillYearsFromProjects(ref.projects)
  const refKeys = Object.keys(refSY).map(normTech)
  try {
    const res = await extractProjects(gridInput, { log: m => console.error(`[${f}]`, m) })
    const sy = Object.fromEntries(Object.entries(res.skillYears).map(([k, v]) => [normTech(k), v]))
    const refMap = Object.fromEntries(Object.entries(refSY).map(([k, v]) => [normTech(k), v]))
    const found = refKeys.filter(k => sy[k] != null)
    const valOk = found.filter(k => Math.abs(sy[k] - refMap[k]) <= Math.max(3, refMap[k] * 0.1))
    results.push({
      f: f.replace('.xlsx.json', ''), model: res.model, status: res.status,
      reasons: res.reasons.join('|') || '-',
      refSkills: refKeys.length,
      cov: refKeys.length ? +(found.length / refKeys.length).toFixed(2) : 1,
      val: found.length ? +(valOk.length / found.length).toFixed(2) : 1,
      cost: +(res.costUsd ?? 0).toFixed(3), ms: res.ms,
    })
  } catch (e) {
    results.push({ f, error: String(e).slice(0, 120) })
  }
}

const queue = [...refs]
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) await one(queue.shift())
}))

results.sort((a, b) => a.f.localeCompare(b.f))
console.log(JSON.stringify(results, null, 1))
const ok = results.filter(r => !r.error)
const mean = xs => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null
console.log('=== ROUTED SUMMARY ===')
console.log('files:', ok.length,
  '| haiku採用:', ok.filter(r => r.model === 'haiku').length,
  '| sonnet昇格:', ok.filter(r => r.model === 'sonnet').length,
  '| needs_review:', ok.filter(r => r.status === 'needs_review').length)
console.log('実効スキル網羅率:', mean(ok.map(r => r.cov)),
  '| 実効年数一致率:', mean(ok.map(r => r.val)),
  '| 総コスト:$' + ok.reduce((a, r) => a + r.cost, 0).toFixed(3))
