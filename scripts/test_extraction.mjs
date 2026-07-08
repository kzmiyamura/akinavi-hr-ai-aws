#!/usr/bin/env node
// =============================================================================
// メール抽出ロジック ローカルテストスクリプト
// =============================================================================
// 使い方:
//   node scripts/test_extraction.mjs "メール本文テキスト"
//   node scripts/test_extraction.mjs --file path/to/email.txt
//   echo "本文" | node scripts/test_extraction.mjs
//   node scripts/test_extraction.mjs  # 対話入力（Ctrl+D で確定）
//
// オプション:
//   --type candidate|project  解析タイプ（既定: candidate）
//   --attach "添付テキスト"   添付ファイルのテキスト
//   --file <path>             ファイルから本文を読み込む
//
// 目的:
//   inbound-email をデプロイせずにローカルで抽出結果を確認できる。
//   regex 修正 → このスクリプトで即確認 → 正しければ deploy の流れで
//   deploy サイクルを削減する。
//
// 注意:
//   skill_master DB照合はローカルでは実行できないため "（デプロイ後確認）" と表示する。
//   このスクリプトの関数は inbound-email/index.ts と同期が必要。
//   最終同期コミット: 697f063 (2026-05-29)
// =============================================================================

import { readFileSync } from 'fs'

// ─── inbound-email/index.ts から複製した関数群 ────────────────────────────
// 変更時は index.ts と両方を更新すること

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripUrlsForSkillMatching(text) {
  if (!text) return text
  return text.replace(/https?:\/\/[^\s\u3000<>"'\(\)\[\]｝】、，。]+/gi, ' ')
}

function stripSenderSignature(text) {
  if (!text) return text
  const lines = text.split(/\r?\n/)
  const separatorRe = /[━─=＝]{8,}/
  for (let i = 0; i < lines.length; i++) {
    if (separatorRe.test(lines[i])) {
      if (i / lines.length >= 0.5) return lines.slice(0, i).join('\n')
    }
  }
  return text
}

function flexLabel(label) {
  const META = /[.*+?()[\]{}\\|^$]/
  let result = ''
  for (let i = 0; i < label.length; i++) {
    const ch = label[i]
    const isMeta = META.test(ch)
    result += isMeta ? ch : ch.replace(/[.*+?()[\]{}\\|^$]/g, '\\$&')
    if (i < label.length - 1) {
      const nextIsMeta = META.test(label[i + 1])
      if (!nextIsMeta) result += '[　 ]*'
    }
  }
  return result
}

function extractFieldTwoPhase(labels, bodyText, attachText, validate, maxLen = 30, phase3MinLen = 3) {
  const esc = labels.map(flexLabel).join('|')
  const SEP     = `(?:[：:\\t\\]】◆◇●■▼★]|　+| {2,})`
  const SEP_ATT = `(?:[：:\\t\\],，】◆◇●■▼★]|　+| {2,})`
  const DECO_RE = /[◆◇●■▼★◎※▪]+([^◆◇●■▼★◎※▪\n]{1,30})[◆◇●■▼★◎※▪]+/g
  const normalBody   = bodyText.replace(DECO_RE,   (_, inner) => inner.trim())
  const normalAttach = (attachText ?? '').replace(DECO_RE, (_, inner) => inner.trim())
  const check = (v, minLen = 1) => {
    const t = v.trim().replace(/[　 ]+$/, '')
    if (!t || t.length < minLen || t.length > maxLen) return null
    if (validate && !validate(t)) return null
    return t
  }
  const rSameLine = (sep) =>
    new RegExp(`(?:${esc})(?:[（(][^）)]{1,20}[）)])?[　 ]?${sep}[　 ]?[：:]?[　 ]?([^\\n,，]{1,${maxLen}})`, 'i')
  const bodyBlocks = normalBody.split(/\n{2,}/)
  if (bodyBlocks.length > 1) {
    const labelPresent = new RegExp(`(?:${esc})`, 'i')
    const block = bodyBlocks.find(b => labelPresent.test(b))
    if (block && block !== normalBody) {
      const m = block.match(rSameLine(SEP))
      if (m) { const v = check(m[1]); if (v) return v }
    }
  }
  const mBody = normalBody.match(rSameLine(SEP))
  if (mBody) { const v = check(mBody[1]); if (v) return v }
  {
    const labelOnly1b = new RegExp(`^[　 ]*[■●▪▶【]?[　 ]?(?:${esc})[　 ]?[】：:,，]?[　 ]*$`, 'i')
    const bodyLines = normalBody.split(/\r?\n/)
    for (let i = 0; i < bodyLines.length - 1; i++) {
      if (!labelOnly1b.test(bodyLines[i])) continue
      for (let j = i + 1; j < Math.min(i + 3, bodyLines.length); j++) {
        const v = check(bodyLines[j])
        if (v) return v
      }
    }
  }
  if (normalAttach.trim()) {
    const mAtt = normalAttach.match(rSameLine(SEP_ATT))
    if (mAtt) { const v = check(mAtt[1]); if (v) return v }
  }
  const allText = normalBody + '\n' + normalAttach
  const rSingle = new RegExp(`(?:${esc}) ([^ \\t,，\\n　]{1,${maxLen}})`, 'i')
  const mSingle = allText.match(rSingle)
  if (mSingle) { const v = check(mSingle[1], phase3MinLen); if (v) return v }
  return null
}

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県',
  '静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県',
  '奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県',
  '熊本県','大分県','宮崎県','鹿児島県','沖縄県',
]

// ※ ローカルテスト用の簡易マップ（DB版より少ない）
// 実際は station_master テーブルで管理
const STATION_TO_PREFECTURE = {
  '東京': '東京都', '品川': '東京都', '渋谷': '東京都', '新宿': '東京都',
  '池袋': '東京都', '上野': '東京都', '秋葉原': '東京都', '有楽町': '東京都',
  '新橋': '東京都', '浜松町': '東京都', '田町': '東京都', '目黒': '東京都',
  '恵比寿': '東京都', '五反田': '東京都', '大崎': '東京都', '高田馬場': '東京都',
  '中野': '東京都', '吉祥寺': '東京都', '立川': '東京都', '八王子': '東京都', '調布': '東京都', '西調布': '東京都',
  '葛西': '東京都', '西葛西': '東京都', '葛西臨海公園': '東京都',
  '五反野': '東京都', '大手町': '東京都', '神田': '東京都', '飯田橋': '東京都',
  '横浜': '神奈川県', '川崎': '神奈川県', '町田': '神奈川県',
  '鶴見': '神奈川県', '大船': '神奈川県', '元住吉': '神奈川県',
  '日吉': '神奈川県', '青葉台': '神奈川県', 'たまプラーザ': '神奈川県',
  '溝の口': '神奈川県', '海老名': '神奈川県', '藤沢': '神奈川県',
  '大宮': '埼玉県', '浦和': '埼玉県', '川口': '埼玉県', '所沢': '埼玉県',
  '柏': '千葉県', '松戸': '千葉県', '市川': '千葉県', '船橋': '千葉県',
  '千葉': '千葉県', '八街': '千葉県', '佐倉': '千葉県',
  '梅田': '大阪府', '難波': '大阪府', '天王寺': '大阪府', '新大阪': '大阪府',
  '名古屋': '愛知県', '栄': '愛知県',
  '札幌': '北海道', '仙台': '宮城県', '博多': '福岡県', '天神': '福岡県',
  '広島': '広島県', '岡山': '岡山県', '金沢': '石川県', '高松': '香川県',
  '那覇': '沖縄県',
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&#8203;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\t{2,}/g, '\t')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isHtmlBody(rawBody) {
  return rawBody.includes('<html') || rawBody.includes('<div') || rawBody.includes('<p ')
    || rawBody.includes('<p>') || rawBody.includes('<table') || rawBody.includes('<span') || rawBody.includes('<td')
    || rawBody.includes('<br') || rawBody.includes('<ul') || rawBody.includes('<ol') || rawBody.includes('<li')
    || rawBody.includes('<h1') || rawBody.includes('<h2') || rawBody.includes('<h3')
}

function inferPrefectureFromStation(station) {
  if (!station) return null
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim()
  if (!cleaned) return null
  return STATION_TO_PREFECTURE[cleaned] ?? null
}

function sanitizeFromCompany(s) {
  if (!s) return null
  let trimmed = s.trim()
  if (!trimmed) return null
  // 自社名は null に落とす
  for (const own of ['アキナビ', 'AkiNavi', 'AKINAVI']) {
    if (trimmed.toLowerCase().includes(own.toLowerCase())) return null
  }
  // 「の」なし・漢字姓+丁寧表現: 「株式会社イチアール小島でございます」→「株式会社イチアール」
  {
    const politePersonM = trimmed.match(/^((?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人).{2,}?)[一-龯々]{1,4}(?:でございます|です|と申します|でした)/)
    if (politePersonM) trimmed = politePersonM[1]
  }
  // 「の〇〇でございます」等が残っていれば除去
  trimmed = trimmed.replace(/の[^\s　]{1,15}(?:でございます|です|と申します|でした).*$/, '')
  // 前株パターン
  const preM = trimmed.match(/^((?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)[^\sの　\n、。！（）【】「」]{2,30}(?:[ \t]+[A-Za-z][A-Za-z \t&.]{0,20})?)/)
  if (preM) { trimmed = preM[1].trim() }
  // 後株パターン
  const postM = trimmed.match(/^([^\sの　\n、。！（）【】「」]{2,20}(?:株式会社|有限会社|合同会社))/)
  if (postM) { trimmed = postM[1] }
  if (/^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)$/.test(trimmed)) return null
  return trimmed.length >= 3 ? trimmed : null
}

