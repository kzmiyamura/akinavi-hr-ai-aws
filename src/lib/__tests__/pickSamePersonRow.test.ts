/**
 * 重複判定「同名の既存行から本人の行を選ぶ」のテスト（`inbound-email` の `pickSamePersonRow`）。
 *
 * ここを間違えると営業の画面が壊れる。しかも**両方向に**壊れる:
 *   選び過ぎ → 同姓同名の別人が1行に潰れて**人が消える**
 *              （2026-08-16 フォスターネット: 18名のうち K.H×2・S.Y×2 が潰れて16件）
 *   選び足らず → 同じ人が毎日増える
 *              （2026-10-04 控え実測: JapanTechnology の `TY` が9日で9行・24組で余分54行）
 *
 * 正は `supabase/functions/inbound-email/index.ts`。ここで読むのは
 * `node scripts/sync_extractors.mjs` が生成した複製なので、index.ts を直したら再生成する。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error 型定義のない生成物（実行は vitest のみ）
import { pickSamePersonRow } from '../../../scripts/_extractors.gen.mjs'

const row = (o: Record<string, unknown>) => ({ id: 'x', ...o })

describe('attrs モード（同じ送信元からの再送）', () => {
  it('件名が同じなら同一メール＝本人', () => {
    const hit = pickSamePersonRow([row({ id: 'a', subject: '【要員】ご紹介' })],
      { subject: '【要員】ご紹介' }, { mode: 'attrs' })
    expect(hit?.id).toBe('a')
  })

  it('件名が違っても駅と経験年数が合えば本人（2項目一致）', () => {
    const hit = pickSamePersonRow([row({ id: 'b', subject: '別件名', nearestStation: '板橋駅', experience_years: 19 })],
      { subject: '今回の件名', station: '板橋駅', experienceYears: 19 }, { mode: 'attrs' })
    expect(hit?.id).toBe('b')
  })

  it('1項目しか合わなければ選ばない（別人を潰さない）', () => {
    const hit = pickSamePersonRow([row({ id: 'c', subject: '別件名', prefecture: '東京都' })],
      { subject: '今回の件名', prefecture: '東京都' }, { mode: 'attrs' })
    expect(hit).toBeNull()
  })

  it('同一メール内に同名の別人がいるときは件名一致を根拠にしない', () => {
    // ここが 2026-10-04 の修正点。件名一致は「同じメール」でしかなく本人の証拠ではない
    const rows = [row({ id: 'd', subject: '【要員】ご紹介' })]
    expect(pickSamePersonRow(rows, { subject: '【要員】ご紹介' }, { mode: 'attrs' })?.id).toBe('d')
    expect(pickSamePersonRow(rows, { subject: '【要員】ご紹介' },
      { mode: 'attrs', allowSameSubject: false })).toBeNull()
  })

  it('既に使った行は選ばない（1行を2人に割り当てない）', () => {
    const rows = [row({ id: 'e', subject: '同じ件名' })]
    expect(pickSamePersonRow(rows, { subject: '同じ件名' },
      { mode: 'attrs', usedIds: new Set(['e']) })).toBeNull()
  })

  it('片方が未取得の項目は一致にも不一致にも数えない', () => {
    const hit = pickSamePersonRow([row({ id: 'f', nearestStation: null, prefecture: '大阪府', experience_years: 9 })],
      { station: '新大阪駅', prefecture: '大阪府', experienceYears: 9 }, { mode: 'attrs' })
    expect(hit?.id).toBe('f')   // 県＋経験年数の2項目で一致
  })
})

describe('jaccard モード（スキルの重なりで判定）', () => {
  const skills = ['java', 'spring', 'oracle', 'linux']

  it('重なりがしきい値以上なら本人', () => {
    const hit = pickSamePersonRow([row({ id: 'g', skills: ['Java', 'Spring', 'Oracle', 'Linux'] })],
      { skills }, { mode: 'jaccard' })
    expect(hit?.id).toBe('g')
  })

  it('重なりが足りなければ選ばない', () => {
    const hit = pickSamePersonRow([row({ id: 'h', skills: ['COBOL', 'JCL', 'VSAM', 'PL/I'] })],
      { skills }, { mode: 'jaccard' })
    expect(hit).toBeNull()
  })

  it('駅が両方あって違えば別人', () => {
    const hit = pickSamePersonRow([row({ id: 'i', nearestStation: 'JR南草津駅', skills })],
      { station: '八尾駅', skills }, { mode: 'jaccard' })
    expect(hit).toBeNull()
  })

  it('県が両方あって違えば別人（滋賀の TY と 大阪の TY）', () => {
    const hit = pickSamePersonRow([row({ id: 'j', prefecture: '滋賀県', skills })],
      { prefecture: '大阪府', skills }, { mode: 'jaccard' })
    expect(hit).toBeNull()
  })

  it('経験年数が5年以上離れていれば別人', () => {
    const hit = pickSamePersonRow([row({ id: 'k', experience_years: 3, skills })],
      { experienceYears: 20, skills }, { mode: 'jaccard' })
    expect(hit).toBeNull()
  })

  it('**最も重なる行**を選ぶ（先に見つかった行で確定しない）', () => {
    const rows = [
      row({ id: 'low', skills: ['Java', 'Spring', 'PHP', 'Perl', 'Ruby'] }),
      row({ id: 'high', skills: ['Java', 'Spring', 'Oracle', 'Linux'] }),
    ]
    expect(pickSamePersonRow(rows, { skills }, { mode: 'jaccard' })?.id).toBe('high')
  })

  it('RPC のスネークケース（nearest_station）でも判定できる', () => {
    const hit = pickSamePersonRow([row({ id: 'm', nearest_station: '板橋駅', skills })],
      { station: '板橋駅', skills }, { mode: 'jaccard' })
    expect(hit?.id).toBe('m')
  })

  it('スキルが片方でも空なら選ばない（union 0 は判定不能）', () => {
    expect(pickSamePersonRow([row({ id: 'n', skills: [] })], { skills }, { mode: 'jaccard' })).toBeNull()
    expect(pickSamePersonRow([row({ id: 'o', skills: ['Java'] })], { skills: [] }, { mode: 'jaccard' })).toBeNull()
  })

  it('既に使った行は選ばない', () => {
    const rows = [row({ id: 'p', skills: ['Java', 'Spring', 'Oracle', 'Linux'] })]
    expect(pickSamePersonRow(rows, { skills }, { mode: 'jaccard', usedIds: new Set(['p']) })).toBeNull()
  })
})

describe('実際に起きていた形', () => {
  it('名簿に同名2人：2人目は1人目の行を掴まず、自分の過去行を選ぶ', () => {
    // JapanTechnology の日次名簿: JR南草津駅の TY と 大阪府八尾市の TY が同じメールに並ぶ
    const dbRows = [
      row({ id: 'shiga', prefecture: '滋賀県', nearestStation: 'JR南草津駅', skills: ['Java', 'AWS', 'Linux'] }),
      row({ id: 'osaka', prefecture: '大阪府', skills: ['Python', 'Solidity', 'React', 'AWS'] }),
    ]
    // 1人目（滋賀）は滋賀の行に当たる
    const first = pickSamePersonRow(dbRows, {
      prefecture: '滋賀県', station: 'JR南草津駅', skills: ['Java', 'AWS', 'Linux'],
    }, { mode: 'jaccard' })
    expect(first?.id).toBe('shiga')
    // 2人目（大阪）は、1人目が使った行を除いたうえで大阪の行に当たる
    const second = pickSamePersonRow(dbRows, {
      prefecture: '大阪府', skills: ['Python', 'Solidity', 'React', 'AWS'],
    }, { mode: 'jaccard', usedIds: new Set(['shiga']) })
    expect(second?.id).toBe('osaka')
  })

  it('同名2人で過去行が1つしかなければ、2人目は新規登録になる', () => {
    const dbRows = [row({ id: 'only', prefecture: '滋賀県', skills: ['Java', 'AWS', 'Linux'] })]
    const second = pickSamePersonRow(dbRows, {
      prefecture: '大阪府', skills: ['Python', 'Solidity', 'React'],
    }, { mode: 'jaccard', usedIds: new Set(['only']) })
    expect(second).toBeNull()
  })
})
