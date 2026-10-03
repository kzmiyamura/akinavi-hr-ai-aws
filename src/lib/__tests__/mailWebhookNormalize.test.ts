/** 受信メール Webhook の正規化（inbound-mail-webhook/normalize.ts）の回帰テスト。
 *
 *  本体は Edge Function 側の純関数だが、**このマシンに deno が入っていない**ため
 *  vitest から直接 import して検証する（notifyMatch.test.ts と同じやり方）。
 *
 *  ここで守りたいのは2つ:
 *   1. 転送メールから**原メールの差出人**を復元できること
 *      （外すと inbound-email が OWN_DOMAIN で静かに全件捨てる）
 *   2. 転送ヘッダより**下**にある本文を失わないこと
 *      （inbound-email の STRONG_QUOTE_DELIMITERS は区切り線より上を残すため）
 */
import { describe, it, expect } from 'vitest'
import {
  extractAddress,
  unwrapForwarded,
  detectProvider,
  normalizeAttachments,
  normalizeWebhookPayload,
  toInboundEmailFields,
  detectSilentDropRisk,
} from '../../../supabase/functions/inbound-mail-webhook/normalize.ts'

describe('extractAddress', () => {
  it('素のアドレスをそのまま返す', () => {
    expect(extractAddress('yamada@agency.co.jp')).toBe('yamada@agency.co.jp')
  })

  it('RFC822 の表示名付きからアドレスだけを取る', () => {
    // ⚠ inbound-email の parseFrom はこれを剥がせず、split('@')[1] が
    //    'agency.co.jp>' になる（末尾に > が残る）。ここで必ず剥がす。
    expect(extractAddress('山田 太郎 <yamada@agency.co.jp>')).toBe('yamada@agency.co.jp')
    expect(extractAddress('"Yamada, Taro" <yamada@agency.co.jp>')).toBe('yamada@agency.co.jp')
  })

  it('Microsoft Graph の JSON から取る', () => {
    const graph = JSON.stringify({ emailAddress: { address: 'Yamada@Agency.co.jp', name: '山田' } })
    expect(extractAddress(graph)).toBe('yamada@agency.co.jp')
  })

  it('Postmark の FromFull オブジェクトから取る', () => {
    expect(extractAddress({ Email: 'yamada@agency.co.jp', Name: '山田' })).toBe('yamada@agency.co.jp')
  })

  it('小文字に正規化する（agent_companies はドメイン主キーなので大小を混ぜられない）', () => {
    expect(extractAddress('YAMADA@AGENCY.CO.JP')).toBe('yamada@agency.co.jp')
  })

  it('アドレスが無ければ空文字', () => {
    expect(extractAddress('')).toBe('')
    expect(extractAddress('差出人不明')).toBe('')
    expect(extractAddress(null)).toBe('')
  })
})

