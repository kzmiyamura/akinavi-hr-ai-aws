/** 通知ルールの判定（notify-candidates/match.ts）の回帰テスト。
 *
 *  本体は Edge Function 側の純関数だが、**このマシンに deno が入っていない**ため
 *  deno test が動かない（HANDOFF.md 8/16 の注記）。vitest から直接 import して検証する。
 *  match_test.ts（deno版）と両方を残しているのは、CI 側で deno が使える環境のため。
 */
import { describe, it, expect } from 'vitest'
import {
  matchesRule,
  matchedSkills,
  matchesText,
  ruleNeedsText,
  ruleHasCondition,
  type CandidateLite,
  type NotifyRule,
} from '../../../supabase/functions/notify-candidates/match.ts'

const rule = (over: Partial<NotifyRule>): NotifyRule => ({
  id: 'r1', label: '', name_keyword: '', skill_keywords: [], station_keyword: '',
  notify_email: 'a@example.com', enabled: true, data_env: 'prod', ...over,
})
const cand = (over: Partial<CandidateLite>): CandidateLite => ({
  id: 'c1', name: 'T.K', skills: ['Java', 'Spring Boot', 'AWS'],
  station: '西船橋駅 千葉県', data_env: 'prod', ...over,
})

describe('年齢・経験・レベル・本文の条件（2026-10-01 追加）', () => {
  // 現場の要求: 「共通部品を作ったことがある経験と Java開発経験が必要、
  //   20代後半〜40代まで、教育が必要な人は難しい」
  const 基盤チーム = rule({
    skill_keywords: ['Java'],
    skill_years_min: 3,
    age_min: 25, age_max: 49,
    exclude_level_c: true,
    text_keywords: ['共通部品', '共通基盤'],
  })

  // ⚠ skillYears は名前に反して**月数**（実データ: Visual Basic 84 ＝ 7年）。
  //   ルールの skill_years_min は「年」なので、判定側で12倍して比べている
  it('現場の要求を1本のルールで表現できる', () => {
    const 合う = cand({
      age: 34, skillYears: { Java: 96, AWS: 36 }, // 8年 / 3年
      roleLevels: { 'テックリード': 'B' },
      text: '共通部品の設計・実装を担当',
    })
    expect(matchesRule(基盤チーム, 合う)).toBe(true)
  })

  it('年齢の範囲外は落ちる', () => {
    const base = { skillYears: { Java: 96 }, roleLevels: { 'テックリード': 'B' }, text: '共通部品' }
    expect(matchesRule(基盤チーム, cand({ ...base, age: 22 }))).toBe(false)
    expect(matchesRule(基盤チーム, cand({ ...base, age: 55 }))).toBe(false)
    expect(matchesRule(基盤チーム, cand({ ...base, age: 25 }))).toBe(true) // 境界は含む
    expect(matchesRule(基盤チーム, cand({ ...base, age: 49 }))).toBe(true)
  })

  it('指定スキルの年数が足りなければ落ちる（データは月数・ルールは年）', () => {
    const base = { age: 34, roleLevels: { 'テックリード': 'B' }, text: '共通部品' }
    expect(matchesRule(基盤チーム, cand({ ...base, skillYears: { Java: 35 } }))).toBe(false) // 2年11か月
    expect(matchesRule(基盤チーム, cand({ ...base, skillYears: { Java: 36 } }))).toBe(true)  // ちょうど3年
    // 月数を年数と取り違えると「3」で通ってしまう。3か月では落ちること
    expect(matchesRule(基盤チーム, cand({ ...base, skillYears: { Java: 3 } }))).toBe(false)
  })

  it('到達レベルは「Cしか無い人」だけ外す（AやBが1つでもあれば残す）', () => {
    const base = { age: 34, skillYears: { Java: 96 }, text: '共通部品' }
    // C だけ＝従事どまり。教育が必要な人に一番近い印なので外す
    expect(matchesRule(基盤チーム, cand({ ...base, roleLevels: { 'PMO': 'C' } }))).toBe(false)
    // 役割ごとに別々に判定されるので A と C が同居する。これは外さない
    expect(matchesRule(基盤チーム, cand({ ...base, roleLevels: { 'PMO': 'C', 'アーキテクト': 'A' } }))).toBe(true)
    // 印が1つも無い人（実測49%）は「Cである」ではないので既定では残す
    expect(matchesRule(基盤チーム, cand({ ...base, roleLevels: null }))).toBe(true)
  })

  it('本文キーワードは OR。1つでも当たれば通る', () => {
    const base = { age: 34, skillYears: { Java: 96 }, roleLevels: { 'テックリード': 'B' } }
    expect(matchesRule(基盤チーム, cand({ ...base, text: '共通基盤の刷新を担当' }))).toBe(true)
    expect(matchesRule(基盤チーム, cand({ ...base, text: '画面の改修のみ' }))).toBe(false)
  })

  it('本文が渡されていない（未取得）ときは本文条件を判定しない', () => {
    // 本文は重いので後段で引く。この段階では落とさず、matchesText で見る
    const c = cand({ age: 34, skillYears: { Java: 96 }, roleLevels: { 'テックリード': 'B' }, text: undefined })
    expect(matchesRule(基盤チーム, c)).toBe(true)
    expect(ruleNeedsText(基盤チーム)).toBe(true)
    expect(matchesText(基盤チーム, '共通部品を作った')).toBe(true)
    expect(matchesText(基盤チーム, '画面の改修のみ')).toBe(false)
  })

  it('include_unknown=false にすると、値が取れていない人を落とす', () => {
    const 厳しめ = rule({ age_min: 25, age_max: 49, include_unknown: false })
    expect(matchesRule(厳しめ, cand({ age: null }))).toBe(false)
    expect(matchesRule(厳しめ, cand({ age: 34 }))).toBe(true)
    // 既定（true）なら取れていない人は通す
    const 既定 = rule({ age_min: 25, age_max: 49 })
    expect(matchesRule(既定, cand({ age: null }))).toBe(true)
  })

  it('新しい条件だけでもルールとして成立する（暴発防止の判定に含まれる）', () => {
    expect(ruleHasCondition(rule({ age_min: 25 }))).toBe(true)
    expect(ruleHasCondition(rule({ exclude_level_c: true }))).toBe(true)
    expect(ruleHasCondition(rule({ text_keywords: ['共通部品'] }))).toBe(true)
    expect(ruleHasCondition(rule({ text_keywords: ['  '] }))).toBe(false)
    expect(ruleHasCondition(rule({ exclude_level_c: false }))).toBe(false)
  })

  it('移行前に作られたルール（新列が未定義）でも従来どおり動く', () => {
    const 旧 = rule({ skill_keywords: ['Java'] })
    expect(matchesRule(旧, cand({ age: null, skillYears: null, roleLevels: null }))).toBe(true)
  })
})

