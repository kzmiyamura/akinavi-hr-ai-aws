// deno test supabase/functions/notify-candidates/match_test.ts
import { matchesRule, ruleHasCondition, flowBucket, type CandidateLite, type NotifyRule } from './match.ts'

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

// ── 雇用形態・商流（2026-10-12。営業の要望「自社正社員とか選択形式に」）──────────
//   「自社正社員」は1つの値ではなく 商流=自社 × 雇用形態=正社員（prod 352人）。
//   取得率は雇用形態82.6% / 商流85.0% なので、未取得の扱いが肝心。
Deno.test('flowBucket', () => {
  assert('自社', flowBucket('自社') === '自社')
  assert('1社先', flowBucket('1社先') === '1社先')
  assert('2社先は「2社先以降」に丸める', flowBucket('2社先') === '2社先以降')
  assert('3社先も同じ', flowBucket('3社先') === '2社先以降')
  assert('想定外の表記も「2社先以降」に落とす（捨てない）', flowBucket('協力会社') === '2社先以降')
  assert('未取得は null', flowBucket(null) === null)
  assert('空白だけも未取得扱い', flowBucket('  ') === null)
})

Deno.test('matchesRule: 雇用形態・商流', () => {
  const proper = cand({ employmentType: '正社員', commercialFlow: '自社' })
  const freelance1 = cand({ employmentType: 'フリーランス', commercialFlow: '1社先' })
  const unknown = cand({ employmentType: null, commercialFlow: null })

  assert('雇用形態だけでも条件として成立する（ruleHasCondition）',
    ruleHasCondition(rule({ employment_types: ['正社員'] })))
  assert('商流だけでも条件として成立する',
    ruleHasCondition(rule({ commercial_flows: ['自社'] })))
  assert('空配列は条件なし（暴発防止）',
    !ruleHasCondition(rule({ employment_types: [], commercial_flows: [] })))
  assert('空白だけの選択は無視される',
    !ruleHasCondition(rule({ employment_types: ['  '] })))

  assert('正社員を選ぶと正社員が通る',
    matchesRule(rule({ employment_types: ['正社員'] }), proper))
  assert('正社員を選ぶとフリーランスは通らない',
    !matchesRule(rule({ employment_types: ['正社員'] }), freelance1))
  assert('雇用形態の複数選択は OR',
    matchesRule(rule({ employment_types: ['正社員', 'フリーランス'] }), freelance1))

  assert('自社を選ぶと自社が通る',
    matchesRule(rule({ commercial_flows: ['自社'] }), proper))
  assert('自社を選ぶと1社先は通らない',
    !matchesRule(rule({ commercial_flows: ['自社'] }), freelance1))
  assert('商流の複数選択は OR',
    matchesRule(rule({ commercial_flows: ['自社', '1社先'] }), freelance1))

  // 「自社正社員」
  const ownEmployee = rule({ commercial_flows: ['自社'], employment_types: ['正社員'] })
  assert('自社×正社員 は通る', matchesRule(ownEmployee, proper))
  assert('自社×フリーランス は通らない（軸どうしは AND）',
    !matchesRule(ownEmployee, cand({ employmentType: 'フリーランス', commercialFlow: '自社' })))
  assert('1社先×正社員 は通らない',
    !matchesRule(ownEmployee, cand({ employmentType: '正社員', commercialFlow: '1社先' })))

  // 取れていない人の扱い。既定（include_unknown 未指定＝true）では通す。
  // ここを落とすと、条件を1つ足すだけで2割近く取りこぼす
  assert('既定では雇用形態が未取得の人も通す',
    matchesRule(rule({ employment_types: ['正社員'] }), unknown))
  assert('既定では商流が未取得の人も通す',
    matchesRule(rule({ commercial_flows: ['自社'] }), unknown))
  assert('include_unknown=false なら未取得の人は落とす',
    !matchesRule(rule({ employment_types: ['正社員'], include_unknown: false }), unknown))
  assert('include_unknown=false でも値が取れていて一致すれば通る',
    matchesRule(rule({ employment_types: ['正社員'], include_unknown: false }), proper))
  assert('2社先以降を選ぶと 2社先の人が通る',
    matchesRule(rule({ commercial_flows: ['2社先以降'] }),
      cand({ commercialFlow: '2社先' })))
  assert('2社先以降を選ぶと自社の人は通らない',
    !matchesRule(rule({ commercial_flows: ['2社先以降'] }), proper))

  // 他の条件と組み合わせても壊れない
  assert('スキル+自社正社員 の複合',
    matchesRule(rule({ skill_keywords: ['Java'], commercial_flows: ['自社'], employment_types: ['正社員'] }),
      proper))
  assert('スキルが外れれば雇用形態が合っていても通らない',
    !matchesRule(rule({ skill_keywords: ['Go'], commercial_flows: ['自社'], employment_types: ['正社員'] }),
      proper))
})
