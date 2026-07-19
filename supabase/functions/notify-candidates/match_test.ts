// deno test supabase/functions/notify-candidates/match_test.ts
import { matchesRule, ruleHasCondition, type CandidateLite, type NotifyRule } from './match.ts'

const rule = (over: Partial<NotifyRule>): NotifyRule => ({
  id: 'r1', label: '', name_keyword: '', skill_keywords: [], station_keyword: '',
  notify_email: 'a@example.com', enabled: true, data_env: 'prod', ...over,
})
const cand = (over: Partial<CandidateLite>): CandidateLite => ({
  id: 'c1', name: 'T.K', skills: ['Java', 'Spring Boot', 'AWS'], station: '西船橋駅 千葉県', data_env: 'prod', ...over,
})

const assert = (label: string, v: boolean) => {
  if (!v) throw new Error(`FAIL: ${label}`)
  console.log(`  ✅ ${label}`)
}

Deno.test('matchesRule', () => {
  assert('条件なしルールは何にもマッチしない（暴発防止）', !matchesRule(rule({}), cand({})))
  assert('ruleHasCondition: 空ルールはfalse', !ruleHasCondition(rule({})))
  assert('名前一致（イニシャルのピリオド・大小文字ゆれ吸収）',
    matchesRule(rule({ name_keyword: 'tk' }), cand({ name: 'T.K' })))
  assert('名前不一致', !matchesRule(rule({ name_keyword: 'S.I' }), cand({ name: 'T.K' })))
  assert('スキル1件一致（部分一致・大小文字無視）',
    matchesRule(rule({ skill_keywords: ['java'] }), cand({})))
  assert('スキル複数はAND（全部含めばマッチ）',
    matchesRule(rule({ skill_keywords: ['Java', 'AWS'] }), cand({})))
  assert('スキルANDで1つ欠けたら不一致',
    !matchesRule(rule({ skill_keywords: ['Java', 'Python'] }), cand({})))
  assert('駅の部分一致', matchesRule(rule({ station_keyword: '西船橋' }), cand({})))
  assert('都道府県でも一致', matchesRule(rule({ station_keyword: '千葉' }), cand({})))
  assert('複合条件はAND（名前+スキル両方満たす）',
    matchesRule(rule({ name_keyword: 'T.K', skill_keywords: ['Java'] }), cand({})))
  assert('複合条件で片方欠けたら不一致',
    !matchesRule(rule({ name_keyword: 'T.K', skill_keywords: ['Go'] }), cand({})))
  assert('data_env が違えば不一致',
    !matchesRule(rule({ name_keyword: 'T.K', data_env: 'demo' }), cand({})))
  assert('空白だけのスキルキーワードは無視される',
    !matchesRule(rule({ skill_keywords: ['  '] }), cand({})))
})
