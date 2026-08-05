// llm_extract/caller.mjs — モデル呼び出し
// 既定: claude -p (サブスク枠・検証用)。ANTHROPIC_API_KEY があれば API直(本番想定・Batch移行前提)。
// どちらも同じ contract: callModel(model, prompt) -> {data, costUsd, ms, raw}
import { spawn } from 'child_process'

/** stdin にプロンプトを流して claude -p を実行（execFileのinputはSync専用のためspawnで） */
function spawnWithStdin(cmd, args, input, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')) }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', c => {
      clearTimeout(timer)
      if (c === 0) resolve(out)
      else reject(new Error(`exit=${c} ${err.slice(0, 300)}`))
    })
    p.stdin.write(input)
    p.stdin.end()
  })
}

export const MODELS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5' }

function parseJsonLoose(txt) {
  let t = String(txt).replace(/^```json?\s*/m, '').replace(/```\s*$/m, '')
  const m = t.match(/\{[\s\S]*\}/)
  return JSON.parse(m ? m[0] : t)
}

async function callViaClaudeP(modelId, prompt) {
  const t0 = Date.now()
  const stdout = await spawnWithStdin('claude', ['-p', '--model', modelId, '--output-format', 'json'], prompt)
  const wrap = JSON.parse(stdout)
  return { data: parseJsonLoose(wrap.result), costUsd: wrap.total_cost_usd ?? null, ms: Date.now() - t0, raw: wrap.result }
}

async function callViaApi(modelId, prompt) {
  const t0 = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const text = j.content?.find(b => b.type === 'text')?.text ?? ''
  return { data: parseJsonLoose(text), costUsd: null, ms: Date.now() - t0, raw: text, usage: j.usage }
}

/** 1回パース失敗したら同モデルでリトライ(1回)。それでもダメなら throw */
export async function callModel(modelKey, prompt) {
  const modelId = MODELS[modelKey] ?? modelKey
  const impl = process.env.ANTHROPIC_API_KEY ? callViaApi : callViaClaudeP
  try {
    return await impl(modelId, prompt)
  } catch (e) {
    if (e instanceof SyntaxError) return await impl(modelId, prompt)
    throw e
  }
}