describe('unwrapForwarded', () => {
  it('Gmail 形式（転送メッセージ + From/Date/Subject）を展開する', () => {
    const body = [
      'ご確認ください。',
      '',
      '---------- 転送メッセージ ----------',
      'From: 山田 太郎 <yamada@agency.co.jp>',
      'Date: 2026年10月1日(木) 10:00',
      'Subject: 【人材】Java 10年',
      'To: 私 <me@customer.co.jp>',
      '',
      '氏名: A.B',
      'スキル: Java, Spring',
      '単価: 70万',
    ].join('\n')
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(true)
    expect(r.from).toBe('yamada@agency.co.jp')
    expect(r.subject).toBe('【人材】Java 10年')
    // 本文（転送ヘッダより下）が残っていること
    expect(r.body).toContain('氏名: A.B')
    expect(r.body).toContain('単価: 70万')
    // 転送者の前置きは落ちていること
    expect(r.body).not.toContain('ご確認ください')
  })

  it('Outlook 形式（区切り線 + 差出人/送信日時/宛先/件名）を展開する', () => {
    const body = [
      '営業部 田中',
      '________________________________',
      '差出人: 山田 太郎 <yamada@agency.co.jp>',
      '送信日時: 2026年10月1日 10:00',
      '宛先: me@customer.co.jp',
      '件名: 【ご提案】インフラ技術者',
      '',
      '氏名: C.D',
      'スキル: AWS, Terraform',
    ].join('\r\n')  // Outlook は CRLF
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(true)
    expect(r.from).toBe('yamada@agency.co.jp')
    expect(r.subject).toBe('【ご提案】インフラ技術者')
    expect(r.body).toContain('スキル: AWS, Terraform')
    expect(r.body).not.toContain('営業部 田中')
  })

  it('全角コロンの「差出人：」でも展開する', () => {
    const body = [
      '---------- 転送メッセージ ----------',
      '差出人：山田 太郎 <yamada@agency.co.jp>',
      '件名：【人材】PM',
      '',
      '氏名: E.F',
    ].join('\n')
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(true)
    expect(r.from).toBe('yamada@agency.co.jp')
    expect(r.body).toContain('氏名: E.F')
  })

  it('転送でない普通のメールは何も変えない', () => {
    const body = '氏名: G.H\nスキル: Python\n単価: 60万'
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(false)
    expect(r.body).toBe(body)
    expect(r.from).toBe('')
  })

  it('本文中に「氏名:」「単価:」が並ぶだけでは転送と誤判定しない', () => {
    // 人材メールは本文がコロン区切りのフィールドの羅列。ここを転送ヘッダと
    // 誤認すると本文の先頭が削られる。HEADER_KEYS に完全一致する行だけを見る。
    const body = [
      '氏名: I.J',
      '年齢: 32歳',
      '最寄駅: 新宿',
      '単価: 65万',
      'スキル: Java',
    ].join('\n')
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(false)
    expect(r.body).toBe(body)
  })

  it('キー行が1行だけなら転送と断定しない', () => {
    const body = '件名: これは本文の一部です\n\n氏名: K.L\nスキル: Go'
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(false)
  })

  it('差出人が取れないヘッダブロックは転送として採らない', () => {
    // アドレスが無い（表示名だけ）転送ヘッダ。復元できないので forwarded にしない。
    // → detectSilentDropRisk 側で止まる
    const body = [
      '---------- 転送メッセージ ----------',
      '差出人: 山田 太郎',
      '件名: 【人材】',
      '',
      '氏名: M.N',
    ].join('\n')
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(false)
  })

  it('入れ子の転送では一番外側（顧客に送ってきた会社）を採る', () => {
    // 代理店 inner が broker に送り、broker が顧客に転送し、顧客が我々に転送した形。
    // 欲しいのは「顧客にメールを送ってきた会社」= broker。
    const body = [
      '---------- 転送メッセージ ----------',
      'From: broker <sales@broker.co.jp>',
      'Subject: 転送: 【人材】',
      '',
      '---------- 転送メッセージ ----------',
      'From: inner <inner@inner.co.jp>',
      'Subject: 【人材】',
      '',
      '氏名: O.P',
    ].join('\n')
    const r = unwrapForwarded(body)
    expect(r.forwarded).toBe(true)
    expect(r.from).toBe('sales@broker.co.jp')
  })
})

describe('detectProvider', () => {
  it('SendGrid Inbound Parse', () => {
    expect(detectProvider({ envelope: '{}', charsets: '{}', from: 'a@b.jp' })).toBe('sendgrid')
  })
  it('Mailgun Routes', () => {
    expect(detectProvider({ 'body-plain': 'x', sender: 'a@b.jp' })).toBe('mailgun')
  })
  it('Postmark Inbound', () => {
    expect(detectProvider({ TextBody: 'x', FromFull: {} })).toBe('postmark')
  })
  it('CloudMailin', () => {
    expect(detectProvider({ plain: 'x', headers: {} })).toBe('cloudmailin')
  })
  it('未知のサービスは generic', () => {
    expect(detectProvider({ from: 'a@b.jp', body: 'x' })).toBe('generic')
  })
})

