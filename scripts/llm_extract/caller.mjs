// llm_extract/caller.mjs — モデル呼び出し
// 既定: claude -p (サブスク枠・検証用)。ANTHROPIC_API_KEY があれば API直(本番想定・Batch移行前提)。
// どちらも同じ contract: callModel(model, prompt) -> {data, costUsd, ms, raw}
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
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

/**
 * `claude -p` を走らせる作業ディレクトリ。
 *
 * claude -p はカレントディレクトリのプロジェクト設定（CLAUDE.md 等）をシステムプロンプトに
 * 読み込む。ワーカーはプロジェクト直下で動いているため、**抽出のたびに約7,000トークン**を
 * 余計に送っていた（2026-08-14 実測: プロジェクト内 15,953 / 無関係なディレクトリ 9,006）。
 *
 * 抽出プロンプト（prompts.mjs）は自己完結していて背景知識を必要としない。
 * むしろ背景があると「本文に無い情報を補う」方向に働くので、渡さない方が望ましい。
 * 空のディレクトリを1つ作ってそこで実行する。
 */
const PROMPT_CWD = (() => {
  const dir = path.join(os.tmpdir(), 'akinavi-llm-cwd')
  try { fs.mkdirSync(dir, { recursive: true }); return dir } catch { return undefined }
})()

/** stdin にプロンプトを流して claude -p を実行（execFileのinputはSync専用のためspawnで）
 *  タイムアウト時は Windows なら taskkill でプロセスツリーごと落とす */
function spawnWithStdin(cmd, args, input, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const useExe = cmd === 'claude' && CLAUDE_EXE
    const p = spawn(useExe ? CLAUDE_EXE : cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WIN && !useExe,
      windowsHide: true,
      // プロジェクト設定（CLAUDE.md 等）を読み込ませないため空ディレクトリで起動する
      cwd: cmd === 'claude' ? PROMPT_CWD : undefined,
    })
    let out = '', err = ''
    const timer = setTimeout(() => {
      if (IS_WIN) {
        // taskkill 自体が失敗しても未処理 error でプロセスごと落ちないようにする
        const killer = spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
        killer.on('error', () => { /* 落とせなくても close/timeout 側で処理する */ })
      } else p.kill('SIGKILL')
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
    // 子プロセスが先に終了していると write が EPIPE / EOF を投げる。
    // stream の 'error' は未処理だと throw してワーカーごと落ちる
    // （実害: タイムアウトで taskkill した直後に "Error: write EOF" でクラッシュし、
    //  pm2 が再起動していた・2026-08-10 のログで確認）。
    // 終了理由は 'error'/'close' で受け取るので、ここでは握りつぶす
    p.stdin.on('error', () => {})
    try {
      p.stdin.write(input)
      p.stdin.end()
    } catch { /* 上と同じ理由。書けなければ close 側で拾われる */ }
  })
}

export const MODELS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5' }

function parseJsonLoose(txt) {
  let t = String(txt).replace(/^```json?\s*/m, '').replace(/```\s*$/m, '')
  const m = t.match(/\{[\s\S]*\}/)
  return JSON.parse(m ? m[0] : t)
}

/** 大型経歴書（数十案件のグリッド）は出力も長く180秒では足りない（AT 33案件PDF /
 *  AH 1.2MB PDF がリトライ込みでも timeout した実害・2026-08-08）。
 *  10KB を超えた分は 200文字あたり+1秒、上限480秒。通常サイズは従来どおり180秒 */
const timeoutForPrompt = (prompt) =>
  Math.min(480_000, 180_000 + Math.max(0, prompt.length - 10_000) * 5)

async function callViaClaudeP(modelId, prompt) {
  const t0 = Date.now()
  const stdout = await spawnWithStdin('claude', ['-p', '--model', modelId, '--output-format', 'json'], prompt, timeoutForPrompt(prompt))
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
