import { describe, it, expect } from 'vitest'
import { formatCandidateNo, parseCandidateCode } from '../candidateCode'

/**
 * 人材番号の表示と入力解釈。
 *
 * ⚠ ここの規則は **DB 側（filter_candidates / count_filter_candidates の p_name 分岐）と
 *   同じでなければならない**。片方だけ直すと「画面は番号検索のつもり・DB は氏名の
 *   部分一致」になり、0件の意味が分からなくなる。
 *   DB 側の正規表現: ^\s*([Aa][Kk])?\s*[-]?\s*[0-9]+\s*$（全角は translate で半角化）
 */
describe('formatCandidateNo', () => {
  it('6桁ゼロ埋めで AK- を付ける', () => {
    expect(formatCandidateNo(1)).toBe('AK-000001')
    expect(formatCandidateNo(123)).toBe('AK-000123')
    expect(formatCandidateNo(999999)).toBe('AK-999999')
  })

  it('6桁を超えても壊れない（桁が増えるだけ）', () => {
    expect(formatCandidateNo(1234567)).toBe('AK-1234567')
  })

  it('番号が無い行（マイグレーション適用前）は null', () => {
    expect(formatCandidateNo(null)).toBeNull()
    expect(formatCandidateNo(undefined)).toBeNull()
  })
})

describe('parseCandidateCode', () => {
  it('番号として受ける形', () => {
    expect(parseCandidateCode('123')).toBe(123)
    expect(parseCandidateCode('AK-123')).toBe(123)
    expect(parseCandidateCode('ak-000123')).toBe(123)
    expect(parseCandidateCode('AK 123')).toBe(123)
    expect(parseCandidateCode('  AK-000123  ')).toBe(123)
    expect(parseCandidateCode('AK123')).toBe(123)
  })

  it('全角で貼られても受ける（メモからの貼り付け）', () => {
    expect(parseCandidateCode('１２３')).toBe(123)
    expect(parseCandidateCode('AK－０００１２３')).toBe(123)
  })

  it('氏名は番号として扱わない', () => {
    expect(parseCandidateCode('田中')).toBeNull()
    expect(parseCandidateCode('T.I')).toBeNull()
    expect(parseCandidateCode('AK')).toBeNull()
    expect(parseCandidateCode('')).toBeNull()
    expect(parseCandidateCode(null)).toBeNull()
  })

  it('数字を含む氏名を番号と誤認しない', () => {
    // イニシャル氏名に数字が混ざる行が実在する（「TY2」のような付番）
    expect(parseCandidateCode('TY2')).toBeNull()
    expect(parseCandidateCode('田中3')).toBeNull()
    expect(parseCandidateCode('123A')).toBeNull()
  })

  it('0 と負値は番号にしない（連番は1から振る）', () => {
    expect(parseCandidateCode('0')).toBeNull()
    expect(parseCandidateCode('-5')).toBe(5)   // 「AK-5」の AK 落ちとみなす
  })
})
