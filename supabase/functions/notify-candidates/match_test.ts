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
  assert('スキル1件一致（大小文字無視）',
    matchesRule(rule({ skill_keywords: ['java'] }), cand({})))
  // 2026-08-21: 部分一致をやめた。CLAUDE.md §6「部分一致は使わない」が通知だけ未適用で、
  // 大阪ルールの `Java` が `JavaScript` を拾っていた（62人中48人が通知対象・うち14人は誤通知）
  assert('Java は JavaScript に一致しない',
    !matchesRule(rule({ skill_keywords: ['Java'] }), cand({ skills: ['JavaScript'] })))
  assert('JavaScript しか無くても他のキーワードで拾えるなら通知する',
    matchesRule(rule({ skill_keywords: ['Java', 'C#'] }), cand({ skills: ['JavaScript', 'C#'] })))
  assert('Go は MongoDB / Django に一致しない',
    !matchesRule(rule({ skill_keywords: ['Go'] }), cand({ skills: ['MongoDB', 'Django'] })))
  assert('Shell は PowerShell に一致しない',
    !matchesRule(rule({ skill_keywords: ['Shell'] }), cand({ skills: ['PowerShell'] })))
  assert('SQL は PL/SQL・MySQL に一致しない',
    !matchesRule(rule({ skill_keywords: ['SQL'] }), cand({ skills: ['MySQL'] })))
  assert('C# は C#.NET に一致する（区切り文字の手前までが語）',
    matchesRule(rule({ skill_keywords: ['C#'] }), cand({ skills: ['C#.NET'] })))
  assert('Java は Java8 には一致しない（別表記は skill_master 側で吸収する）',
    !matchesRule(rule({ skill_keywords: ['Java'] }), cand({ skills: ['Java8'] })))
  assert('スキル複数はOR（1つでも持っていればマッチ・2026-08-17 に AND から変更）',
    matchesRule(rule({ skill_keywords: ['Java', 'Python'] }), cand({})))
  assert('スキルORで1つも持っていなければ不一致',
    !matchesRule(rule({ skill_keywords: ['Go', 'Python'] }), cand({})))
  assert('AS/400 と AS400 は同じものとして扱う',
    matchesRule(rule({ skill_keywords: ['AS400'] }), cand({ skills: ['AS/400'] })))
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
