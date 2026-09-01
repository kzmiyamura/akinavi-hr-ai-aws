import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * match-batch の roleAffinity が、DB の role_affinity と同じ値を返すことを縛る。
 *
 * 配点は SQL / match-batch / フロントの3か所にあり、片方だけ直して順位と表示が
 * 食い違った事故がある（CLAUDE.md 参照）。ここでは match-batch/index.ts を
 * **テキストとして読んで** 定義表と係数を取り出し、SQL 側の単体テスト
 * （scripts/sql/test_role_affinity.sql）と同じ期待値に一致するかを見る。
 *
 * 定義は docs/ROLE_DEFINITION.md、SQL 実体は 20260901_role_taxonomy.sql。
 */
const SRC = readFileSync(
  resolve(__dirname, '../../../supabase/functions/match-batch/index.ts'),
  'utf8',
)

/** `'ラベル': { object: 'X', authority: N },` を拾う */
function parseAxis(): Record<string, { object: string; authority: number }> {
  const block = SRC.split('const ROLE_AXIS')[1]?.split('\n}')[0] ?? ''
  const out: Record<string, { object: string; authority: number }> = {}
  for (const m of block.matchAll(
    /'([^']+)':\s*\{\s*object:\s*'([^']+)',\s*authority:\s*(\d)\s*\}/g,
  )) {
    out[m[1]] = { object: m[2], authority: Number(m[3]) }
  }
  return out
}

/** `'対象': { '対象': N, ... },` を拾う */
function parseDistance(): Record<string, Record<string, number>> {
  const block = SRC.split('const OBJECT_DISTANCE')[1]?.split('\n}')[0] ?? ''
  const out: Record<string, Record<string, number>> = {}
  for (const row of block.matchAll(/'([^']+)':\s*\{([^}]+)\}/g)) {
    const inner: Record<string, number> = {}
    for (const cell of row[2].matchAll(/'([^']+)':\s*(\d)/g)) inner[cell[1]] = Number(cell[2])
    out[row[1]] = inner
  }
  return out
}

const AXIS = parseAxis()
const DIST = parseDistance()

function affinity(required: string | null, candidate: string | null): number {
  if (!required?.trim() || !candidate?.trim()) return 0.5
  if (required === candidate) return 1.0
  const r = AXIS[required], c = AXIS[candidate]
  if (!r || !c) return 0.5
  const d = DIST[r.object]?.[c.object]
  if (d == null) return 0.5
  const objCoef = d === 0 ? 1.0 : d === 1 ? 0.6 : 0.35
  const gap = Math.abs(r.authority - c.authority)
  const authCoef = gap === 0 ? 1.0 : gap === 1 ? 0.75 : gap === 2 ? 0.5 : 0.3
  return Math.min(0.9, Math.max(0.2, objCoef * authCoef))
}

describe('match-batch の定義表が読めていること', () => {
  it('19ラベルすべてに作用対象と権限がある', () => {
    expect(Object.keys(AXIS)).toHaveLength(19)
    expect(AXIS['PMO']).toEqual({ object: '仕組み', authority: 1 })
    expect(AXIS['プロジェクトマネージャー']).toEqual({ object: '成果', authority: 4 })
  })

  it('対象距離が5×5そろっている', () => {
    expect(Object.keys(DIST)).toHaveLength(5)
    for (const a of Object.keys(DIST)) expect(Object.keys(DIST[a])).toHaveLength(5)
  })

  it('対象距離は対称（片側だけ直すと非対称になる）', () => {
    for (const a of Object.keys(DIST)) {
      for (const b of Object.keys(DIST[a])) expect(DIST[a][b]).toBe(DIST[b][a])
    }
  })

  it('係数が docs/ROLE_DEFINITION.md のとおり書かれている', () => {
    expect(SRC).toContain('d === 0 ? 1.0 : d === 1 ? 0.6 : 0.35')
    expect(SRC).toContain('gap === 0 ? 1.0 : gap === 1 ? 0.75 : gap === 2 ? 0.5 : 0.3')
    expect(SRC).toContain('Math.min(0.9, Math.max(0.2, objCoef * authCoef))')
  })
})

describe('SQL の単体テストと同じ期待値になること', () => {
  // scripts/sql/test_role_affinity.sql と同じ23ケース
  const cases: Array<[string | null, string | null, number, string]> = [
    ['PMO', 'PMO', 1.0, '同一ラベル'],
    ['ヘルプデスク', 'ヘルプデスク', 1.0, '同一ラベル'],
    ['プロジェクトマネージャー', 'PMO', 0.2, '★PM案件にPMO＝最遠。旧0.7'],
    ['PMO', 'プロジェクトマネージャー', 0.2, '★逆向きも同じ'],
    ['プロジェクトマネージャー', 'プロジェクトリーダー', 0.75, '対象同じ・権限1段差'],
    ['システムエンジニア', 'プログラマー', 0.9, '同じマス（上限0.9）'],
    ['ヘルプデスク', '運用保守', 0.75, 'サービス同士・権限1段差'],
    ['システムエンジニア', 'アーキテクト', 0.75, '製品同士・権限1段差'],
    ['PMO', 'スクラムマスター', 0.75, '仕組み同士'],
    ['ヘルプデスク', 'PMO', 0.6, '権限同じL1・対象隣接'],
    ['プロジェクトリーダー', 'テックリード', 0.6, '統率同士'],
    ['コンサルタント', 'アーキテクト', 0.6, '事業↔製品の隣接'],
    ['運用保守', 'PMO', 0.45, '対象隣接・権限1段差'],
    ['プロジェクトリーダー', 'システムエンジニア', 0.45, '旧0.2は誤り'],
    ['プロジェクトマネージャー', 'システムエンジニア', 0.3, '対象隣接・権限2段差'],
    ['プログラマー', 'プロジェクトマネージャー', 0.3, '逆向き'],
    ['システムエンジニア', 'PMO', 0.2625, '★実装案件のPMO。低いまま維持'],
    ['プロジェクトマネージャー', 'ヘルプデスク', 0.2, '対象も権限も最遠'],
    ['ヘルプデスク', 'MLエンジニア', 0.45, '畑違いはスキル側で落ちる'],
    ['システムエンジニア', null, 0.5, '人材側に役割なし'],
    [null, 'PMO', 0.5, '案件側に要求役割なし'],
    ['', 'PMO', 0.5, '空文字も不明扱い'],
    ['システムエンジニア', 'データサイエンティスト', 0.5, '一覧に無いラベルは中立'],
  ]

  for (const [req, cand, expected, memo] of cases) {
    it(`${req ?? '(null)'} × ${cand ?? '(null)'} = ${expected}（${memo}）`, () => {
      expect(affinity(req, cand)).toBeCloseTo(expected, 6)
    })
  }
})
