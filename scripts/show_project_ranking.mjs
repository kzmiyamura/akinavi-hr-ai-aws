// 案件の submissions 上位を名前・スコア・必須スキル充足だけで一覧する（egress節約のため skills は数えるだけ）
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envText = readFileSync('C:/Users/admin/Desktop/projects/akinavi-hr-ai-aws/.env.local', 'utf8')
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)

const PROJECT = process.argv[2]
const REQ = (process.argv[3] ?? '').split(',').filter(Boolean)

const { data, error } = await supabase
  .from('submissions')
  .select('match_score, ai_raw, candidates(name, skills)')
  .eq('project_id', PROJECT).eq('data_env', 'prod')
  .order('match_score', { ascending: false })
  .limit(10)
if (error) { console.error(error.message); process.exit(1) }

for (const [i, s] of data.entries()) {
  const sk = s.candidates?.skills ?? []
  const hit = REQ.filter(r => sk.some(x => x.toLowerCase() === r.toLowerCase()))
  console.log(
    `${String(i + 1).padStart(2)}. ${(s.candidates?.name ?? '?').padEnd(6)} ${String(s.match_score).padStart(3)}pt` +
    `  完全一致 ${hit.length}/${REQ.length} [${hit.join(' ')}]`
  )
}
