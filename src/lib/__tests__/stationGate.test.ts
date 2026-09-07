/**
 * 最寄駅の妥当性判定（inbound-email の isPlausibleStation）の回帰テスト。
 *
 * prod 実測（2026-09-07）で最寄駅を持つ3,259人のうち86人（2.6%）が駅でない値だった。
 * Excelの見出し（最終学歴7件・氏6件・専攻学科2件）、性別欄（男・男性）、数値セル等。
 *
 * レプリカは作らず、**本番に出す index.ts から関数を切り出して**検証する
 * （companyNameGate.test.ts と同じ方式）。station_master は差し替え可能な小さな
 * ダミーを注入するので、駅データの実体には依存しない。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadGate(): (name: string | null | undefined) => boolean {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name: string) => {
    const m = src.match(new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return `function ${name}(${m[1]}\n}`
  }
  const code = `
    const STATION_MASTER_MAP = {
      '国分寺': [{}], '大江戸': [{}], '阿佐ケ谷': [{}], '犬山': [{}], '本厚木': [{}],
    };
    ${pick('stationNameCandidates').replace(/: string(\[\])?/g, '')}
    ${pick('isPlausibleStation').replace(/: string \| null \| undefined/g, '').replace(/: boolean/g, '')}
    return isPlausibleStation
  `
  return new Function(code)() as (name: string | null | undefined) => boolean
}

const ok = loadGate()

describe('isPlausibleStation', () => {
  it('Excelの見出しを駅として採らない（実データ由来）', () => {
    for (const ng of ['最終学歴', '氏', '専攻学科', '誕生日', '生年月日', '路線名',
                      '取得日', '交通手段及び所要時間', '出張可否', '参画可能日', '西暦']) {
      expect(ok(ng), ng).toBe(false)
    }
  })

  it('性別欄・数値セルを駅として採らない', () => {
    for (const ng of ['男', '男性', '女性', '28', '3']) {
      expect(ok(ng), ng).toBe(false)
    }
  })

  it('駅でない地名を採らない（都道府県として拾い直す側の入力）', () => {
    for (const ng of ['大阪府八尾市', '北津軽郡', '埼玉県在住', '沖縄', '海外']) {
      expect(ok(ng), ng).toBe(false)
    }
  })

  it('「〇〇駅」と書いてあれば一覧に無くても通す（新駅・表記ゆれの取りこぼし防止）', () => {
    expect(ok('たまプラーザ駅')).toBe(true)
    expect(ok('まだ無い新駅')).toBe(true)
  })

  it('一覧にある駅名は「駅」が無くても通る', () => {
    expect(ok('国分寺')).toBe(true)
    expect(ok('阿佐ヶ谷')).toBe(true)   // ヶ→ケ の表記ゆれ
  })

  it('運営者名が直結していても通る', () => {
    expect(ok('JR国分寺')).toBe(true)
    expect(ok('都営大江戸')).toBe(true)
  })

  it('路線名直結・空白区切りも通る（既存の候補生成を使っている）', () => {
    expect(ok('小田急小田原線本厚木')).toBe(true)
    expect(ok('名鉄 犬山駅')).toBe(true)
  })

  it('空・null は false', () => {
    expect(ok('')).toBe(false)
    expect(ok(null)).toBe(false)
    expect(ok(undefined)).toBe(false)
  })
})
