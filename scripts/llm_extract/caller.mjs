// llm_extract/caller.mjs — モデル呼び出し
// 既定: claude -p (サブスク枠・検証用)。ANTHROPIC_API_KEY があれば API直(本番想定・Batch移行前提)。
// どちらも同じ contract: callModel(model, prompt) -> {data, costUsd, ms, raw}
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const IS_WIN = process.platform === 'win32'

/** Windows の `claude` は npm の .cmd/.ps1 シム。shell 経由で起動すると
 *  呼び出しのたびにコンソール窓が点滅する（windowsHide が shell:true では効かない）。
 *  実体の claude.exe を1度だけ解決して直接起動する。見つからなければ shell 経由にフォールバック。 */
const resolveClaudeExe = () => {
  if (!IS_WIN) return null
  const guess = path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
  if (fs.existsSync(guess)) return guess
  try {
    for (const line of execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)) {
      if (line.trim().toLowerCase().endsWith('.exe') && fs.existsSync(line.trim())) return line.trim()
    }
  } catch { /* where が無い環境 */ }
  return null
}
const CLAUDE_EXE = resolveClaudeExe()

/** stdin にプロンプトを流して claude -p を実行（execFileのinputはSync専用のためspawnで）
 *  タイムアウト時は Windows なら taskkill でプロセスツリーごと落とす */
function spawnWithStdin(cmd, args, input, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const useExe = cmd === 'claude' && CLAUDE_EXE
    const p = spawn(useExe ? CLAUDE_EXE : cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WIN && !useExe,
      windowsHide: true,
    })
    let out = '', err = ''
    const timer = setTimeout(() => {
      if (IS_WIN) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'])
      else p.kill('SIGKILL')
      reject(new Error('timeout'))
    }, timeoutMs)
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

/** パース失敗・タイムアウトは同モデルで1回リトライ。それでもダメなら throw
 *  （タイムアウトはシャドー運転の失敗要因の最多。放置すると該当人材だけ上書きされず取り残される） */
export async function callModel(modelKey, prompt) {
  const modelId = MODELS[modelKey] ?? modelKey
  const impl = process.env.ANTHROPIC_API_KEY ? callViaApi : callViaClaudeP
  try {
    return await impl(modelId, prompt)
  } catch (e) {
    if (e instanceof SyntaxError || /timeout/i.test(String(e.message))) return await impl(modelId, prompt)
    throw e
  }
}
