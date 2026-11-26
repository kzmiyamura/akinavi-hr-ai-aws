/**
 * 配信サービスの「資料ダウンロード」直リンク（postory）の検出と、ファイル名の読み取り（2026-11-27）。
 *
 * Visionary AI の配信は経歴書を添付せず、本文末尾に postory の直リンクだけを置く。
 * 取り込みが拾えず経歴書なしで登録されていた（2026-11-26 に実例）。
 * 手写しのレプリカを作らず index.ts から切り出して検証する（ownDomainQuote.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

function constLine(name: string): string {
  const m = SRC.match(new RegExp(`^const ${name} = .*$`, 'm'))
  if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
  return m[0]
}
function fnBody(sig: RegExp, name: string): string {
  const m = SRC.match(sig)
  if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
  return m[1]
}

const detectDirectFileLinks = new Function(`
  ${constLine('NEVER_FOLLOW_RE')}
  ${constLine('DIRECT_FILE_LINK_RE')}
  return function (body, max = 3) {${fnBody(/function detectDirectFileLinks\(body: string, max = 3\): string\[\] \{([\s\S]*?)\n\}/, 'detectDirectFileLinks').replace(/: string\[\]/g, '')}\n}
`)() as (body: string, max?: number) => string[]

const filenameFromDisposition = new Function(`
  return function (res) {${fnBody(/function filenameFromDisposition\(res: Response\): string \| null \{([\s\S]*?)\n\}/, 'filenameFromDisposition').replace(/let name: string/, 'let name')}\n}
`)() as (res: { headers: { get(k: string): string | null } }) => string | null
const fakeRes = (cd: string) => ({ headers: { get: (k: string) => (k === 'content-disposition' ? cd : null) } })

const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const LINK = `https://postory.visionary-jp.com/api/materials/${HASH}`

describe('detectDirectFileLinks（postory の直リンク）', () => {
  it('Outlook のテキスト表示（<URL> 付き）から拾う', () => {
    const body = `資料ダウンロード\n\n*\t職務経歴書_AB_駅名.xlsx <${LINK}> \n\n配信停止はこちら <https://unsubscribe.resend.com/?token=eyJx>`
    expect(detectDirectFileLinks(body)).toEqual([LINK])
  })

  it('HTML の href から拾う', () => {
    const html = `<p>資料ダウンロード</p><ul><li><a href="${LINK}">職務経歴書_AB.xlsx</a></li></ul>`
    expect(detectDirectFileLinks(html)).toEqual([LINK])
  })

  it('配信停止リンクは拾わない', () => {
    expect(detectDirectFileLinks('配信停止 https://unsubscribe.resend.com/?token=abc https://postory.visionary-jp.com/unsubscribe/abc')).toEqual([])
  })

  it('materials 以外の postory の URL は拾わない', () => {
    expect(detectDirectFileLinks('https://postory.visionary-jp.com/api/contacts/' + HASH)).toEqual([])
  })

  it('同じリンクは1回だけ・上限を守る', () => {
    const l = (h: string) => `https://postory.visionary-jp.com/api/materials/${h.repeat(64)}`
    const body = [LINK, LINK, l('a'), l('b'), l('c')].join('\n')
    expect(detectDirectFileLinks(body)).toEqual([LINK, l('a'), l('b')])
    expect(detectDirectFileLinks(body, 1)).toEqual([LINK])
  })

  it('ハッシュの後ろに英数字が続く形（別の語にくっついた URL）は拾わない', () => {
    expect(detectDirectFileLinks(`${LINK}zz`)).toEqual([])
  })
})

describe('filenameFromDisposition', () => {
  it('filename と filename* が両方あれば filename* を使う（postory の実物の形）', () => {
    const cd = `attachment; filename="download"; filename*=UTF-8''%E8%81%B7%E5%8B%99%E7%B5%8C%E6%AD%B4%E6%9B%B8_AB.xlsx`
    expect(filenameFromDisposition(fakeRes(cd))).toBe('職務経歴書_AB.xlsx')
  })

  it('filename だけならそれを使う', () => {
    expect(filenameFromDisposition(fakeRes('attachment; filename="resume.xlsx"'))).toBe('resume.xlsx')
  })

  it('ヘッダが無ければ null', () => {
    expect(filenameFromDisposition(fakeRes(''))).toBeNull()
  })
})
