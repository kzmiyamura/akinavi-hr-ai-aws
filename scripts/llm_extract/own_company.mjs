// own_company.mjs — 当社（受信側）の社名。所属会社として登録してはいけない名前。
//
// SES の紹介メールは本文冒頭が「株式会社ボイス / ご担当者様」のように**宛先＝当社**で始まる。
// AI にそのまま読ませると、ここを「所属会社」と誤って転記する
// （2026-08-17 に実害: R.I の所属会社が「株式会社ボイス」になっていた。正しくは株式会社ai・more）。
//
// regex 側は supabase/functions/inbound-email/index.ts の OWN_COMPANY_NAMES で
// 同じ除外をしている。**片方だけ直すと再発するので、増やすときは両方に入れること。**
export const OWN_COMPANY_NAMES = [
  '株式会社ボイス',
  'i-voice',
  'アキナビ',
  'akinavi',
  '株式会社アキナビ',
]

/** 当社名かどうか（部分一致・大小文字と記号のゆれを吸収） */
export function isOwnCompany(value) {
  const v = String(value ?? '').replace(/[\s　・.,]/g, '').toLowerCase()
  if (!v) return false
  return OWN_COMPANY_NAMES.some((own) => {
    const o = own.replace(/[\s　・.,]/g, '').toLowerCase()
    return o && v.includes(o)
  })
}