describe('matchesRule', () => {
  it('条件なしルールは何にもマッチしない（全員通知の暴発防止）', () => {
    expect(matchesRule(rule({}), cand({}))).toBe(false)
    expect(ruleHasCondition(rule({}))).toBe(false)
  })

  it('名前はピリオド・大小文字のゆれを吸収する', () => {
    expect(matchesRule(rule({ name_keyword: 'tk' }), cand({ name: 'T.K' }))).toBe(true)
    expect(matchesRule(rule({ name_keyword: 'S.I' }), cand({ name: 'T.K' }))).toBe(false)
  })

  it('スキルは OR（いずれか1つ持っていればよい）', () => {
    expect(matchesRule(rule({ skill_keywords: ['java'] }), cand({}))).toBe(true)
    // 旧実装（AND）では false だったケース。持っていない Python が混ざっても Java で通る
    expect(matchesRule(rule({ skill_keywords: ['Java', 'Python'] }), cand({}))).toBe(true)
    // 1つも持っていなければ不一致
    expect(matchesRule(rule({ skill_keywords: ['Go', 'Python'] }), cand({}))).toBe(false)
  })

  it('AS/400 と AS400 と AS-400 は同じものとして扱う', () => {
    const as400 = cand({ skills: ['AS/400', 'RPG'] })
    expect(matchesRule(rule({ skill_keywords: ['AS400'] }), as400)).toBe(true)
    expect(matchesRule(rule({ skill_keywords: ['AS-400'] }), as400)).toBe(true)
    expect(matchesRule(rule({ skill_keywords: ['AS/400'] }), cand({ skills: ['AS400'] }))).toBe(true)
  })

  it('大阪の実ルールが実データで一致する（2026-08-17 の不具合の再現）', () => {
    const osakaRule = rule({
      station_keyword: '大阪府',
      skill_keywords: ['C#', 'Java', 'AS/400', 'AS400'],
    })
    // 大阪府在住・C# と Java は持つが AS400 は持たない（prod の実在パターン）
    const osakaCand = cand({ skills: ['C#', 'Java', 'SQL'], station: '新大阪駅 大阪府' })
    expect(matchesRule(osakaRule, osakaCand)).toBe(true)
    // 県が違えば一致しない
    expect(matchesRule(osakaRule, cand({ skills: ['C#'], station: '西船橋駅 千葉県' }))).toBe(false)
  })

  it('種類の違う条件どうしは AND のまま', () => {
    expect(matchesRule(rule({ name_keyword: 'T.K', skill_keywords: ['Java'] }), cand({}))).toBe(true)
    expect(matchesRule(rule({ name_keyword: 'T.K', skill_keywords: ['Go'] }), cand({}))).toBe(false)
    expect(matchesRule(rule({ station_keyword: '大阪', skill_keywords: ['Java'] }), cand({}))).toBe(false)
  })

  it('駅・都道府県は部分一致', () => {
    expect(matchesRule(rule({ station_keyword: '西船橋' }), cand({}))).toBe(true)
    expect(matchesRule(rule({ station_keyword: '千葉' }), cand({}))).toBe(true)
  })

  it('data_env が違えば一致しない', () => {
    expect(matchesRule(rule({ name_keyword: 'T.K', data_env: 'demo' }), cand({}))).toBe(false)
  })

  it('空白だけのスキルキーワードは条件として無視される', () => {
    expect(matchesRule(rule({ skill_keywords: ['  '] }), cand({}))).toBe(false)
  })
})

