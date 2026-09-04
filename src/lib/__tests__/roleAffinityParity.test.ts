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
 * 定義は docs/ROLE_DEFINITION.md、SQL 実体は 20260902_role_affinity_level.sql。
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

/** docs/ROLE_DEFINITION.md 3章の式。実効権限＝ラベルの権限＋レベル補正 */
function affinity(
  required: string | null,
  candidate: string | null,
  lv?: string | null,
): number {
  if (!required?.trim() || !candidate?.trim()) return 0.5
  if (required === candidate) return 1.0
  const r = AXIS[required], c = AXIS[candidate]
  if (!r || !c) return 0.5
  const d = DIST[r.object]?.[c.object]
  if (d == null) return 0.5
  const objCoef = d === 0 ? 1.0 : d === 1 ? 0.6 : 0.35
  const adj = lv === 'A' ? 2 : lv === 'C' ? -1 : 0
  const eff = Math.min(4, Math.max(1, c.authority + adj))
  const gap = eff - r.authority
  const authCoef = gap === 0
    ? 1.0
    : gap > 0
      ? (gap === 1 ? 0.9 : gap === 2 ? 0.8 : 0.7)
      : (gap === -1 ? 0.75 : gap === -2 ? 0.5 : 0.3)
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

  it('係数と実効権限の式が docs/ROLE_DEFINITION.md のとおり書かれている', () => {
    expect(SRC).toContain('d === 0 ? 1.0 : d === 1 ? 0.6 : 0.35')
    // 格上（gap>0）は 0.9/0.8/0.7、格下は 0.75/0.5/0.3
    expect(SRC).toContain('gap === 1 ? 0.9 : gap === 2 ? 0.8 : 0.7')
    expect(SRC).toContain('gap === -1 ? 0.75 : gap === -2 ? 0.5 : 0.3')
    // 到達レベルによる権限補正 A:+2 / C:-1
    expect(SRC).toContain("candidateLevel === 'A' ? 2 : candidateLevel === 'C' ? -1 : 0")
    expect(SRC).toContain('Math.min(4, Math.max(1, c.authority + adj))')
    expect(SRC).toContain('Math.min(0.9, Math.max(0.2, objCoef * authCoef))')
  })
})

describe('SQL の単体テストと同じ期待値になること', () => {
  // scripts/sql/test_role_affinity.sql と同じケース
  const cases: Array<[string | null, string | null, string | null, number, string]> = [
    // 完全一致
    ['PMO', 'PMO', null, 1.0, '同一ラベル'],
    ['ヘルプデスク', 'ヘルプデスク', null, 1.0, '同一ラベル'],
    ['プロジェクトマネージャー', 'プロジェクトマネージャー', 'C', 1.0, '同一ラベルはレベルで割り引かない'],

    // ★ 到達レベルが効くこと
    ['プロジェクトマネージャー', 'PMO', 'A', 0.45, '★PMO A級はPM案件に届く'],
    ['プロジェクトマネージャー', 'PMO', 'B', 0.2, '★B級は最遠のまま'],
    ['プロジェクトマネージャー', 'PMO', 'C', 0.2, '★C級（議事録・PC手配）は最遠のまま'],
    ['プロジェクトマネージャー', 'PMO', '-', 0.2, '裏付けなしは補正しない'],
    ['プロジェクトマネージャー', 'PMO', null, 0.2, 'レベル未判定は補正しない'],
    ['プロジェクトマネージャー', 'テックリード', 'A', 0.6, 'A級TLはPM案件で権限が並ぶ'],
    ['プロジェクトマネージャー', 'テックリード', null, 0.45, '無印TL'],
    ['プロジェクトマネージャー', 'テックリード', 'C', 0.3, 'C級TLは落ちる'],

    // 格上は落としすぎない（非対称）
    ['システムエンジニア', 'アーキテクト', null, 0.9, '格上1段。旧は対称で0.75だった'],
    ['システムエンジニア', 'アーキテクト', 'A', 0.8, '格上2段'],
    ['ヘルプデスク', '運用保守', null, 0.9, '格上1段'],
    ['PMO', 'スクラムマスター', null, 0.9, '格上1段'],
    ['PMO', 'プロジェクトマネージャー', null, 0.42, 'PMO案件にPM人材＝格上3段'],
    ['プログラマー', 'プロジェクトマネージャー', null, 0.48, '格上2段'],
    ['ヘルプデスク', 'MLエンジニア', null, 0.54, '畑違いはスキル側で落ちる'],

    // 格下は従来どおり
    ['プロジェクトマネージャー', 'プロジェクトリーダー', null, 0.75, '格下1段'],
    ['プロジェクトリーダー', 'システムエンジニア', null, 0.45, '対象隣接・格下1段'],
    ['プロジェクトリーダー', 'システムエンジニア', 'C', 0.3, 'C級は格下2段まで落ちる'],
    ['プロジェクトマネージャー', 'システムエンジニア', null, 0.3, '対象隣接・格下2段'],
    ['運用保守', 'PMO', null, 0.45, '対象隣接・格下1段'],
    ['システムエンジニア', 'PMO', null, 0.2625, '★実装案件のPMO。低いまま維持'],
    ['プロジェクトマネージャー', 'ヘルプデスク', null, 0.2, '対象も権限も最遠'],

    // 同じ高さ
    ['システムエンジニア', 'プログラマー', null, 0.9, '同じマス（上限0.9）'],
    ['ヘルプデスク', 'PMO', null, 0.6, '権限同じL1・対象隣接'],
    ['プロジェクトリーダー', 'テックリード', null, 0.6, '統率同士'],
    ['コンサルタント', 'アーキテクト', null, 0.6, '事業↔製品の隣接'],

    // 不明は中立
    ['システムエンジニア', null, null, 0.5, '人材側に役割なし'],
    [null, 'PMO', null, 0.5, '案件側に要求役割なし'],
    ['', 'PMO', null, 0.5, '空文字も不明扱い'],
    ['システムエンジニア', 'データサイエンティスト', null, 0.5, '一覧に無いラベルは中立'],
  ]

  for (const [req, cand, lv, expected, memo] of cases) {
    it(`${req ?? '(null)'} × ${cand ?? '(null)'}${lv ? `(${lv}級)` : ''} = ${expected}（${memo}）`, () => {
      expect(affinity(req, cand, lv)).toBeCloseTo(expected, 6)
    })
  }
})