describe('normalizeAttachments', () => {
  it('data / mimeType / name の配列をそのまま通す', () => {
    const r = normalizeAttachments([{ data: 'QUJD', mimeType: 'application/pdf', name: 'a.pdf' }])
    expect(r).toEqual([{ data: 'QUJD', mimeType: 'application/pdf', name: 'a.pdf' }])
  })

  it('Postmark 形式（Content / ContentType / Name）を均す', () => {
    const r = normalizeAttachments([{ Content: 'QUJD', ContentType: 'application/vnd.ms-excel', Name: 'b.xlsx' }])
    expect(r[0].mimeType).toBe('application/vnd.ms-excel')
    expect(r[0].name).toBe('b.xlsx')
  })

  it('data: URL の接頭辞を外す', () => {
    const r = normalizeAttachments([{ data: 'data:application/pdf;base64,QUJD', name: 'c.pdf' }])
    expect(r[0].data).toBe('QUJD')
  })

  it('JSON 文字列でも配列として読む', () => {
    const r = normalizeAttachments('[{"data":"QUJD","mimeType":"text/plain"}]')
    expect(r).toHaveLength(1)
  })

  it('中身が無いものは落とす', () => {
    expect(normalizeAttachments([{ name: 'd.pdf' }, { data: '' }, null, 'x'])).toEqual([])
  })

  it('添付なしは空配列（0件でも必ず配列を返す）', () => {
    expect(normalizeAttachments(undefined)).toEqual([])
  })
})

describe('normalizeWebhookPayload', () => {
  it('SendGrid の転送メールから原メールの差出人を復元する', () => {
    const raw = {
      envelope: '{"to":["intake@mine.co.jp"],"from":"tanaka@customer.co.jp"}',
      charsets: '{}',
      from: '田中 <tanaka@customer.co.jp>',
      subject: '転送: 【人材】Java 10年',
      text: [
        '---------- 転送メッセージ ----------',
        'From: 山田 太郎 <yamada@agency.co.jp>',
        'Subject: 【人材】Java 10年',
        '',
        '氏名: A.B',
        'スキル: Java',
      ].join('\n'),
    }
    const mail = normalizeWebhookPayload(raw)
    expect(mail.provider).toBe('sendgrid')
    expect(mail.forwarded).toBe(true)
    // 転送者（顧客）ではなく原メールの差出人（代理店）になっていること
    expect(mail.envelopeFrom).toBe('tanaka@customer.co.jp')
    expect(mail.from).toBe('yamada@agency.co.jp')
    expect(mail.subject).toBe('【人材】Java 10年')
    expect(mail.body).toContain('氏名: A.B')
  })

  it('サーバ側の転送ルール（From ヘッダが原メールのまま）はそのまま通す', () => {
    // メールボックスの「コピーを転送」ルールは From を保つので展開不要。
    // この場合に余計なことをしないのが大事。
    const raw = { from: '山田 <yamada@agency.co.jp>', subject: '【人材】', text: '氏名: C.D\nスキル: Go' }
    const mail = normalizeWebhookPayload(raw)
    expect(mail.forwarded).toBe(false)
    expect(mail.from).toBe('yamada@agency.co.jp')
    expect(mail.body).toBe('氏名: C.D\nスキル: Go')
  })

  it('プレーン本文が無ければ HTML を渡す（タグ落としは inbound-email に任せる）', () => {
    const raw = { from: 'a@agency.co.jp', subject: 's', html: '<div>氏名: E.F</div>' }
    const mail = normalizeWebhookPayload(raw)
    expect(mail.body).toBe('<div>氏名: E.F</div>')
    expect(mail.notes.join()).toContain('HTML')
  })

  it('Mailgun は stripped-text ではなく body-plain を見る', () => {
    // stripped-text は Mailgun が引用を削ったもので、転送ヘッダも消えて
    // 差出人を復元できなくなる。生の body-plain を優先する。
    const raw = {
      sender: 'tanaka@customer.co.jp',
      'body-plain': '---------- 転送メッセージ ----------\nFrom: 山田 <yamada@agency.co.jp>\nSubject: x\n\n氏名: G.H',
      'stripped-text': '氏名: G.H',
    }
    const mail = normalizeWebhookPayload(raw)
    expect(mail.provider).toBe('mailgun')
    expect(mail.from).toBe('yamada@agency.co.jp')
  })

  it('受信日時を ISO に正規化する', () => {
    const raw = { from: 'a@agency.co.jp', subject: 's', text: 'x', Date: 'Thu, 01 Oct 2026 10:00:00 +0900' }
    const mail = normalizeWebhookPayload(raw)
    expect(mail.emailReceivedAt).toBe('2026-10-01T01:00:00.000Z')
  })

  it('解釈できない受信日時は null にして診断メモを残す', () => {
    const raw = { from: 'a@agency.co.jp', subject: 's', text: 'x', date: 'いつか' }
    const mail = normalizeWebhookPayload(raw)
    expect(mail.emailReceivedAt).toBeNull()
    expect(mail.notes.join()).toContain('受信日時')
  })
})

