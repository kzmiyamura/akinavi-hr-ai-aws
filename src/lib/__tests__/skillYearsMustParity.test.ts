import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 「スキル年数・居住地はマスト」（2026-10-31 営業の指示）が、順位を決める SQL と
 * 画面の点数を出す match-batch と、呼び出し側の全部に入っていることを縛る。
 *
 * 配点は SQL / match-batch の2か所にあり、片方だけ直すと SQL が上に並べた人を
 * 画面の点数が並べ直す（画面は match_score 順に出す）。年数の足切りは呼び出し側が
 * 案件の requiredSkillYears を渡さないと効かないので、渡し忘れも見る。
 * 判定そのもののテストは scripts/sql/test_skill_years_must.sql（本番 DB で実行）。
 */
const root = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

/** fetch_candidates_for_project を最後に定義しているマイグレーション */
function latestRpcMigration(): string {
  const dir = resolve(root, 'supabase/migrations')
  const files = readdirSync(dir)
    .filter((f) => /^\d{8}/.test(f))
    .sort()
    .filter((f) => /CREATE (OR REPLACE )?FUNCTION public\.fetch_candidates_for_project\(/.test(read(`supabase/migrations/${f}`)))
  return read(`supabase/migrations/${files[files.length - 1]}`)
}

describe('スキル年数のマスト', () => {
  const sql = latestRpcMigration()
  const batch = read('supabase/functions/match-batch/index.ts')

  it('SQL は案件が年数を書いた技術で足切りする', () => {
    expect(sql).toContain('p_required_skill_years jsonb DEFAULT NULL')
    expect(sql).toContain('AND pre.years_ok')
  })

  it('SQL と match-batch は年数の取れていない技術を同じく半分にする', () => {
    expect(sql).toContain('(pre.hit_w - 0.5 * pre.unv_w) / v_total_weight')
    expect(batch).toContain("supabase.rpc('match_unverified_tech_batch'")
    expect(batch).toContain('* (unverified ? 0.5 : 1)')
  })

  it('match-batch は両方の向き（案件→人材・人材→案件）で年数を見る', () => {
    // 案件→人材: 候補者ごとの組 / 人材→案件: 1人ぶんの組
    expect(batch).toContain('unverifiedMap ? (unverifiedMap.get(i) ?? new Set<string>()) : null)')
    expect(batch).toContain('calcRuleScore(candidateProfile, p, weights, satisfiedSet, unverifiedSet)')
  })
})

describe('呼び出し側が案件の年数指定を渡す', () => {
  it('画面の取得関数が RPC に渡す', () => {
    expect(read('src/lib/db/candidates.ts')).toContain('p_required_skill_years: params.requiredSkillYears ?? null')
  })

  it('マッチング画面の呼び出しは全部 requiredSkillYears を渡す', () => {
    const page = read('src/pages/MatchingPage.tsx')
    const calls = page.split('await fetchCandidatesForProject(').slice(1).map((s) => s.split('\n')[1] ?? '')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c).toContain('requiredSkillYears:')
  })

  it('上位候補の印も渡す（渡さないと印だけ足切りが効かない）', () => {
    const dir = resolve(root, 'supabase/migrations')
    const f = readdirSync(dir).filter((x) => /^\d{8}/.test(x)).sort()
      .filter((x) => read(`supabase/migrations/${x}`).includes('FUNCTION public.refresh_top_match_marks('))
    expect(read(`supabase/migrations/${f[f.length - 1]}`)).toContain("p_required_skill_years => p.raw_data->'requiredSkillYears'")
  })
})