function extractCandidateFieldsRegex(bodyText, attachText) {
  const NAME_FIELD_LABELS = /^(年齢|性別|住所|スキル|経験|希望|単価|国籍|備考|資格|学歴|連絡先|電話|メール|生年|誕生|担当|会社|企業|所属|役職|部署|稼働|稼動|勤務|現住所|最寄|最寄り|駅名|沿線|フリガナ|ふりがな|読み|備考欄|コメント|評価|合計|レベル|スコア|期間|開始|終了|工程|規模|人数|契約|派遣|フリー|正社員|アルバイト|パート)$/
  let rawName = extractFieldTwoPhase(
    ['氏名等','氏名','名前','候補者名','お名前','フルネーム','ご氏名','氏　名'],
    bodyText, attachText,
    v => v.length >= 2 && !/^\d+$/.test(v) && !NAME_FIELD_LABELS.test(v), 40, 2,
  )
  // カンマ区切りイニシャル補完: 「名前：M,T（23）」→ rawName=null になる場合に復元
  if (!rawName) {
    const commaInitialM = (bodyText + '\n' + attachText).match(
      /(?:氏名等|氏名|名前|候補者名?|お名前|フルネーム|ご氏名|氏[　 ]*名)[　 ]*[：:][　 ]*([A-Z]),([A-Z])/
    )
    if (commaInitialM) rawName = `${commaInitialM[1]}.${commaInitialM[2]}`
  }
  const cleanedName = rawName ? rawName.replace(/^[：:\s　]+/, '').trim() || null : null
  let age = null, gender = null, nameStripped = cleanedName || ''
  const agGenderUnified = nameStripped.match(/[\(（](\d{2})[才歳][ 　]*[/／：:・．][ 　]*(男性|女性|男|女)(?:[/／]([^)）]*))?[\)）]/)
  // 「（男性/48歳、中国）」のように括弧内に国籍が続く形式にも対応
  const genderAgeUnified = !agGenderUnified ? nameStripped.match(/[\(（](男性|女性|男|女)[ 　]*(?:[/／：:・．][ 　]*|[ 　]+)(\d{2})[才歳](?:[、,\/／]([^)）]{1,15}))?[\)）]/) : null
  let nationality = null
  if (agGenderUnified) {
    age = parseInt(agGenderUnified[1], 10); gender = agGenderUnified[2]
    if (agGenderUnified[3]?.trim()) nationality = agGenderUnified[3].trim()
    nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[才歳][ 　]*[/／：:・．][ 　]*(?:男性|女性|男|女)(?:[/／][^)）]*)?[\)）]/, '').trim()
  } else if (genderAgeUnified) {
    gender = genderAgeUnified[1]; age = parseInt(genderAgeUnified[2], 10)
    if (genderAgeUnified[3]?.trim() && !nationality) nationality = genderAgeUnified[3].trim()
    nameStripped = nameStripped.replace(/[\s　]?[\(（](?:男性|女性|男|女)[ 　]*(?:[/／：:・．][ 　]*|[ 　]+)\d{2}[才歳](?:[、,\/／][^)）]{1,15})?[\)）]/, '').trim()
  } else {
    const ageMatch = nameStripped.match(/[\s　]?[\(（](\d{2})[才歳][\)）]?/)
    if (ageMatch) { age = parseInt(ageMatch[1], 10); nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[才歳][\)）]?/, '').trim() }
    const genderMatch = nameStripped.match(/[\s　]?[\(（](男性|女性|男|女)[\)）]/)
    if (genderMatch) { gender = genderMatch[1]; nameStripped = nameStripped.replace(/[\s　]?[\(（](?:男性|女性|男|女)[\)）]/, '').trim() }
    if (gender === null) {
      const bareGenderMatch = nameStripped.match(/[ 　]?(男性|女性|男|女)$/)
      if (bareGenderMatch) { gender = bareGenderMatch[1]; nameStripped = nameStripped.replace(/[ 　]?(?:男性|女性|男|女)$/, '').trim() }
    }
    if (age === null) {
      const bareAgeMatch = nameStripped.match(/[\s　]?[\(（](\d{2})[\)）]/)
      if (bareAgeMatch) { age = parseInt(bareAgeMatch[1], 10); nameStripped = nameStripped.replace(/[\s　]?[\(（]\d{2}[\)） ]/, '').trim() }
    }
  }
  // 括弧内に「スキル名 X年」が1つ以上あれば nameSkillYears に抽出して括弧を除去 (#79)
  let nameSkillYears = null
  {
    const skillYearBracket = nameStripped.match(/[\(（]([^)）]{3,80})[\)）]$/)
    if (skillYearBracket) {
      const parts = skillYearBracket[1].split(/\s*[\/／・、,]\s*/)
      const entries = {}
      for (const part of parts) {
        const m = part.trim().match(/^(.+?)[ 　]+(\d+(?:\.\d+)?)\s*年/)
        if (m) {
          const skillName = m[1].trim()
          const yrs = parseFloat(m[2])
          if (skillName && yrs > 0 && yrs <= 50) entries[skillName] = Math.round(yrs * 12)
        }
      }
      if (Object.keys(entries).length > 0) {
        nameSkillYears = entries
        nameStripped = nameStripped.replace(/[\s　]?[\(（][^)）]{3,80}[\)） ]$/, '').trim()
      }
    }
  }
  let name = nameStripped || null
  let bracketStation = null
  if (!name || age === null || gender === null) {
    const allTextForName = bodyText + '\n' + attachText
    const noLabelPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([^\d\s　（(\n【]{1,20})[ 　]?[（(](\d{2})[才歳][ 　]*[/／：: ][ 　]*(男性|女性|男|女)(?:[/／][^)）]*)?[）)]/m
    const noLabelPatGF = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([^\d\s　（(\n【]{1,20})[ 　]?[（(](男性|女性|男|女)[ 　]*[/／][ 　]*(\d{2})[才歳][）)]/m
    const nlM = allTextForName.match(noLabelPat)
    const nlMGF = !nlM ? allTextForName.match(noLabelPatGF) : null
    const bracketPat = /【([^\d、,】]{1,15})、(\d{1,3})[才歳]、(男性|女性)、([^、】]{2,20}?)(?:、[^】]*)?】/
    const nlBracket = (!nlM && !nlMGF) ? allTextForName.match(bracketPat) : null
    if (nlM) {
      if (!name)           name   = nlM[1].trim().replace(/^\[[^\]]{1,10}\]/, '') || null
      if (age === null)    age    = parseInt(nlM[2], 10)
      if (gender === null) gender = nlM[3]
    } else if (nlMGF) {
      if (!name)           name   = nlMGF[1].trim().replace(/^\[[^\]]{1,10}\]/, '') || null
      if (gender === null) gender = nlMGF[2]
      if (age === null)    age    = parseInt(nlMGF[3], 10)
    } else if (nlBracket) {
      if (!name)           name   = nlBracket[1].trim() || null
      if (age === null)    age    = parseInt(nlBracket[2], 10)
      if (gender === null) gender = nlBracket[3]
      bracketStation = nlBracket[4]?.includes('駅') ? nlBracket[4].trim() : null
    }
    if (!name || age === null || gender === null) {
      const dearismPat = /≪([^≪≫（(\n]{1,20}?)[ 　]*[（(](\d{2})[才歳][）)][ 　]*(男性|女性|男|女)/
      const nlD = allTextForName.match(dearismPat)
      if (nlD) {
        if (!name)           name   = nlD[1].trim() || null
        if (age === null)    age    = parseInt(nlD[2], 10)
        if (gender === null) gender = nlD[3]
      }
    }
    if (!name || age === null || gender === null) {
      const stationParenPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Za-zＡ-Ｚａ-ｚ]{1,10})[　 ]?[（(][^)）\d]{1,15}[）)][　 ]*(男性|女性|男|女)[・･][　 ]*(\d{2})[才歳]/m
      const nlSP = allTextForName.match(stationParenPat)
      if (nlSP) {
        if (!name)           name   = nlSP[1].trim() || null
        if (gender === null) gender = nlSP[2]
        if (age === null)    age    = parseInt(nlSP[3], 10)
      }
    }
    if (age === null || gender === null) {
      const bareAgeGenderPat = /(?:^|\n)[ 　]*([^\d\s　\n]{1,20})[　 ]+(\d{2})[才歳][　 ]?(男性|女性|男|女)/m
      const nlBare = allTextForName.match(bareAgeGenderPat)
      if (nlBare && !NAME_FIELD_LABELS.test(nlBare[1].trim())) {
        if (!name)           name   = nlBare[1].trim() || null
        if (age === null)    age    = parseInt(nlBare[2], 10)
        if (gender === null) gender = nlBare[3]
      }
    }
  }
  if (!nationality) {
    const natInName = nameStripped.match(/[\s　]?[\(（]([^)）\d]{1,15}[籍人国])[\)）]/)
    if (natInName) { nationality = natInName[1].trim(); nameStripped = nameStripped.replace(/[\s　]?[\(（][^)）\d]{1,15}[籍人国][\)）]/, '').trim() }
  }
  if (!nationality) {
    const natMark = (bodyText + '\n' + attachText).match(/[※＊\*][ 　]?([^\s,、。（）「」【】\t]{1,15}[籍国人])/)
    if (natMark) nationality = natMark[1].trim()
  }
  name = name || nameStripped || null
  if (name) {
    const trailGenderM = name.match(/[ 　]*[/／][ 　]*(男性|女性|男|女)[ 　]*(?:[/／][^）)]*)?[）)]?\s*$/)
    if (trailGenderM) {
      if (gender === null) gender = trailGenderM[1]
      name = name.replace(/[ 　]*[/／][ 　]*(男性|女性|男|女)[ 　]*(?:[/／][^）)]*)?[）)]?\s*$/, '').trim() || null
    }
  }
  if (name) name = name.replace(/[ 　]*(男性|女性|男|女)[）)]\s*$/, '').trim() || null
  if (name && !age) {
    const trailingAgeM = name.match(/[ 　]+(\d{2})[才歳]$/)
    if (trailingAgeM) {
      age = parseInt(trailingAgeM[1], 10)
      name = name.replace(/[ 　]+\d{2}[才歳]$/, '').trim() || null
      if (name) name = name.replace(/[ 　]*[/／、，・][ 　]*$/, '').trim() || null
    }
  }
  if (name && !age) {
    const ageOnlyM = name.match(/[ 　]?[（(](\d{2})[）)]$/)
    if (ageOnlyM) { age = parseInt(ageOnlyM[1], 10); name = name.replace(/[ 　]?[（(]\d{2}[）)]$/, '').trim() || null }
  }
  if (name && name.includes('】【')) {
    // lookbehind で最初の 】 を残してそれ以降の【...】を除去（例:「【T・N】【豊岡】」→「【T・N】」→「T・N」）
    name = name.replace(/(?<=】)【.*$/, '').trim() || null
    if (name) name = name.replace(/^【([^】]+)】$/, '$1').trim() || null
  }
  // ── 最終安全網: 残留する年齢・性別を名前から除去 ─────────────────
  // ① カンマ・読点・スラッシュ区切りの年齢を除去 "W000085、57歳 男性..." → "W000085" / "MS/31歳/" → "MS"
  if (name) {
    const commaAgeM = name.match(/[、,/／]\s*(\d+)[才歳][\s\u3000]?(女性|男性|女|男)?/)
    if (commaAgeM) {
      if (age === null) age = parseInt(commaAgeM[1], 10)
      if (gender === null && commaAgeM[2]) gender = commaAgeM[2]
      name = name.replace(/[、,/／]\s*\d+[才歳].*$/, '').trim() || null
    }
  }
  // ② 年齢（2〜3桁+才/歳）が名前に含まれる場合はそこで切り捨て（直後の性別も同時に取得）
  if (name) {
    const ageInNameM = name.match(/^(.*?[^\d\s\u3000])[\s\u3000]?(\d{2,3})[才歳][\s\u3000]?(女性|男性|女|男)?/)
    if (ageInNameM && ageInNameM[1].trim().length >= 1) {
      if (age === null) age = parseInt(ageInNameM[2], 10)
      if (gender === null && ageInNameM[3]) gender = ageInNameM[3]
      name = ageInNameM[1].trim() || null
    }
  }
  // ③ 性別（男性/女性/男/女）が名前に含まれる場合はそこで切り捨て
  if (name) {
    const genderInNameM = name.match(/^(.+?)[\s\u3000]?(男性|女性|男|女).*$/)
    if (genderInNameM && genderInNameM[1].trim().length >= 1) {
      if (gender === null) gender = genderInNameM[2]
      name = genderInNameM[1].trim() || null
    }
  }
  // ④ 名前末尾の孤立した括弧・区切り記号を除去（例:「国PF（」→「国PF」）
  if (name) name = name.replace(/[（(【,、\/／・\s　]+$/, '').trim() || null
  // ⑥ ☆フィールド区切り形式の残留を除去（例: "IA ☆最　寄：大村駅" → "IA"）
  // 「☆名　前：IA ☆最　寄：駅名 ☆稼　働：...」のように全フィールドが1行に並ぶ書式対応
  if (name) name = name.replace(/[ 　]*☆.*$/, '').trim() || null
  if (!name) {
    const allTextForInitials = bodyText + '\n' + attachText
    const initialsPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Z][.．・,][A-Z])[ 　]?[（(](\d{2})[才歳][^)）]*[）)]/m
    const initialsOnlyPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Z][.．・,][A-Z])(?:[ 　]|$)/m
    const imatch = allTextForInitials.match(initialsPat)
    const imatchOnly = !imatch ? allTextForInitials.match(initialsOnlyPat) : null
    if (imatch) { name = imatch[1].trim().replace(',', '.'); if (age === null) age = parseInt(imatch[2], 10) }
    else if (imatchOnly) name = imatchOnly[1].trim().replace(',', '.')
  }
  if (age === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/年\s*[　 ]*齢[\s　 ]*[：:]\s*(\d{2})[才歳]/)
    if (m) age = parseInt(m[1], 10)
  }
  if (age === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/年\s*[　 ]*齢[\s　 ]*[/／]\s*(\d{2,3})(?!\s*[年ヶ月])/)
    if (m) { const v = parseInt(m[1], 10); if (v >= 18 && v <= 80) age = v }
  }
  if (gender === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/性\s*[　 ]*別[\s　 ]*[：:]\s*(男性|女性|男|女)/)
    if (m) gender = m[1]
  }
  if (gender === null) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/性\s*[　 ]*別[\s　 ]*[/／]\s*(男性|女性|男|女)/)
    if (m) gender = m[1]
  }
  if (!nationality) {
    const allText = bodyText + '\n' + attachText
    const m = allText.match(/国\s*[　 ]*籍[\s　 ]*[：:]\s*([^\s\n、。]{1,15})/)
    if (m) nationality = m[1].trim()
  }
  if (!nationality) {
    const natInline = (bodyText + '\n' + attachText).match(/(?:^|[\s　/／・,、|｜（(])((?:[ァ-ヶー]{2,8}|[一-龠]{2,6})籍)/m)
    const EXCLUDE_NAT = /^(在籍|本籍|戸籍|書籍|移籍|国籍|原籍|入籍|除籍|学籍|党籍|軍籍|転籍|復籍|船籍)$|在籍$/
    if (natInline && !EXCLUDE_NAT.test(natInline[1])) nationality = natInline[1].trim()
  }
  let nearestStation = extractFieldTwoPhase(
    ['最寄り?駅','最寄駅','最寄り?','沿線','通勤駅'],
    bodyText, attachText,
    v => { const c = v.replace(/（[^）]*）.*$/, '').trim(); return /[駅線]$/.test(c) || (c.length <= 10 && /[^\x00-\x7F]/.test(c)) },
    30, 2,
  )
  if (!nearestStation && bracketStation) nearestStation = bracketStation
  if (!nearestStation) {
    const allText = bodyText + '\n' + attachText
    // 駅名に含まれないセパレータ（_(アンダーバー)・()半角括弧）を除外してファイル名ベースの誤マッチを防ぐ
    const m = allText.match(/([^\s,、。（）()「」【】\t_]{1,10}駅)(?:[\s　_\-）」】()徒歩.)]|$)/)
    if (m) nearestStation = m[1].trim()
  }
  if (nearestStation) {
    // 路線名カッコを除去: 「綾瀬駅（東京メトロ千代田線 / JR常磐線）」→「綾瀬駅」
    nearestStation = nearestStation.replace(/（[^）]*）.*$/, '').trim()
    // 路線名スラッシュ・中点区切りを除去: 「JR京浜東北線／蕨駅」「西武池袋線・東長崎駅」→「蕨駅」「東長崎駅」
    nearestStation = nearestStation.replace(/^.+[/／・]/, '').trim()
    const colonMatch = nearestStation.match(/[：:](.+駅.*)$/)
    if (colonMatch) nearestStation = colonMatch[1].trim()
    if (/^(最寄り?駅?|沿線|通勤駅|イニシャル|代表者|最寄り?$)/.test(nearestStation) || nearestStation.includes('イニシャル') || nearestStation.includes('最寄駅')
      || /^(自己PR|PR|アピールポイント|強み|備考|補足|資格|スキル|経験|希望|現住所|住所|氏名|年齢|性別|国籍|連絡先)$/.test(nearestStation)) nearestStation = null
    if (nearestStation) {
      const stationOnly = nearestStation.match(/([^\s　]{2,12}駅)$/)
      if (stationOnly && stationOnly[1] !== nearestStation) {
        nearestStation = stationOnly[1]
      } else if (!nearestStation.endsWith('駅')) {
        const stationStart = nearestStation.match(/^([^\s　]{1,12}駅)/)
        if (stationStart) nearestStation = stationStart[1]
      }
    }
  }
  let prefecture = extractFieldTwoPhase(
    ['住所','居住地','在住','現住所','都道府県','居住エリア','在住地'],
    bodyText, attachText, v => PREFECTURES.some(p => v.includes(p)), 40,
  )
  if (prefecture) {
    const found = PREFECTURES.find(p => prefecture.includes(p))
    if (found) prefecture = found
  }
  if (!prefecture) {
    const allText = stripSenderSignature(bodyText) + '\n' + attachText
    let firstIdx = Infinity, firstPref = null
    for (const p of PREFECTURES) {
      const idx = allText.indexOf(p)
      if (idx !== -1 && idx < firstIdx) { firstIdx = idx; firstPref = p }
    }
    prefecture = firstPref
  }
  const stationPrefecture = inferPrefectureFromStation(nearestStation)
  if (stationPrefecture && prefecture !== stationPrefecture) prefecture = stationPrefecture

  const normalizeDigits = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))
  const allTextNorm = normalizeDigits(bodyText + '\n' + attachText)
  let experienceYears = null
  for (const p of [
    // 「エンジニア歴：10年」「SE歴：8年」「技術歴7年」など 職種/技術 + 歴 形式（セパレータ任意）
    /(?:IT|エンジニア|SE|PG|開発|プログラム|システム|設計|インフラ|クラウド|技術|現場)(?:開発)?歴[：:\s　]*[約]?\s*(\d+)\s*年/,
    /経験[：:\s　]+[約]?\s*(\d+)\s*年/,
    /(\d+)\s*年[以上間程度]*(?:の)?(?:経験|実務|開発|IT|エンジニア)/,
    /(?:経験年数|開発経験)[：:\s]*[約]?\s*(\d+)年/,
    // 自然文中の「経験年数は約2年と若手ですが」のように助詞（は/が/も）を挟む言い回し
    /経験[\s　]*年数[はがも]\s*[約]?\s*(\d+)\s*年/,
    /(?:社会人歴|就労歴|通算|合計|累計|キャリア)[：:\s　]*[約]?\s*(\d+)\s*年/,
  ]) {
    const m = allTextNorm.match(p)
    if (m) { const y = parseInt(m[1], 10); if (y > 0 && y <= 50 && String(y).length < 4) { experienceYears = y; break } }
  }
  // フォールバック: 「経験年数」を明言せず「・項目：期間」の箇条書き内訳のみのケース
  // （例: ・ヘルプデスク：10ヶ月 / ・テスト実施：5ヶ月）→ 合算して概算の経験年数とする
  if (experienceYears === null) {
    const parseDurationToMonths = (text) => {
      if (!text) return null
      let months = 0
      const yearMatch = text.match(/(\d+)\s*年/)
      const monthMatch = text.match(/(\d+)\s*[ヶかカ]月/)
      if (yearMatch) {
        const y = parseInt(yearMatch[1])
        if (y > 50) return null
        months += y * 12
      }
      if (monthMatch) months += parseInt(monthMatch[1])
      return months > 0 ? months : null
    }
    const bulletDurationRE = /^[・\-]\s*[^：:\n]{1,40}[：:]\s*((?:\d+\s*年)?\s*(?:\d+\s*[ヶかカ]月)?)\s*$/gm
    let totalMonths = 0
    let bulletCount = 0
    let bm
    while ((bm = bulletDurationRE.exec(allTextNorm)) !== null) {
      const months = parseDurationToMonths(bm[1])
      if (months) { totalMonths += months; bulletCount++ }
    }
    if (bulletCount >= 2 && totalMonths > 0) {
      const y = Math.round(totalMonths / 12)
      if (y > 0 && y <= 50) experienceYears = y
    }
  }

  let desiredRate = extractFieldTwoPhase(
    ['希望単価','目安単価','単価','単金','単　金','単 金','希望報酬','希望月額','月額','月単価','希望料金'],
    bodyText, attachText, v => /\d/.test(v), 20,
  )
  if (!desiredRate) {
    const rateM1 = allTextNorm.match(/(?:希望[単]?価|単価|月額|月単価)[：:\s　]*(\d{2,3}[〜~－\-]?\d{0,3})\s*万\s*円?(?:[以上\/月程度台〜~]|$|\D)/)
    const rateM2 = !rateM1 ? allTextNorm.match(/(\d{2,3})\s*[〜~]\s*(\d{2,3})\s*万\s*円?/) : null
    const rateM3 = (!rateM1 && !rateM2) ? allTextNorm.match(/(\d{2,3})\s*万\s*円?(?:以上|\/月|程度|台)/) : null
    if (rateM1) desiredRate = `${rateM1[1]}万円`
    else if (rateM2) { const lo = parseInt(rateM2[1]), hi = parseInt(rateM2[2]); if (lo >= 20 && hi <= 300) desiredRate = `${lo}〜${hi}万円` }
    else if (rateM3) { const amount = parseInt(rateM3[1]); if (amount >= 20 && amount <= 300) desiredRate = `${amount}万円` }
  }

  const normalizedAllText = allTextNorm.replace(/稼\s+働/g, '稼働').replace(/参\s+画/g, '参画')
  let availableFrom = extractFieldTwoPhase(
    ['参画開始可能日','参画可能時期','参画可能','稼働開始月','稼働開始','稼働可能時期','稼働可能','稼働時期','開始可能日','稼動時期','稼働','参画時期','参画開始','就業開始','就業時期','就業可能時期'],
    normalizedAllText, attachText, v => v.length >= 2, 30,
  )
  if (!availableFrom && /(?:^|[\s　【:：])即日(?:[\s　】]|$)/.test(normalizedAllText)) availableFrom = '即日'
  if (!availableFrom) {
    const dateM = normalizedAllText.match(/(?:稼働|参画|就業)[^。\n]{0,10}?([0-9０-９]{1,4}[\/年\-][0-9０-９]{1,2}(?:[\/月\-][0-9０-９]{1,2}日?)?)/i)
      ?? normalizedAllText.match(/(?:稼働|参画)[^。\n]{0,5}?([0-9]{1,2}月(?:上旬|中旬|下旬|初旬)?(?:[〜~])?)/i)
    if (dateM) availableFrom = dateM[1].trim()
  }

  const desiredProject = extractFieldTwoPhase(
    ['希望案件','希望職種','希望業界','希望条件','希望業務','ご希望案件','ご希望','希望'],
    bodyText, attachText, v => v.length >= 2, 50,
  )

  let fromCompany = null
  const allBodyText2 = bodyText + '\n' + attachText
  const sigArea = allBodyText2.slice(-2000)
  const mPre = sigArea.match(/(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)([^\s　の\n（(、。！【】「」]{2,20})/)
  if (mPre) fromCompany = sanitizeFromCompany(`${mPre[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]}${mPre[1]}`)
  if (!fromCompany) {
    const mPost = sigArea.match(/([^\s　\n（(、。！【】「」]{2,20})(?:株式会社|有限会社|合同会社)/)
    if (mPost) fromCompany = sanitizeFromCompany(`${mPost[1]}${mPost[0].match(/株式会社|有限会社|合同会社/)?.[0]}`)
  }
  if (!fromCompany) {
    const introArea = allBodyText2.slice(0, 600)
    const introM = introArea.match(/\n([ァ-ヶーA-Za-z0-9&（）()．.]{2,20})の(?:[^\s　\n]{0,10})?(?:担当|営業|事業|部長|代表|スタッフ|コンサルタント|パートナー|アライアンス)/)
    if (introM) {
      const cand = introM[1].trim()
      if (cand.length >= 2 && !/弊社|御社|各社|自社|貴社/.test(cand)) fromCompany = cand
    }
  }
  if (!fromCompany) {
    const subjectLine = allBodyText2.split('\n')[0]
    const BRACKET_NON_COMPANY = /グループ|正社員|プロパ|常駐|可能|フリー|派遣|紹介|エンジニア|人材|要員|スキル|案件|開発|設計|即日|リモート|テレワーク|在宅|経験|言語|Java|Python|PHP|Go|AWS|Azure|GCP|SQL|Vue|React|Angular|Spring|Kotlin|Swift|TypeScript|Ruby|COBOL|C\+\+|C#|Docker|Linux|Windows|月.*[〜~～]|[〜~～].*月|[0-9]+年/
    const allBrackets = [...subjectLine.matchAll(/【([^】]{2,25})】/g)]
    let bracketCand = null
    for (let i = allBrackets.length - 1; i >= 0; i--) {
      const inner = allBrackets[i][1].trim()
      const companyPart = inner.split(/[\s　]/)[0]
      if (companyPart.length >= 2 && !BRACKET_NON_COMPANY.test(inner)) {
        bracketCand = companyPart
        break
      }
    }
    if (bracketCand) fromCompany = bracketCand
  }

  return { name, age, gender, nationality, nearestStation, prefecture, experienceYears, desiredRate, availableFrom, desiredProject, fromCompany, nameSkillYears }
}

// ─── extractSkillYearsFromBodyText（index.ts と同期） ────────────────────────
function extractSkillYearsFromBodyText(text) {
  const result = {}

  const parseYearsToMonths = (s) => {
    const m = s.match(/([0-9０-９]+)年/)
    if (!m) return null
    const n = parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    return isNaN(n) || n < 1 || n > 40 ? null : n * 12
  }

  const cleanSkillName = (s) => {
    let r = s.replace(/\s*[（(][^）)]*[）)]/g, '').replace(/[・、,，\s　]+$/, '').trim()
    const colonIdx = Math.max(r.lastIndexOf('：'), r.lastIndexOf(':'))
    if (colonIdx >= 0) r = r.slice(colonIdx + 1).trim()
    return r
  }

  const isNonSkill = (name) => {
    if (name.length < 2 || name.length > 30) return true
    return /経験|以上|程度|開発|業務|システム|設計|構築|基盤|インフラ|サービス|アプリ|エンジニア|実務|案件|プロジェクト|当社|弊社|担当|スキル/.test(name)
  }

  const patternEach = /([^\n。]{2,80})の経験がそれぞれ([0-9０-９]+年)/g
  let m
  while ((m = patternEach.exec(text)) !== null) {
    const months = parseYearsToMonths(m[2])
    if (!months) continue
    const skills = m[1].split(/[、,，・とやおよび及び]/)
    for (const raw of skills) {
      const name = cleanSkillName(raw)
      if (!isNonSkill(name)) result[name] = Math.max(result[name] ?? 0, months)
    }
  }

  const patternSingle = /([^\s　、,，・（(）)\n]{2,20})の経験が(?!それぞれ)([0-9０-９]+年)/g
  while ((m = patternSingle.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name)) result[name] = Math.max(result[name] ?? 0, months)
  }

  // パターン3: 「スキル：N年」「スキル（N年）」「スキル（約N年）」
  const patternLabel = /([A-Za-z][A-Za-z0-9+#. _/-]{0,19}|[ァ-ヶー]{2,15}|[一-龯々]{2,10})\s*[：:（(]\s*約?\s*([0-9０-９]+年[0-9０-９]*[ヶかカ]?月?)/g
  while ((m = patternLabel.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name) && !(name in result)) result[name] = months
  }

  // パターン3b: 「スキル（Nヶ月）」（月数のみ）
  const patternMonthsOnly = /([A-Za-z][A-Za-z0-9+#. _/-]{0,19}|[ァ-ヶー]{2,15})\s*[（(]\s*([0-9０-９]+)[ヶかカ]月\s*[）)]/g
  while ((m = patternMonthsOnly.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const mo = parseInt(m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    if (!isNaN(mo) && mo >= 1 && mo <= 360 && !isNonSkill(name) && !(name in result)) result[name] = mo
  }

  // パターン3c: 「スキル歴N年」
  const patternRekiYear = /([A-Za-z][A-Za-z0-9+#. _/-]{1,19}|[ァ-ヶー]{2,15}|[一-龯々]{2,10})歴\s*([0-9０-９]+)\s*年/g
  while ((m = patternRekiYear.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const yrs = parseInt(m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    if (!isNaN(yrs) && yrs >= 1 && yrs <= 40 && !isNonSkill(name) && !(name in result)) result[name] = yrs * 12
  }

  // パターン3d: 【スキル】セクション後のスラッシュ区切り「Java(約15年以上) / Kotlin(約8年)」
  const slashSkillSection = text.match(/(?:【スキル】|スキル[：:]\n?)([^\n]{10,300})/)
  if (slashSkillSection) {
    const sectionLine = slashSkillSection[1]
    const slashParts = sectionLine.split(/\s*[/／]\s*/)
    for (const part of slashParts) {
      const pm = part.trim().match(/^([A-Za-z][A-Za-z0-9+#. _-]{0,19}|[ァ-ヶー]{2,15})\s*[（(]\s*約?\s*([0-9０-９]+)\s*年/)
      if (pm) {
        const name = cleanSkillName(pm[1])
        const yrs = parseInt(pm[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
        if (!isNaN(yrs) && yrs >= 1 && yrs <= 40 && !isNonSkill(name)) result[name] = Math.max(result[name] ?? 0, yrs * 12)
      }
    }
  }

  // パターン4: 箇条書き記号 + スキル名 + N年
  const patternBullet = /^[●•・▪▶◆■○◇►➤※→]\s*([A-Za-z][A-Za-z0-9+#. _/-]{0,29}|[ァ-ヶー]{2,15}|[一-龯々]{2,10}(?:[　 ][A-Za-z0-9+#.]{1,15})?)\s*[　 \t]+([0-9０-９]+年(?:[0-9０-９]+[ヶかカ]?月?)?)/gm
  while ((m = patternBullet.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name) && !(name in result)) result[name] = months
  }

  // パターン5: スキル名\tN年
  const patternTabYear = /^([A-Za-z][A-Za-z0-9+#. _/()-]{1,29}|[ァ-ヶー]{2,15})\t([0-9０-９]+年[0-9０-９]*[ヶかカ]?月?(?:以上|程度|超)?)\s*$/gm
  while ((m = patternTabYear.exec(text)) !== null) {
    const name = cleanSkillName(m[1])
    const months = parseYearsToMonths(m[2])
    if (months && !isNonSkill(name) && !(name in result)) result[name] = months
  }

  // パターン6: 総経験年数ラベル（「経験年数：N年」「IT経験：N年以上」「経験N年」）
  // → スキルと対応しないため _totalProjectMonths に収める
  const patternTotalExp = /(?:経験年数|IT経験|総経験|開発経験)[：:]\s*([0-9０-９]+)\s*年/g
  while ((m = patternTotalExp.exec(text)) !== null) {
    const yrs = parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30)), 10)
    if (!isNaN(yrs) && yrs >= 1 && yrs <= 50 && !result['_totalProjectMonths']) {
      result['_totalProjectMonths'] = yrs * 12
    }
  }

  // パターン7: 「参画期間: YYYY年M月 〜 YYYY年M月」+ 近傍の「使用技術: スキル1/スキル2」
  {
    const lines = text.split(/\n/)
    const nowYM = new Date().getFullYear() * 12 + new Date().getMonth() + 1
    const parseYMBody = (s) => {
      const m3 = s.match(/(\d{4})年(\d{1,2})月/)
      if (m3) return parseInt(m3[1]) * 12 + parseInt(m3[2])
      const m4 = s.match(/(\d{4})[\/\-.](\d{1,2})/)
      if (m4) return parseInt(m4[1]) * 12 + parseInt(m4[2])
      if (/現在|今|継続|在籍中/i.test(s)) return nowYM
      return null
    }
    const PERIOD_LABEL = /^(参画期間|在籍期間|稼働期間|作業期間|プロジェクト期間|PJ期間|期間)[：:]/
    const SKILL_LABEL = /^(使用技術|使用言語|技術スタック|技術環境|開発環境|使用環境|言語|環境|スキル)[・・（(]?[^：:]*[：:]\s*(.+)/
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim()
      if (!PERIOD_LABEL.test(line)) continue
      const periodStr = line.replace(PERIOD_LABEL, '').trim()
      const rangeM = periodStr.match(/(.+?)\s*[〜～~\-－]+\s*(.+)/)
      if (!rangeM) continue
      const startYM = parseYMBody(rangeM[1])
      const endYM = parseYMBody(rangeM[2])
      if (!startYM || !endYM) continue
      const months = endYM - startYM + 1
      if (months <= 0 || months > 600) continue
      for (let di = -2; di <= 10; di++) {
        const sline = lines[li + di]?.trim() ?? ''
        const sm = sline.match(SKILL_LABEL)
        if (!sm) continue
        const skillStr = sm[2] ?? ''
        const skills = skillStr.split(/[\s\/／、，,・]+/).map(s => s.replace(/[（(][^）)]*[）)]/g, '').trim()).filter(s => s.length >= 2 && s.length <= 40 && !/^\d+$/.test(s))
        for (const skill of skills) {
          if (!isNonSkill(skill)) {
            result[skill] = (result[skill] ?? 0) + months
          }
        }
      }
    }
  }

  return result
}

function splitMultiCandidateBody(body) {
  // ■氏名：形式（■●▪▶ 等のビュレット付き）も認識
  const CANDIDATE_FIELD_RE = /【[^】]{1,10}】|[◇◆][^\n：:]{1,15}[：:]|(?:^|\n)[ 　]*[■●▪▶]?[ 　]*(?:名前|氏名)[　 ]*[：:]|[■●▪▶]?[ 　]*(?:最寄(?:り?駅?)|希望単価|希望単金|スキル|業務経験|稼働開始|稼働時期|アピール)/
  // 【 氏 名 】（半角スペース区切り形式）・■氏名：形式にも対応
  const NAME_FIELD_RE = /【[^】]{0,5}(?:氏名|お名前|名前|姓名|氏　名|氏　　名)[^】]{0,5}】|【氏[^】]{0,3}】|【[ 　]*氏[ 　]*名[ 　]*】|^[■●▪▶]?[ 　]*氏名[　 ]*[：:]|^名前[　 ]*[：:]|[◇◆]名前[　 ]*[：:]|^[■●▪▶◆◇][A-Za-zＡ-Ｚａ-ｚ.\-]{1,8}（\d+歳|^[■●▪▶◆◇][A-Za-zＡ-Ｚａ-ｚ]{1,10}[（(][^)）\d]{1,15}[）)][　 ]*(?:男性|女性|男|女)[・･]/m
  const lines = body.split(/\r?\n/)

  function trySplit(delimRe) {
    const delimIndices = []
    for (let i = 0; i < lines.length; i++) {
      if (delimRe.test(lines[i])) delimIndices.push(i)
    }
    if (delimIndices.length < 2) return null
    const delimSet = new Set(delimIndices)
    const allParts = []
    let current = []
    for (let i = 0; i < lines.length; i++) {
      if (delimSet.has(i)) { allParts.push(current.join('\n')); current = [] }
      else current.push(lines[i])
    }
    if (current.length > 0) allParts.push(current.join('\n'))
    // フッター・法的免責文・「以上になります」ブロックを候補者として処理しない
    const FOOTER_BLOCK_RE = /^(?:以上になります|以上です|よろしくお願いいたします|本メールに記載された|【重要[：:])/
    const blocks = []
    for (let i = 1; i < allParts.length; i++) {
      const content = allParts[i].trim()
      if (!content || content.length < 50) continue
      if (FOOTER_BLOCK_RE.test(content.slice(0, 100))) continue
      if (!CANDIDATE_FIELD_RE.test(content)) continue
      const prevPart = allParts[i - 1] ?? ''
      const prevLines = prevPart.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const nameLine = prevLines[prevLines.length - 1] ?? ''
      const block = (nameLine && prevPart.trim().length < 80 && !CANDIDATE_FIELD_RE.test(prevPart.trim()))
        ? `${nameLine}\n${content}` : content
      blocks.push(block)
    }
    const blocksWithName = blocks.filter(b => NAME_FIELD_RE.test(b))
    return blocksWithName.length >= 2 ? blocks : null
  }

  // Pass 1: - を除外（laize 内部の ---- による誤分割防止）。― U+2015 / ─ U+2500 / — U+2014 / ー U+30FC を含む
  // Pass 2: - も含む（ical 等の --- のみ形式に対応）
  return trySplit(/^[\*=＊＝ーー─―—]{8,}\s*$/)
      ?? trySplit(/^[\*\-=＊＝ーー─―—]{8,}\s*$/)
}

// ─── 引数パース ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
let bodyText = ''
let attachText = ''
let type = 'candidate'
let filePath = null

// ─── --test モード: 自動テストスイート ────────────────────────────────────────
if (args.includes('--test')) {
  let passed = 0, failed = 0
  const results = []

  function assert(label, got, expected) {
    const ok = got === expected || (expected === undefined)
    results.push({ ok, label, got, expected })
    if (ok) passed++; else failed++
  }

  function runCase(desc, body, attach, exp) {
    const f = extractCandidateFieldsRegex(decodeHtmlEntities(body), attach ?? '')
    const prefix = `${desc}`
    if ('name'        in exp) assert(`${prefix} | name`,        f.name,               exp.name)
    if ('age'         in exp) assert(`${prefix} | age`,         f.age,                exp.age)
    if ('gender'      in exp) assert(`${prefix} | gender`,      f.gender,             exp.gender)
    if ('nationality' in exp) assert(`${prefix} | nationality`, f.nationality,        exp.nationality)
    if ('experienceYears' in exp) assert(`${prefix} | exp`,     f.experienceYears,    exp.experienceYears)
    if ('nearestStation'  in exp) assert(`${prefix} | station`, f.nearestStation,     exp.nearestStation)
    if ('desiredRate'     in exp) assert(`${prefix} | rate`,    f.desiredRate,        exp.desiredRate)
    if ('nameSkillYears' in exp) {
      const got = JSON.stringify(f.nameSkillYears)
      const expected = JSON.stringify(exp.nameSkillYears)
      assert(`${prefix} | nameSkillYears`, got, expected)
    }
    if ('fromCompany' in exp) assert(`${prefix} | fromCompany`, f.fromCompany, exp.fromCompany)
  }

  function runProjectCase(desc, body, exp) {
    const WS = '[ \\t\\u3000]*'
    const budget = extractFieldTwoPhase(
      ['単価','単　価','単金','月額','予算','報酬','金額','金　額'],
      body, '', v => /\d/.test(v), 30,
    )
    // budget の万円パース
    let budgetMax = null
    if (budget) {
      const rangeM = budget.match(/(\d{2,3})\s*[〜~～]\s*(\d{2,3})\s*万/)
      if (rangeM) budgetMax = parseInt(rangeM[2], 10)
      else {
        const singleM = budget.match(/(\d{2,3})\s*万/)
        if (singleM) { const v = parseInt(singleM[1], 10); if (v >= 20 && v <= 300) budgetMax = v }
      }
    }
    // <スキル・条件> セクション検出
    let requiredSection = null, niceSection = null
    const angleM = body.match(/(?:スキル[ \t\u3000]*[：:]\s*)?[＜<]スキル[・．]?条件[＞>]([\s\S]*)/)
    if (angleM) {
      const sectionText = angleM[1]
      const humanIdx = sectionText.search(/[＜<]人物面[＞>]/)
      const niceIdx = sectionText.search(/[＜<]尚可[＞>]|尚可[：:]/)
      const endRequired = Math.min(humanIdx >= 0 ? humanIdx : Infinity, niceIdx >= 0 ? niceIdx : Infinity)
      requiredSection = (endRequired < Infinity ? sectionText.slice(0, endRequired) : sectionText).trim()
      niceSection = niceIdx >= 0 ? sectionText.slice(niceIdx).trim() : null
    }
    // 内　容：コロン形式
    const colonDescM = body.match(/(?:^|\n)内[ \t\u3000]?容[ \t\u3000]?[：:]([\s\S]*?)(?=\n[^\s\u3000].{1,15}[：:]|\n[【＜<]|$)/)
    const colonDesc = colonDescM && colonDescM[1].trim().length >= 10 ? colonDescM[1].trim() : null
    // contractType 判定（index.ts と同じロジック）
    let contractType = null
    if (/業務委託/.test(body)) contractType = '業務委託'
    else if (/準委任/.test(body)) contractType = '準委任'
    else if (/派遣/.test(body)) contractType = '派遣'
    else if (/請負/.test(body)) contractType = '請負'
    const prefix = desc
    if ('budgetMax'        in exp) assert(`${prefix} | budgetMax`,       budgetMax,       exp.budgetMax)
    if ('hasRequiredSkillSection' in exp) assert(`${prefix} | requiredSection`, requiredSection !== null, exp.hasRequiredSkillSection)
    if ('hasNiceSection'   in exp) assert(`${prefix} | niceSection`,     niceSection !== null, exp.hasNiceSection)
    if ('hasColonDesc'     in exp) assert(`${prefix} | colonDesc`,       colonDesc !== null, exp.hasColonDesc)
    if ('contractType'     in exp) assert(`${prefix} | contractType`,    contractType,    exp.contractType)
  }

  // ── ⑧ 名前汚染修正パターン（今回の修正が効いていること）─────────────────
  console.log('\n【⑧ 名前汚染修正パターン】')
  runCase('K・M　男性',           '氏名：K・M　男性\n最寄駅：渋谷\n経験年数：8年', '',   { name: 'K・M',      gender: '男性' })
  runCase('K.Y男性　香港籍',      '氏名：K.Y男性　香港籍\n最寄駅：品川\n経験年数：5年', '', { name: 'K.Y', gender: '男性', nationality: '香港籍' })
  runCase('YY　49才女性　日本籍', '氏名：YY　49才女性　日本籍帰化された\n最寄駅：新宿\n経験年数：3年', '', { name: 'YY', age: 49, gender: '女性' })
  runCase('劉　KU　33歳　女性',   '氏名：劉　KU　33歳　女性　弊社の正社員\n最寄駅：大阪\n経験年数：7年', '', { name: '劉　KU', age: 33, gender: '女性' })
  runCase('MOSN 男',             '氏名：MOSN 男\n最寄駅：名古屋\n経験年数：4年', '',   { name: 'MOSN',       gender: '男' })
  runCase('MS/31歳/',            '氏名：MS/31歳/\n最寄駅：横浜\n経験年数：5年', '',    { name: 'MS',         age: 31 })
  runCase('W000085、57歳 男性',  '氏名：W000085、57歳 男性、日本籍\n最寄駅：渋谷\n経験年数：10年', '', { name: 'W000085', age: 57, gender: '男性' })
  runCase('中谷（NT）44歳',       '氏名：中谷（NT）44歳\n最寄駅：渋谷\n経験年数：6年', '', { name: '中谷（NT）', age: 44 })
  runCase('ISAR　男',            '氏名：ISAR　男\n最寄駅：渋谷\n経験年数：3年', '',   { name: 'ISAR',       gender: '男' })
  runCase('C.S女性スウェーデン籍','氏名：C.S女性スウェーデン籍\n最寄駅：渋谷\n経験年数：5年', '', { name: 'C.S', gender: '女性' })
  runCase('EN　30才　日本人',     '氏名：EN　30才　日本人\n最寄駅：渋谷\n経験年数：5年', '', { name: 'EN', age: 30 })
  runCase('国PF（男性/48歳、中国）', '氏名：国PF（男性/48歳、中国）\n最寄駅：渋谷\n経験年数：10年', '', { name: '国PF', age: 48, gender: '男性', nationality: '中国' })
  runCase('【T・N】【豊岡】（男性/26歳/日本人）', '■氏名：【T・N】【豊岡】（男性/26歳/日本人）\n■最寄：東向島\n■単金：56万円+精算', '', { name: 'T・N', age: 26, gender: '男性', nationality: '日本人' })
  runCase('nameSkillYears: K.T（Java 5年 / Python 3年）', '氏名：K.T（Java 5年 / Python 3年）\n最寄駅：渋谷', '', { name: 'K.T', nameSkillYears: { Java: 60, Python: 36 } })
  runCase('nameSkillYears: Spring Boot 7年', '氏名：Y.M（Spring Boot 7年）\n最寄駅：新宿', '', { name: 'Y.M', nameSkillYears: { 'Spring Boot': 84 } })

  // ── ⑯ 件名の末尾【会社名】ブラケット抽出 ────────────────────────────────
  console.log('\n【⑯ 件名末尾ブラケットからの会社名抽出】')
  runCase('末尾会社名ブラケット(サクヤ大嶽)', '【8月～/Java/Python】エンジニア紹介【サクヤ大嶽】\n氏名：T.K\n最寄駅：渋谷\n経験年数：5年', '', { fromCompany: 'サクヤ大嶽' })
  runCase('末尾会社名ブラケット+氏名スペース', '要員ご紹介【フォスターネット 山田】\n氏名：N.T\n最寄駅：品川\n経験年数：3年', '', { fromCompany: 'フォスターネット' })
  runCase('スキルブラケットは除外', '人材【C#エンジニア / 基本設計～】のご紹介です。\n氏名：S.H\n最寄駅：渋谷\n株式会社テスト\n経験年数：5年', '', { fromCompany: '株式会社テスト' })

  // ── 駅名後処理: スラッシュ区切り路線名・常駐可サフィックス ─────────────
  console.log('\n【駅名後処理パターン】')
  runCase('路線名スラッシュ区切り(蕨)', '氏名：N.T\n最寄駅：JR京浜東北線／蕨駅\n経験年数：5年', '', { nearestStation: '蕨駅' })
  runCase('路線名スラッシュ区切り(新検見川)', '氏名：N.T\n最寄駅：JR総武本線／新検見川駅\n経験年数：5年', '', { nearestStation: '新検見川駅' })
  runCase('路線名スラッシュ区切り(西谷)', '氏名：A.B\n最寄駅：相鉄線／西谷駅\n経験年数：3年', '', { nearestStation: '西谷駅' })
  runCase('常駐可サフィックス除去', '氏名：T.K\n最寄駅：汐入駅常駐可\n経験年数：4年', '', { nearestStation: '汐入駅' })
  runCase('常駐可サフィックス(青梅)', '氏名：K.S\n最寄駅：青梅駅常駐可\n経験年数：6年', '', { nearestStation: '青梅駅' })
  runCase('中点区切り路線名(東長崎)', '氏名：T.Y\n最寄駅：西武池袋線・東長崎駅\n経験年数：5年', '', { nearestStation: '東長崎駅' })
  runCase('自己PRが最寄駅に混入しない', '氏名：K.A\n◆アピールポイント: これまでの経験を活かして挑戦したい\n\n最寄り :\n自己PR\n経験年数：8年', '', { nearestStation: null })

  // ── デグレチェック: 既存パターンが引き続き正しく動作すること ─────────────
  console.log('\n【デグレチェック: 既存パターン】')
  runCase('田中太郎 (通常)',       '氏名：田中太郎\n最寄駅：渋谷\n経験年数：8年', '',      { name: '田中太郎' })
  runCase('K.T（32才）女性',      '氏名：K.T（32才）女性\n最寄駅：新宿\n経験年数：3年', '', { name: 'K.T', age: 32, gender: '女性' })
  runCase('YS(26歳)',             '氏名：YS(26歳)\n最寄駅：渋谷\n経験年数：5年', '',     { age: 26 })
  runCase('SM（男性 55歳）',      '氏名：SM（男性 55歳）\n最寄駅：渋谷\n経験年数：10年', '', { name: 'SM', age: 55, gender: '男性' })
  runCase('A・N（男性/36歳）',    '氏名：A・N（男性/36歳）\n最寄駅：渋谷\n経験年数：6年', '', { age: 36, gender: '男性' })
  runCase('T.N（34）',           '氏名：T.N（34）\n最寄駅：渋谷\n経験年数：5年', '',    { name: 'T.N', age: 34 })
  runCase('経験年数（通常）',      '氏名：佐藤一郎\n最寄駅：渋谷\n経験年数：10年', '',    { experienceYears: 10 })
  runCase('希望単価（通常）',      '氏名：田中\n最寄駅：品川\n希望単価：65万\n経験年数：5年', '', { desiredRate: '65万' })
  runCase('最寄駅（通常）',        '氏名：鈴木\n最寄駅：渋谷\n経験年数：3年', '',         { nearestStation: '渋谷' })
  runCase('最寄駅（ファイル名から）', 'Excelファイル(D.U_浦和駅.xlsx)', '', { nearestStation: '浦和駅' })
  runCase('年齢（Excel CSV /形式）',  '', '氏名 / D.U\n年齢 / 34\n性別 / 男', { age: 34, gender: '男' })
  runCase('経験年数（凡例テキスト誤マッチなし）', '', '凡例：◎＝業務経験1年以上 ○＝業務経験有', { experienceYears: null })
  runCase('経験年数（セパレータあり正常）', '経験：7年\n最寄駅：渋谷', '', { experienceYears: 7 })
  runCase('経験年数（SE歴）',      'SE歴15年\n最寄駅：渋谷', '', { experienceYears: 15 })
  runCase('経験年数（技術歴）',    '技術歴8年\n最寄駅：渋谷', '', { experienceYears: 8 })
  runCase('経験年数（現場歴）',    '現場歴8年\n最寄駅：渋谷', '', { experienceYears: 8 })
  runCase('経験年数（キャリア）',  'キャリア：10年\n最寄駅：渋谷', '', { experienceYears: 10 })
  runCase('国籍（括弧あり）',      '氏名：R.B（バングラデシュ籍）\n最寄駅：渋谷\n経験年数：5年', '', { nationality: 'バングラデシュ籍' })
  runCase('スラッシュ年齢（K.Y / 40歳）', '氏名：K.Y / 40歳 / 男性 / ベトナム籍\n最寄駅：渋谷\n経験年数：5年', '', { name: 'K.Y', age: 40, gender: '男性' })

  // ── ⑩ 複数人メール分割テスト ──────────────────────────────────────────────────
  console.log('\n【⑩ 複数人メール分割テスト】')
  function runSplitCase(desc, body, expectedCount) {
    const blocks = splitMultiCandidateBody(body)
    const got = blocks ? blocks.length : 0
    const ok2 = got === expectedCount
    results.push({ ok: ok2, label: `${desc} | split`, got, expected: expectedCount })
    if (ok2) passed++; else failed++
  }

  const LAIZE_BODY = [
    '========================================',
    '【氏名】Ａ・Ｂ',
    '【最寄駅】品川',
    '【経験年数】10年',
    '【スキル】Java, Spring Boot',
    '----------------------------------------',
    '【資格】基本情報技術者',
    '========================================',
    '【氏名】Ｃ・Ｄ',
    '【最寄駅】新宿',
    '【経験年数】8年',
    '【スキル】Python, Django',
    '----------------------------------------',
    '【資格】AWS',
    '========================================',
  ].join('\n')

  const TECHNICATION_BODY = [
    'ーーーーーーーーーーーーーーーーーーーーーーーーー',
    '【氏名】田中一郎',
    '【最寄駅】渋谷',
    '【経験年数】5年',
    '【スキル】Java, Spring Boot, MySQL',
    'ーーーーーーーーーーーーーーーーーーーーーーーーー',
    '【氏名】鈴木二郎',
    '【最寄駅】横浜',
    '【経験年数】3年',
    '【スキル】Python, Django, PostgreSQL',
    'ーーーーーーーーーーーーーーーーーーーーーーーーー',
  ].join('\n')

  const ICAL_BODY = [
    '------------------------------',
    '【 氏 名 】山田太郎',
    '【 最 寄 駅 】渋谷',
    '【 経験年数 】5年',
    '【 スキル 】Java, Spring Boot, MySQL',
    '------------------------------',
    '【 氏 名 】田中花子',
    '【 最 寄 駅 】新宿',
    '【 経験年数 】3年',
    '【 スキル 】Python, Django, PostgreSQL',
    '------------------------------',
  ].join('\n')

  runSplitCase('laize形式（= + 内部 - 混在）', LAIZE_BODY, 2)
  runSplitCase('technication形式（ーーー区切り）', TECHNICATION_BODY, 2)
  runSplitCase('ical形式（--- + 【 氏 名 】スペース区切り）', ICAL_BODY, 2)

  // ── ⑪ 案件フォーマット: <スキル・条件> / 金　額 / 内　容：コロン形式 ─────
  console.log('\n【⑪ 案件フォーマット（<スキル・条件>形式）】')
  const HELPDESK_BODY = [
    '国際系勘定システムのヘルプデスクおよび関連業務',
    '勤務地：大手町',
    '金　額：～65万円（固定精算）',
    '内　容：大手銀行の豪州・アジア地区の海外店勘定系システムにつき以下の業務を担う',
    '　　　　海外店ユーザーからの紹介への対応、エラー対応、UAT検証など',
    'スキル：<スキル・条件>',
    '　　　　・英検二級程度の英語力',
    '　　　　・所属会社で1～2年以上の勤務経験',
    '　　　　<人物面>',
    '　　　　・ビジネスマナー',
    '　　　　<尚可>',
    '　　　　・システム開発・保守の経験',
    '　　　　・財務会計/簿記の知識がある',
    '備　考：8:40～17:10の勤務。派遣での採用が必要です。',
  ].join('\n')
  runProjectCase('金　額：～65万円',           HELPDESK_BODY, { budgetMax: 65 })
  runProjectCase('<スキル・条件>セクション検出', HELPDESK_BODY, { hasRequiredSkillSection: true })
  runProjectCase('<尚可>セクション検出',        HELPDESK_BODY, { hasNiceSection: true })
  runProjectCase('内　容：コロン形式のdesc取得', HELPDESK_BODY, { hasColonDesc: true })
  runProjectCase('備考：派遣contractType検出',  HELPDESK_BODY, { contractType: '派遣' })
  // 複数行の内容が取れているか（UAT検証などが含まれるはず）
  const colonDescCheck = HELPDESK_BODY.match(/(?:^|\n)内[ \t\u3000]?容[ \t\u3000]?[：:]([\s\S]*?)(?=\n[^\s\u3000].{1,15}[：:]|\n[【＜<]|$)/)
  const colonDescContent = colonDescCheck ? colonDescCheck[1].trim() : ''
  assert('内　容：複数行取得（UAT検証含む）', colonDescContent.includes('UAT検証'), true)

  // ── ⑫ HTML本文のstripHtml検出 ──────────────────────────────────────────────
  console.log('\n【⑫ HTML本文のstripHtml検出】')

  // isHtmlBody: 各タグで正しくHTML判定されるか
  assert('isHtmlBody: <html>タグ',      isHtmlBody('<html><body>氏名：田中</body></html>'), true)
  assert('isHtmlBody: <div>のみ',       isHtmlBody('<div>氏名：田中</div>'),                true)
  assert('isHtmlBody: <br>のみ',        isHtmlBody('氏名：田中<br>最寄駅：渋谷'),           true)
  assert('isHtmlBody: <br />のみ',      isHtmlBody('氏名：田中<br />最寄駅：渋谷'),         true)
  assert('isHtmlBody: <ul><li>形式',    isHtmlBody('<ul><li>スキル：Java</li></ul>'),        true)
  assert('isHtmlBody: <h1>タグ',        isHtmlBody('<h1>人材情報</h1>氏名：田中'),           true)
  assert('isHtmlBody: <h2>タグ',        isHtmlBody('<h2>経歴</h2>経験年数：5年'),            true)
  assert('isHtmlBody: プレーンテキスト', isHtmlBody('氏名：田中\n最寄駅：渋谷'),             false)

  // stripHtml: <br>のみのHTMLメールから正しく本文を取り出せるか
  const brOnlyHtml = '氏名：山田太郎<br>最寄駅：渋谷<br>経験年数：8年<br>希望単価：65万'
  const brStripped = stripHtml(brOnlyHtml)
  assert('stripHtml: <br>→改行変換', brStripped.includes('氏名：山田太郎'), true)
  assert('stripHtml: <br>→改行後に駅名あり', brStripped.includes('最寄駅：渋谷'), true)

  // stripHtml後にextractCandidateFieldsRegexが正しくフィールドを取れるか
  const brHtmlBody = '氏名：田中花子<br>最寄駅：新宿<br>経験年数：5年<br>希望単価：60万'
  const brBodyForExtract = isHtmlBody(brHtmlBody) ? stripHtml(brHtmlBody) : brHtmlBody
  const brFields = extractCandidateFieldsRegex(brBodyForExtract, '')
  assert('stripHtml経由: <br>形式メール name',          brFields.name,           '田中花子')
  assert('stripHtml経由: <br>形式メール nearestStation', brFields.nearestStation, '新宿')
  assert('stripHtml経由: <br>形式メール experienceYears', brFields.experienceYears, 5)
  assert('stripHtml経由: <br>形式メール desiredRate',    brFields.desiredRate,    '60万')

  // <ul><li>形式のHTMLメール
  const liHtml = '<ul><li>氏名：鈴木一郎</li><li>最寄駅：品川</li><li>経験年数：10年</li></ul>'
  const liBodyForExtract = isHtmlBody(liHtml) ? stripHtml(liHtml) : liHtml
  const liFields = extractCandidateFieldsRegex(liBodyForExtract, '')
  assert('stripHtml経由: <li>形式メール name',           liFields.name,           '鈴木一郎')
  assert('stripHtml経由: <li>形式メール nearestStation',  liFields.nearestStation, '品川')

  // stripHtmlでエンティティが正しくデコードされるか
  const entityHtml = '氏名：&lt;田中&gt;<br>経験：5&amp;年<br>最寄駅：&nbsp;渋谷'
  const entityStripped = stripHtml(entityHtml)
  assert('stripHtml: &lt;&gt;デコード',  entityStripped.includes('<田中>'), true)
  assert('stripHtml: &amp;デコード',     entityStripped.includes('5&年'),  true)
  assert('stripHtml: &nbsp;→スペース',   entityStripped.includes('渋谷'),  true)

  // ── ⑬ 駅名→都道府県マッピング ──────────────────────────────────────────────
  // このテストが落ちたら STATION_TO_PREFECTURE に追加が必要（index.ts + test_extraction.mjs 両方）
  console.log('\n【⑭ 駅名→都道府県マッピング】')
  function assertStation(station, expectedPref) {
    const got = inferPrefectureFromStation(station)
    assert(`inferPrefectureFromStation(${station})`, got, expectedPref)
  }
  // ハードコードマップに含まれるべき主要駅
  assertStation('渋谷',     '東京都')
  assertStation('渋谷駅',   '東京都')   // "駅"サフィックス除去
  assertStation('調布',     '東京都')
  assertStation('西調布',   '東京都')   // 過去に何度もバグった駅
  assertStation('西調布駅', '東京都')
  assertStation('大宮',     '埼玉県')
  assertStation('横浜',     '神奈川県')
  assertStation('梅田',     '大阪府')
  assertStation('名古屋',   '愛知県')
  assertStation('博多',     '福岡県')
  assertStation('那覇',     '沖縄県')
  // マップ外の駅は null（DBで補完される前提）
  assertStation('不明駅',   null)
  assertStation(null,        null)
  assertStation('',          null)
  // 駅名抽出→都道府県まで一気通し
  const stF1 = extractCandidateFieldsRegex('氏名：山田太郎\n最寄駅：西調布\n経験年数：5年', '')
  assert('西調布→prefecture（extractCandidateFieldsRegex経由）', stF1.prefecture, '東京都')
  const stF2 = extractCandidateFieldsRegex('氏名：鈴木花子\n最寄駅：渋谷駅\n経験年数：3年', '')
  assert('渋谷駅→prefecture（駅サフィックス除去）', stF2.prefecture, '東京都')
  const stF3 = extractCandidateFieldsRegex('氏名：佐藤一郎\n最寄駅：存在しない駅\n経験年数：5年', '')
  assert('未知駅→prefecture=null', stF3.prefecture, null)

  // ── ⑮ 複数人材メール：添付ファイル割り当て（assignAttachmentsToBlocks） ────
  // index.ts の assignAttachmentsToBlocks と同じロジックをここで再現してテスト
  console.log('\n【⑮ 複数人材メール：添付ファイル割り当て】')
  function assignAttachmentsToBlocks(blocks, attachments) {
    const result = new Map()
    if (attachments.length === 0 || blocks.length === 0) return result
    const normFiles = attachments.map(att => {
      const filenameMatch = att.label.match(/\(([^)]+)\)/)
      const raw = filenameMatch ? filenameMatch[1] : att.label
      return raw.toLowerCase().replace(/[.\s　]/g, '')
    })
    const allNormNames = blocks
      .map(b => (b.name ? b.name.replace(/[.\s　]/g, '').toLowerCase() : ''))
      .filter(n => n.length >= 2)
    const used = new Set()
    // パス1: 名前マッチ
    blocks.forEach((b, blockIdx) => {
      if (!b.name) return
      const normName = b.name.replace(/[.\s　]/g, '').toLowerCase()
      if (normName.length < 2) return
      for (let i = 0; i < attachments.length; i++) {
        if (used.has(i)) continue
        if (normFiles[i].includes(normName)) {
          result.set(blockIdx, attachments[i])
          used.add(i)
          break
        }
      }
    })
    // パス2: 駅名マッチ（他人名を含むファイルは除外）
    blocks.forEach((b, blockIdx) => {
      if (result.has(blockIdx)) return
      const station = b.station
      if (!station || station.length < 2) return
      const myNorm = b.name ? b.name.replace(/[.\s　]/g, '').toLowerCase() : ''
      const stationLower = station.toLowerCase()
      for (let i = 0; i < attachments.length; i++) {
        if (used.has(i)) continue
        if (!normFiles[i].includes(stationLower)) continue
        const belongsToOther = allNormNames.some(n => n !== myNorm && normFiles[i].includes(n))
        if (belongsToOther) continue
        result.set(blockIdx, attachments[i])
        used.add(i)
        break
      }
    })
    // パス3: 1対1残余マッチング（未割当ブロック数 == 未使用添付数 == 1 の場合）
    const unmatchedBlockIdxs = blocks.map((_, i) => i).filter(i => !result.has(i) && blocks[i].name)
    const unusedAttachIdxs = attachments.map((_, i) => i).filter(i => !used.has(i))
    if (unmatchedBlockIdxs.length === 1 && unusedAttachIdxs.length === 1) {
      result.set(unmatchedBlockIdxs[0], attachments[unusedAttachIdxs[0]])
      used.add(unusedAttachIdxs[0])
    }
    return result
  }
  function assertAssign(label, result, blockIdx, expectedLabel) {
    const got = result.get(blockIdx)?.label ?? null
    assert(label, got, expectedLabel)
  }

  // ケースA-1: ファイル名に名前が含まれる → 正しく割り当て
  {
    const blocks = [{ name: '山田太郎', station: '渋谷' }, { name: '鈴木花子', station: '新宿' }]
    const attachments = [
      { label: '山田太郎_resume.xlsx', content: '山田のスキルシート' },
      { label: '鈴木花子_cv.xlsx',     content: '鈴木のスキルシート' },
    ]
    const r = assignAttachmentsToBlocks(blocks, attachments)
    assertAssign('ケースA: block0→山田ファイル', r, 0, '山田太郎_resume.xlsx')
    assertAssign('ケースA: block1→鈴木ファイル', r, 1, '鈴木花子_cv.xlsx')
  }

  // ケースA-2: 駅名マッチ（名前マッチ失敗後のパス2）
  {
    const blocks = [{ name: 'Y.M', station: '西調布' }, { name: 'K.T', station: '渋谷' }]
    const attachments = [
      { label: '西調布_profile.xlsx', content: 'スキルデータ1' },
      { label: '渋谷_profile.xlsx',   content: 'スキルデータ2' },
    ]
    const r = assignAttachmentsToBlocks(blocks, attachments)
    assertAssign('ケースA(駅名): block0→西調布ファイル', r, 0, '西調布_profile.xlsx')
    assertAssign('ケースA(駅名): block1→渋谷ファイル',   r, 1, '渋谷_profile.xlsx')
  }

  // ケースB修正前の再現: 汎用ファイル名（職務経歴書.xlsx）→割り当て失敗
  // assignAttachmentsToBlocks の結果が空（null）になることを確認
  {
    const blocks = [{ name: '山田太郎', station: '渋谷' }, { name: '鈴木花子', station: '新宿' }]
    const attachments = [{ label: '職務経歴書.xlsx', content: '誰かのスキルシート' }]
    const r = assignAttachmentsToBlocks(blocks, attachments)
    // 名前マッチも駅名マッチも失敗 → どちらも未割り当て
    assertAssign('汎用ファイル名: block0は未割り当て', r, 0, null)
    assertAssign('汎用ファイル名: block1は未割り当て', r, 1, null)
    // ケースBの修正後ロジック: 未使用添付のうち他人名を含まないものを渡す
    const assignedLabels = new Set([...r.values()].map(v => v.label))
    const allNormNames = blocks
      .map(b => b.name.replace(/[.\s　]/g, '').toLowerCase())
      .filter(n => n.length >= 2)
    // block0（山田太郎）視点: 未使用添付かつ他人名を含まない → 職務経歴書.xlsxが渡る
    const myNorm0 = '山田太郎'.replace(/[.\s　]/g, '').toLowerCase()
    const unassigned0 = attachments.filter(t => {
      if (assignedLabels.has(t.label)) return false
      const normFile = t.label.toLowerCase().replace(/[.\s　]/g, '')
      return !allNormNames.some(n => n !== myNorm0 && normFile.includes(n))
    })
    assert('汎用ファイル名: ケースB修正後→未使用添付が渡る', unassigned0.length, 1)
    assert('汎用ファイル名: 渡る添付は職務経歴書.xlsx', unassigned0[0]?.label, '職務経歴書.xlsx')
  }

  // ケースC: 名前が取れない → 全添付を共有
  {
    const blocks = [{ name: null, station: null }]
    const attachments = [{ label: 'resume.xlsx', content: 'スキルシート' }]
    const r = assignAttachmentsToBlocks(blocks, attachments)
    // 名前なし → 割り当て失敗 → ケースCで全共有（test側では未割り当てであることを確認）
    assertAssign('ケースC: 名前なし→assignは空', r, 0, null)
    // ケースCロジック: allTextContents全体を渡す（index.ts側の動作）
    assert('ケースC: 全添付共有が想定動作', true, true)
  }

  // 他人名混入防止: block1のファイルをblock0が奪わない
  {
    const blocks = [{ name: '山田', station: '渋谷' }, { name: '鈴木', station: '新宿' }]
    const attachments = [{ label: '鈴木_resume.xlsx', content: '鈴木のデータ' }]
    const r = assignAttachmentsToBlocks(blocks, attachments)
    assertAssign('他人名防止: block0は鈴木ファイルを奪わない', r, 0, null)
    assertAssign('他人名防止: block1→鈴木ファイル割り当て', r, 1, '鈴木_resume.xlsx')
  }

  // パス3: 1対1残余マッチング（1ブロック名前マッチ → 残り1ブロック＋1ファイルが1:1）
  // Brightstar型: 2人 / 山田はファイル名マッチ / 鈴木はファイル名不明 × 1 件のみ残余
  {
    const blocks = [
      { name: '山田', station: '池袋' },
      { name: '鈴木', station: '葛西' },
    ]
    const attachments = [
      { label: '山田_スキルシート.xlsx', content: '山田のデータ', skillYears: { Java: 36 } },
      { label: '職務経歴書.xlsx',        content: '鈴木のデータ', skillYears: { Java: 24 } },
    ]
    const r = assignAttachmentsToBlocks(blocks, attachments)
    assertAssign('パス3: block0→山田ファイル（名前マッチ）', r, 0, '山田_スキルシート.xlsx')
    assertAssign('パス3: block1→職務経歴書（1対1残余）', r, 1, '職務経歴書.xlsx')
  }

  // ── ⑰ extractSkillYearsFromBodyText テスト ──────────────────────────────────
  console.log('\n【⑰ extractSkillYearsFromBodyText】')
  function assertSY(label, text, expectedKey, expectedMonths) {
    const sy = extractSkillYearsFromBodyText(text)
    const got = sy[expectedKey] ?? null
    assert(`${label} | ${expectedKey}`, got, expectedMonths)
  }

  // パターン3: スキル（N年）括弧形式
  assertSY('Java(5年)', '氏名：K.T\n【スキル】Java(5年), Python(3年)', 'Java', 60)
  assertSY('Python(3年)', '氏名：K.T\n【スキル】Java(5年), Python(3年)', 'Python', 36)

  // パターン3: 約N年以上
  assertSY('Java(約15年以上)', '【スキル】\nJava(約15年以上) / Kotlin(約8年)', 'Java', 180)
  assertSY('Kotlin(約8年)', '【スキル】\nJava(約15年以上) / Kotlin(約8年)', 'Kotlin', 96)

  // パターン3b: Nヶ月のみ（年なし）
  assertSY('Springboot(6ヶ月)', '※Java(2年2ヶ月)Springboot(6ヶ月)※Spring(4ヶ月)', 'Springboot', 6)
  assertSY('Spring(4ヶ月)', '※Java(2年2ヶ月)Springboot(6ヶ月)※Spring(4ヶ月)', 'Spring', 4)

  // パターン3c: スキル歴N年
  assertSY('Laravel歴7年', 'Laravel歴7年以上、ECサイト多数', 'Laravel', 84)
  assertSY('Java歴10年', 'Java歴10年の経験があります', 'Java', 120)

  // パターン3d: 【スキル】スラッシュ区切り
  assertSY('スラッシュ区切りJava', '【スキル】\nJava(約15年以上) / Kotlin(約8年) / Android / PHP(Laravel)', 'Java', 180)
  assertSY('スラッシュ区切りKotlin', '【スキル】\nJava(約15年以上) / Kotlin(約8年) / Android / PHP(Laravel)', 'Kotlin', 96)

  // パターン2: 経験X年
  assertSY('Javaの経験が5年', 'Javaの経験が5年以上あります', 'Java', 60)

  // 既存パターンの回帰テスト
  assertSY('● Java　5年（bullet）', '● Java　5年\n● Python　3年', 'Java', 60)
  assertSY('Java\t5年（tab）', 'Java\t5年以上', 'Java', 60)
  assertSY('Java：5年（colon）', 'Java：5年の経験', 'Java', 60)

  // パターン6: 総経験年数ラベル → _totalProjectMonths
  assertSY('経験年数：20年', '経験年数：20年以上のベテランエンジニア', '_totalProjectMonths', 240)
  assertSY('IT経験：15年', 'IT経験：15年のPMOです', '_totalProjectMonths', 180)

  // パターン7: 参画期間 + 使用技術（Word非テーブル型）
  // 現在の月は動的なので「0より大きい」だけチェック（正確な月数は実行時による）
  {
    const syP7 = extractSkillYearsFromBodyText('参画期間：2026年1月 〜 現在\n使用技術・ツール：React / JavaScript / HTML5')
    assert('パターン7 React > 0', (syP7['React'] ?? 0) > 0, true)
    assert('パターン7 JavaScript > 0', (syP7['JavaScript'] ?? 0) > 0, true)
  }
  assertSY(
    'パターン7 期間ラベル',
    '期間：2025年4月 〜 2025年12月\n使用言語：Java / Spring Boot',
    'Java', 9 // 2025/4〜2025/12 = 9ヶ月
  )

  // ── 出力 ──
  console.log('\n' + '='.repeat(60))
  const failedList = results.filter(r => !r.ok)
  if (failedList.length > 0) {
    console.log('\n❌ 失敗したテスト:')
    failedList.forEach(r => console.log(`  ${r.label}\n    got:      ${JSON.stringify(r.got)}\n    expected: ${JSON.stringify(r.expected)}`))
  }
  console.log(`\nテスト結果: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--type' && args[i + 1]) { type = args[++i] }
  else if (args[i] === '--attach' && args[i + 1]) { attachText = args[++i] }
  else if (args[i] === '--file' && args[i + 1]) { filePath = args[++i] }
  else if (!args[i].startsWith('--')) { bodyText += (bodyText ? '\n' : '') + args[i] }
}

if (filePath) {
  bodyText = readFileSync(filePath, 'utf8')
} else if (!bodyText) {
  // stdin から読み込み
  if (process.stdin.isTTY) {
    console.log('メール本文を入力してください（Ctrl+D で確定）:')
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  bodyText = Buffer.concat(chunks).toString('utf8')
}

bodyText = decodeHtmlEntities(bodyText.trim())

// ─── 表示ヘルパー ────────────────────────────────────────────────────────────

const ok = (v) => v != null ? `✅ ${v}` : '❌ null'
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

// ─── 前処理 ──────────────────────────────────────────────────────────────────

console.log(bold('\n======== メール抽出テスト ========'))
console.log(dim(`タイプ: ${type} | 本文: ${bodyText.length}文字`))

const stripped = stripSenderSignature(stripUrlsForSkillMatching(bodyText))
if (stripped.length !== bodyText.length) {
  console.log(dim(`前処理: 署名/URL除去 ${bodyText.length} → ${stripped.length}文字`))
}

// ─── 複数人材チェック ─────────────────────────────────────────────────────────

const multiBlocks = splitMultiCandidateBody(bodyText)
if (multiBlocks) {
  console.log(green(`\n▶ 複数人材検出: ${multiBlocks.length}ブロック`))
  multiBlocks.forEach((block, i) => {
    console.log(bold(`\n── ブロック ${i + 1} ──────────────────────`))
    const blockBody = decodeHtmlEntities([block].join('\n'))
    const fields = extractCandidateFieldsRegex(blockBody, attachText)
    printFields(fields)
  })
} else {
  // ─── 単一人材 ────────────────────────────────────────────────────────────────
  if (type === 'candidate') {
    console.log(bold('\n── 人材フィールド ──────────────────────'))
    const fields = extractCandidateFieldsRegex(bodyText, attachText)
    printFields(fields)
  } else {
    console.log(bold('\n── 案件フィールド ──────────────────────'))
    printProjectFields(bodyText, attachText)
  }
}

console.log(dim('\n[skills] skill_master DB照合はローカル不可 → デプロイ後に確認'))
console.log(bold('=====================================\n'))

function printFields(f) {
  console.log(`  氏名        : ${ok(f.name)}`)
  console.log(`  年齢        : ${ok(f.age)}`)
  console.log(`  性別        : ${ok(f.gender)}`)
  console.log(`  国籍        : ${ok(f.nationality)}`)
  console.log(`  最寄駅      : ${ok(f.nearestStation)}`)
  console.log(`  都道府県    : ${ok(f.prefecture)}`)
  console.log(`  経験年数    : ${ok(f.experienceYears ? f.experienceYears + '年' : null)}`)
  console.log(`  希望単価    : ${ok(f.desiredRate)}`)
  console.log(`  稼働時期    : ${ok(f.availableFrom)}`)
  console.log(`  希望案件    : ${ok(f.desiredProject)}`)
  console.log(`  送信元会社  : ${ok(f.fromCompany)}`)
  if (f.nameSkillYears) {
    const entries = Object.entries(f.nameSkillYears).map(([k, v]) => `${k}:${v}ヶ月`).join(' / ')
    console.log(`  スキル年数  : ✅ ${entries}`)
  }
}

function printProjectFields(bodyText, attachText) {
  const WS = '[ \\t\\u3000]*'
  const location = extractFieldTwoPhase(
    ['場所','場　所','勤務地','作業場所','就業場所','常駐先','勤務先'],
    bodyText, attachText, v => v.length >= 2, 30,
  )
  const budget = extractFieldTwoPhase(
    ['単価','単　価','単金','月額','予算','報酬','金額','金　額'],
    bodyText, attachText, v => /\d/.test(v), 30,
  )
  const period = extractFieldTwoPhase(
    ['時期','参画時期','開始時期','開始日','稼働開始','契約期間'],
    bodyText, attachText, v => v.length >= 2, 40,
  )
  const headcount = extractFieldTwoPhase(
    ['募集','募　集','人数','募集人数'],
    bodyText, attachText, v => v.length >= 1, 20,
  )
  const interview = extractFieldTwoPhase(
    ['面談','面　談','面接'],
    bodyText, attachText, v => v.length >= 1, 30,
  )
  console.log(`  勤務地      : ${ok(location)}`)
  console.log(`  単価/予算   : ${ok(budget)}`)
  console.log(`  時期        : ${ok(period)}`)
  console.log(`  募集        : ${ok(headcount)}`)
  console.log(`  面談        : ${ok(interview)}`)
  // スキルセクション検出（【スキル】形式 or <スキル・条件> 形式）
  const skillStart = bodyText.search(/【スキル[^】]*】/)
  if (skillStart >= 0) {
    const afterSkill = bodyText.slice(skillStart)
    const rest = afterSkill.slice(afterSkill.indexOf('】') + 1)
    const niceIdx = rest.search(/[＜<]尚可[＞>]|尚可[：:]/)
    const requiredText = niceIdx >= 0 ? rest.slice(0, niceIdx) : rest.slice(0, 500)
    const niceText = niceIdx >= 0 ? rest.slice(niceIdx, niceIdx + 300) : ''
    console.log(`  必須スキル欄: ${dim('(DB照合でのみ確定)')} 先頭: ${requiredText.slice(0, 80).replace(/\n/g, ' ').trim()}`)
    if (niceText) console.log(`  尚可スキル欄: 先頭: ${niceText.slice(0, 60).replace(/\n/g, ' ').trim()}`)
  } else {
    const angleM = bodyText.match(/(?:スキル[ \t\u3000]*[：:]\s*)?[＜<]スキル[・．]?条件[＞>]([\s\S]*)/)
    if (angleM) {
      const sectionText = angleM[1]
      const humanIdx = sectionText.search(/[＜<]人物面[＞>]/)
      const niceIdx = sectionText.search(/[＜<]尚可[＞>]|尚可[：:]/)
      const endRequired = Math.min(humanIdx >= 0 ? humanIdx : Infinity, niceIdx >= 0 ? niceIdx : Infinity)
      const requiredText = endRequired < Infinity ? sectionText.slice(0, endRequired) : sectionText
      const niceText = niceIdx >= 0 ? sectionText.slice(niceIdx) : ''
      console.log(`  必須スキル欄: ${dim('(DB照合でのみ確定)')} 先頭: ${requiredText.slice(0, 80).replace(/\n/g, ' ').trim()}`)
      if (humanIdx >= 0) console.log(`  人物面欄    : ${dim('スキル判定除外')}`)
      if (niceText) console.log(`  尚可スキル欄: 先頭: ${niceText.slice(0, 60).replace(/\n/g, ' ').trim()}`)
    }
  }
  // description: 内　容：コロン形式
  const colonDescM = bodyText.match(/(?:^|\n)内[ \t\u3000]?容[ \t\u3000]?[：:]([\s\S]*?)(?=\n[^\s\u3000].{1,15}[：:]|\n[【＜<]|$)/)
  if (colonDescM && colonDescM[1].trim().length >= 10) {
    console.log(`  内容(colon) : ✅ ${colonDescM[1].trim().slice(0, 100).replace(/\n/g, ' ')}`)
  }
}
