/**
 * PostgreSQL JSONB に入らない文字の除去（inbound-email の sanitizeDeepForPgJson）の回帰テスト。
 *
 * ⚠ 2026-10-03 まで、除去は**本文とブロック本文の2か所にしか効いていなかった**。
 *    `name` / `attachmentText` / `selfPR` / `agentComment` / `skillSummary` は素通りで、
 *    `候補者保存エラー: unsupported Unicode escape sequence` が64件出ていた。
 *    **その人材は保存されずに消えている**（メールも7日で消えるので取り返せない）。
 *    夜間健診（scripts/selfcheck）が ai_logs を数えて見つけた。
 *
 * ⚠ もう一つ。旧実装の `/[\uD800-\uDFFF]/g` は**対になったサロゲートまで消していた**。
 *    基本多言語面の外の漢字（氏名に出る）が丸ごと落ちる。
 *
 * 手写しのレプリカは作らず **index.ts から切り出して**検証する
 * （companyNameGate.test.ts / irrelevantMail.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

/** NUL をソースに書くとツールが壊すので、必ずコード側で作る */
const NUL = String.fromCharCode(0)
/** 対になったサロゲート（U+20BB7・「つちよし」の異体字）。氏名に実在する */
const PAIRED = String.fromCharCode(0xd842, 0xdfb7)
/** 孤立した上位サロゲート・下位サロゲート */
const LONE_HIGH = String.fromCharCode(0xd842)
const LONE_LOW = String.fromCharCode(0xdfb7)

type Deep = <T>(v: T) => T

function load(): { shallow: (s: string) => string; deep: Deep } {
  const src = readFileSync(SRC, 'utf8')

  const re = src.match(/const PG_JSON_LONE_SURROGATE_RE =\s*(\/[\s\S]*?\/[gimsuy]*)\r?\n/)
  const shallow = src.match(/function sanitizeForPgJson\(s: string\): string \{([\s\S]*?)\n\}/)
  const deep = src.match(/function sanitizeDeepForPgJson<T>\(value: T\): T \{([\s\S]*?)\n\}/)
  if (!re || !shallow || !deep) throw new Error('index.ts から切り出せませんでした')

  // `new Function` は TS を解さないので、使っている注釈だけを落とす。
  // 一般的な変換ではない（ここに出てくる形に限る）。増えたらこの一覧を足す
  const stripTs = (s: string) => s
    .replace(/ as unknown as T\b/g, '')
    .replace(/ as Record<string, unknown>/g, '')
    .replace(/: Record<string, unknown>/g, '')

  const fns = new Function(`
    const PG_JSON_LONE_SURROGATE_RE = ${re[1]};
    function sanitizeForPgJson(s) {${stripTs(shallow[1])}
    }
    function sanitizeDeepForPgJson(value) {${stripTs(deep[1])}
    }
    return { shallow: sanitizeForPgJson, deep: sanitizeDeepForPgJson };
  `)()
  return fns as { shallow: (s: string) => string; deep: Deep }
}

const { shallow, deep } = load()

describe('落とすもの', () => {
  it('null byte を落とす（これが保存を失敗させていた）', () => {
    expect(shallow(`A${NUL}B`)).toBe('AB')
  })
  it('孤立した上位サロゲートを落とす', () => {
    expect(shallow(`A${LONE_HIGH}B`)).toBe('AB')
  })
  it('孤立した下位サロゲートを落とす', () => {
    expect(shallow(`A${LONE_LOW}B`)).toBe('AB')
  })
  it('連続した孤立サロゲートも落とす', () => {
    expect(shallow(`${LONE_HIGH}${LONE_HIGH}A`)).toBe('A')
  })
})

describe('落としてはいけないもの', () => {
  it('対になったサロゲートは残す（旧実装はここを消していた）', () => {
    expect(shallow(`山田${PAIRED}太郎`)).toBe(`山田${PAIRED}太郎`)
    expect(shallow(PAIRED)).toHaveLength(2)
  })
  it('絵文字も残す', () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00)   // U+1F600
    expect(shallow(emoji)).toBe(emoji)
  })
  it('普通の日本語・英数字はそのまま', () => {
    expect(shallow('A.B 32歳 Java/Spring 単価70万')).toBe('A.B 32歳 Java/Spring 単価70万')
  })
  it('空・null でも落ちない', () => {
    expect(shallow('')).toBe('')
    expect(shallow(null as unknown as string)).toBe('')
  })
})

describe('payload をまるごと歩く（項目を列挙しないのが肝）', () => {
  it('2026-10-03 まで素通りしていた項目が全部きれいになる', () => {
    const payload = {
      data_env: 'prod',
      name: `A.B${NUL}`,
      experience_years: 10,
      skills: [`Java${NUL}`, 'Spring'],
      raw_profile: {
        text: 'clean',
        attachmentText: `経歴書${NUL}の中身`,
        selfPR: `自己PR${LONE_HIGH}`,
        agentComment: `コメント${NUL}`,
        skillSummary: `まとめ${LONE_LOW}`,
        skillYears: { [`Java${NUL}`]: 60 },
        projects: [{ title: `案件${NUL}A` }],
      },
    }
    const out = deep(payload)
    expect(out.name).toBe('A.B')
    expect(out.skills).toEqual(['Java', 'Spring'])
    expect(out.raw_profile.attachmentText).toBe('経歴書の中身')
    expect(out.raw_profile.selfPR).toBe('自己PR')
    expect(out.raw_profile.agentComment).toBe('コメント')
    expect(out.raw_profile.skillSummary).toBe('まとめ')
    // キー名に紛れ込んでいても保存は失敗するので、キーも歩く
    expect(Object.keys(out.raw_profile.skillYears)).toEqual(['Java'])
    expect(out.raw_profile.projects[0].title).toBe('案件A')
    // 文字列以外は素通り
    expect(out.experience_years).toBe(10)
    expect(out.data_env).toBe('prod')
  })

  it('null / undefined / 数値 / 真偽値を壊さない', () => {
    const out = deep({ a: null, b: undefined, c: 0, d: false, e: '' })
    expect(out).toEqual({ a: null, b: undefined, c: 0, d: false, e: '' })
  })

  it('入れ替えても元の payload を書き換えない（再解析で二重に効かないこと）', () => {
    const src = { name: `X${NUL}` }
    const out = deep(src)
    expect(src.name).toBe(`X${NUL}`)
    expect(out.name).toBe('X')
  })

  it('Date は Date のまま返す（素のオブジェクトだけ歩く）', () => {
    const d = new Date('2026-10-03T00:00:00Z')
    expect(deep({ at: d }).at).toBe(d)
  })
})