describe('toInboundEmailFields', () => {
  it('inbound-email が読むキー名で組む', () => {
    const mail = normalizeWebhookPayload({
      from: 'yamada@agency.co.jp', subject: '【人材】', text: '氏名: A.B',
      attachments: [{ data: 'QUJD', mimeType: 'application/pdf', name: 'a.pdf' }],
    })
    const f = toInboundEmailFields(mail, 'prod')
    expect(f.type).toBe('candidate')
    expect(f.from).toBe('yamada@agency.co.jp')
    expect(f.subject).toBe('【人材】')
    expect(f.body).toBe('氏名: A.B')
    expect(f.data_env).toBe('prod')
    // 複数添付を渡せる attachmentsJson を使う（attachment[data] は先頭1件しか見られない）
    expect(JSON.parse(f.attachmentsJson)).toHaveLength(1)
  })

  it('添付が無ければ attachmentsJson を付けない', () => {
    const mail = normalizeWebhookPayload({ from: 'a@agency.co.jp', subject: 's', text: 'x' })
    expect(toInboundEmailFields(mail, 'demo').attachmentsJson).toBeUndefined()
  })
})

describe('detectSilentDropRisk', () => {
  const ok = normalizeWebhookPayload({ from: 'yamada@agency.co.jp', subject: 's', text: '氏名: A.B' })

  it('普通のメールは止めない', () => {
    expect(detectSilentDropRisk(ok, 'i-voice.co.jp')).toBeNull()
  })

  it('差出人が自社ドメインのままなら止める（OWN_DOMAIN で静かに捨てられるため）', () => {
    // 顧客が転送したが転送ヘッダを復元できず、from が顧客＝自社ドメインのまま残った形。
    // inbound-email に渡すと OWN_DOMAIN スキップで**無言で消える**。
    const mail = normalizeWebhookPayload({ from: 'tanaka@i-voice.co.jp', subject: 's', text: '氏名: A.B' })
    const risk = detectSilentDropRisk(mail, 'i-voice.co.jp')
    expect(risk).not.toBeNull()
    expect(risk).toContain('自社ドメイン')
  })

  it('自社ドメインの大文字小文字は無視する', () => {
    const mail = normalizeWebhookPayload({ from: 'tanaka@i-voice.co.jp', subject: 's', text: 'x' })
    expect(detectSilentDropRisk(mail, 'I-Voice.CO.JP')).not.toBeNull()
  })

  it('自社ドメイン未設定なら判定しない', () => {
    const mail = normalizeWebhookPayload({ from: 'tanaka@i-voice.co.jp', subject: 's', text: 'x' })
    expect(detectSilentDropRisk(mail, '')).toBeNull()
  })

  it('差出人が取れなければ止める', () => {
    const mail = normalizeWebhookPayload({ from: '差出人不明', subject: 's', text: 'x' })
    expect(detectSilentDropRisk(mail, '')).toContain('差出人')
  })

  it('本文も添付も空なら止める', () => {
    const mail = normalizeWebhookPayload({ from: 'a@agency.co.jp', subject: 's', text: '' })
    expect(detectSilentDropRisk(mail, '')).toContain('空')
  })

  it('本文が空でも添付があれば通す（経歴書だけ付けたメールは実際にある）', () => {
    const mail = normalizeWebhookPayload({
      from: 'a@agency.co.jp', subject: 's', text: '',
      attachments: [{ data: 'QUJD', mimeType: 'application/pdf', name: 'a.pdf' }],
    })
    expect(detectSilentDropRisk(mail, '')).toBeNull()
  })
})
