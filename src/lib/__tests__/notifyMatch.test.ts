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