/** 通知メールに「なぜ通知されたか」を出すための、合致スキルの抽出。
 *
 *  2026-09-01、営業から「C#でもJavaでもない人に通知が飛んでいる」と指摘があった。
 *  実際には24個のスキルの23番目に Java があり判定は正しかったが、メールが
 *  スキルを先頭10件しか出していなかったため根拠が見えなかった。
 *  正しい通知を誤検知だと思わせるのは、通知そのものの信頼を損なう。
 */
describe('matchedSkills', () => {
  const r = rule({ skill_keywords: ['C#', 'Java', 'AS/400', 'AS400'] })

  it('合致したスキルだけを返す', () => {
    expect(matchedSkills(r, cand({ skills: ['Java', 'Spring Boot', 'AWS'] }))).toEqual(['Java'])
  })

  it('11番目以降にあっても拾う（今回の実害。Y.M は24個中23番目が Java だった）', () => {
    const many = [
      'ネットワーク設計', 'AWS', '社内SE', 'PMO', 'プロジェクトマネジメント',
      'Excel', '運用保守', 'データ分析', 'Access', 'VBA',
      '要件定義', 'PHP', '組み込み開発', 'ヘルプデスク', '監視',
      'CRM', '障害対応', 'テスト設計', 'UAT', '保守運用', 'Zoom',
      'Java', 'デジタルマーケティング',
    ]
    expect(matchedSkills(r, cand({ skills: many }))).toEqual(['Java'])
  })

  it('複数合致すればすべて返す', () => {
    expect(matchedSkills(r, cand({ skills: ['C#', 'Java', 'AWS'] }))).toEqual(['C#', 'Java'])
  })

  it('JavaScript は Java に合致しない（語境界の判定を matchesRule と共有している）', () => {
    expect(matchedSkills(r, cand({ skills: ['JavaScript', 'React'] }))).toEqual([])
  })

  it('別名は正規化して拾う（AS/400 ≡ AS400）', () => {
    expect(matchedSkills(r, cand({ skills: ['AS400'] }))).toEqual(['AS400'])
  })

  it('スキル条件が無いルールでは空（駅や氏名だけで合致した場合）', () => {
    expect(matchedSkills(rule({ station_keyword: '大阪' }), cand({}))).toEqual([])
  })
})
