/**
 * 「本文に人の履歴が書かれているか」の門番。
 *
 * poll-email の `hasCandidateProfileBody` と inbound-email の `bodyHasCandidateProfile` は
 * **同じ判定でなければならない**。片方だけ通ると、poll-email が人材として渡したメールを
 * inbound-email が営業メールとして捨て、段で落ちる（＝直した気になって直っていない）。
 *
 * 背景（2026-09-19 実測・ローカル控え5日分 × 本番の登録実数）:
 * 1人も登録できていない送信元69社から、人の履歴が書かれたメールが1,536通出ていた。
 * 撃っていたのは中身ではなく挨拶と署名:
 *   「ご提案いただけますと」140通 /「ご紹介いただけますと」124通（案件と誤判定）
 *   本文に sales@ のアドレスがあるだけで 228通 /「配信停止はこちら」167通（スキップ）
 *   「支払いサイト」331通中259通（inbound-email の商用勧誘判定）
 * 語を消すと本物の営業メールが通るので、**人が書かれていれば営業判定に掛けない**
 * という順序に変えた。この門番がその条件。
 *
 * レプリカは作らず、本番に出す index.ts から関数を切り出して検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const POLL = resolve(__dirname, '../../../supabase/functions/poll-email/index.ts')
const INBOUND = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function cut(file: string, name: string): (s: string) => boolean {
  const src = readFileSync(file, 'utf8')
  const m = src.match(new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`))
  if (!m) throw new Error(`${name} を ${file} から取り出せませんでした`)
  const js = `function ${name}(${m[1]}\n}\nreturn ${name}`
    .replace(/:\s*string/g, '').replace(/:\s*boolean/g, '')
  return new Function(js)() as (s: string) => boolean
}

const pollGate = cut(POLL, 'hasCandidateProfileBody')
const inboundGate = cut(INBOUND, 'bodyHasCandidateProfile')

/** 実際に捨てられていたメール（D:\akinavi-archive\mail の原文から要約） */
const REAL_CANDIDATE_MAILS = [
  // y.sasaki@free-brain.co.jp・209通すべて COMMERCIAL_SOLICITATION で消えていた
  `現在営業中の技術者情報をお送りいたします。
【要員番号】13612
【氏名】K.R
【年齢】61歳
【最寄駅】谷在家
【単価】100万円`,
  // 【名　前】の全角スペース書式
  `【名　前】：GO　30歳　男性
【最寄駅】：大宮`,
  // コロン書式（従来から通っていた形。壊していないことの確認）
  `氏名：I.T
最寄駅：中野駅
単価：65万`,
  // 年齢が「36歳」だけで、ラベルは【氏名】
  `≪N.M≫
【氏名】N.M
36歳 男性
最寄駅 盛岡駅`,
]

const REAL_PROJECT_MAILS = [
  // 募集条件。年齢は「〜49歳まで」で人の年齢ではない
  `【案件名】機械学習エンジニア
【年齢】26〜49歳まで
【単価】100万〜130万
【支払いサイト】基本45日サイト`,
  // 氏名の見出しが無い案件メール
  `必須スキル：Java、Spring Boot
就業場所：東京都港区
募集人数：2名
単価：70万`,
  // 営業メール（人の属性が無い）
  `弊社サービスのご紹介です。
配信停止はこちら https://example.com/unsub`,
]

describe('本文に人の履歴があるかの門番', () => {
  it('poll-email と inbound-email で判定が一致する（段で落とさないため）', () => {
    for (const body of [...REAL_CANDIDATE_MAILS, ...REAL_PROJECT_MAILS]) {
      expect(inboundGate(body), body.slice(0, 30)).toBe(pollGate(body))
    }
  })

  it('実際に捨てられていた人材メールを人材と判定する', () => {
    for (const body of REAL_CANDIDATE_MAILS) {
      expect(pollGate(body), body.slice(0, 30)).toBe(true)
    }
  })

  it('案件メール・営業メールは人材と判定しない', () => {
    for (const body of REAL_PROJECT_MAILS) {
      expect(pollGate(body), body.slice(0, 30)).toBe(false)
    }
  })

  it('募集年齢しか無いものは人の属性とみなさない', () => {
    // 「45歳まで」は案件の条件。これを人の年齢と読むと案件メールが人材として入る
    expect(pollGate('【氏名】募集\n45歳まで')).toBe(false)
    expect(pollGate('氏名：\n23歳以上の方')).toBe(false)
  })

  it('氏名の見出しだけ・属性だけでは人材と判定しない', () => {
    expect(pollGate('【氏名】K.R')).toBe(false)          // 属性が無い
    expect(pollGate('61歳 男性 最寄駅：谷在家')).toBe(false) // 氏名の見出しが無い
  })

  it('空・短文で落ちない', () => {
    for (const s of ['', '　', 'お世話になっております。']) {
      expect(pollGate(s)).toBe(false)
      expect(inboundGate(s)).toBe(false)
    }
  })
})
