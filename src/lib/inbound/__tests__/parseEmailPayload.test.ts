import { describe, it, expect } from 'vitest'
import {
  extractEmailBody,
  parseAIResponse,
  extractEmailFromFrom,
  buildCandidatePayload,
} from '../parseEmailPayload'

// ─── extractEmailBody ──────────────────────────────────────

describe('extractEmailBody', () => {
  it('text フィールドがある場合、body として返す', () => {
    const result = extractEmailBody({
      from: 'yamada@example.com',
      subject: '経歴書送付',
      text: '山田太郎です。Java 5年の経験があります。',
    })
    expect(result?.body).toBe('山田太郎です。Java 5年の経験があります。')
    expect(result?.from).toBe('yamada@example.com')
  })

  it('text がなく html がある場合、html を body として返す', () => {
    const result = extractEmailBody({
      from: 'test@example.com',
      subject: 'test',
      html: '<p>HTML本文</p>',
    })
    expect(result?.body).toBe('<p>HTML本文</p>')
  })

  it('text も html もない場合、null を返す', () => {
    const result = extractEmailBody({ from: 'a@b.com', subject: 'test' })
    expect(result).toBeNull()
  })

  it('body が空文字だけの場合、null を返す', () => {
    const result = extractEmailBody({ from: 'a@b.com', subject: 'test', text: '   ' })
    expect(result).toBeNull()
  })

  it('text が html より優先される', () => {
    const result = extractEmailBody({
      from: 'a@b.com',
      subject: 'test',
      text: 'プレーンテキスト',
      html: '<p>HTML</p>',
    })
    expect(result?.body).toBe('プレーンテキスト')
  })
})

// ─── parseAIResponse ───────────────────────────────────────

describe('parseAIResponse', () => {
  it('正常な JSON 文字列をパースする', () => {
    const json = JSON.stringify({
      name: '山田 太郎', email: 'yamada@example.com',
      phone: null, skills: ['Java', 'AWS'], experienceYears: 5, summary: 'バックエンドエンジニア',
    })
    const result = parseAIResponse(json)
    expect(result.name).toBe('山田 太郎')
    expect(result.skills).toContain('Java')
  })

  it('コードブロック付きレスポンスをパースする', () => {
    const raw = '```json\n{"name":"佐藤 花子","email":null,"phone":null,"skills":["React"],"experienceYears":3,"summary":"FE"}\n```'
    const result = parseAIResponse(raw)
    expect(result.name).toBe('佐藤 花子')
    expect(result.skills).toContain('React')
  })

  it('前後の空白を無視してパースする', () => {
    const raw = '  {"name":"鈴木","email":null,"phone":null,"skills":[],"experienceYears":null,"summary":""}  '
    const result = parseAIResponse(raw)
    expect(result.name).toBe('鈴木')
  })

  it('不正な JSON の場合は例外をスローする', () => {
    expect(() => parseAIResponse('not json')).toThrow()
  })
})

// ─── extractEmailFromFrom ──────────────────────────────────

describe('extractEmailFromFrom', () => {
  it('"名前 <email>" 形式からメールアドレスを抽出する', () => {
    expect(extractEmailFromFrom('山田 太郎 <yamada@example.com>')).toBe('yamada@example.com')
  })

  it('メールアドレスのみの場合もそのまま返す', () => {
    expect(extractEmailFromFrom('yamada@example.com')).toBe('yamada@example.com')
  })

  it('メールアドレスがない場合は null を返す', () => {
    expect(extractEmailFromFrom('山田太郎')).toBeNull()
  })

  it('サブドメイン付きメールアドレスを正しく抽出する', () => {
    expect(extractEmailFromFrom('Test User <test@mail.example.co.jp>')).toBe('test@mail.example.co.jp')
  })
})

// ─── buildCandidatePayload ─────────────────────────────────

describe('buildCandidatePayload', () => {
  const analyzed = {
    name: '山田 太郎',
    email: 'yamada@example.com',
    phone: '090-1234-5678',
    skills: ['Java', 'AWS'],
    experienceYears: 5,
    summary: 'バックエンドエンジニア',
  }
  const parsed = {
    from: '山田 太郎 <yamada@example.com>',
    subject: '経歴書送付',
    body: '山田太郎です。Java 5年の経験があります。',
  }

  it('正常なペイロードを構築する', () => {
    const payload = buildCandidatePayload(analyzed, parsed)
    expect(payload.name).toBe('山田 太郎')
    expect(payload.email).toBe('yamada@example.com')
    expect(payload.skills).toContain('Java')
    expect(payload.experience_years).toBe(5)
    expect(payload.created_by).toBe('resend-inbound')
    expect(payload.duplicate_flag).toBe(false)
  })

  it('AI が email を抽出できなかった場合、from フィールドから補完する', () => {
    const noEmail = { ...analyzed, email: null }
    const payload = buildCandidatePayload(noEmail, parsed)
    expect(payload.email).toBe('yamada@example.com') // from から抽出
  })

  it('raw_profile に from・subject・body が含まれる', () => {
    const payload = buildCandidatePayload(analyzed, parsed)
    expect(payload.raw_profile.from).toBe(parsed.from)
    expect(payload.raw_profile.subject).toBe(parsed.subject)
    expect(payload.raw_profile.text).toBe(parsed.body)
  })

  it('body が 5000 文字を超える場合はトリムされる', () => {
    const longBody = { ...parsed, body: 'a'.repeat(6000) }
    const payload = buildCandidatePayload(analyzed, longBody)
    expect((payload.raw_profile.text as string).length).toBe(5000)
  })

  it('created_by を指定できる', () => {
    const payload = buildCandidatePayload(analyzed, parsed, 'custom-source')
    expect(payload.created_by).toBe('custom-source')
  })

  it('phone が null の場合も正しく扱う', () => {
    const noPhone = { ...analyzed, phone: null }
    const payload = buildCandidatePayload(noPhone, parsed)
    expect(payload.phone).toBeNull()
  })
})
