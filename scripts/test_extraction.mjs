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
    new RegExp(`(?:${esc})(?:（[^）]{1,20}）)?[　 ]?${sep}[　 ]?([^\\n,，]{1,${maxLen}})`, 'i')
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
  '中野': '東京都', '吉祥寺': '東京都', '立川': '東京都', '八王子': '東京都',
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

function inferPrefectureFromStation(station) {
  if (!station) return null
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim()
  if (!cleaned) return null
  return STATION_TO_PREFECTURE[cleaned] ?? null
}

function sanitizeFromCompany(s) {
  if (!s) return null
  const cleaned = s.trim().replace(/[様御中殿]\s*$/, '').trim()
  return cleaned.length >= 3 ? cleaned : null
}

function extractCandidateFieldsRegex(bodyText, attachText) {
  const rawName = extractFieldTwoPhase(
    ['氏名等','氏名','名前','候補者名','お名前','フルネーム','ご氏名','氏　名'],
    bodyText, attachText,
    v => v.length >= 1 && !/^\d+$/.test(v), 40, 2,
  )
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
  if (!name) {
    const allTextForInitials = bodyText + '\n' + attachText
    const initialsPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Z][.．・][A-Z])[ 　]?[（(](\d{2})[才歳][^)）]*[）)]/m
    const initialsOnlyPat = /(?:^|\n)[ 　]*[■●◆▶◇★※▼▪→]?[ 　]?([A-Z][.．・][A-Z])(?:[ 　]|$)/m
    const imatch = allTextForInitials.match(initialsPat)
    const imatchOnly = !imatch ? allTextForInitials.match(initialsOnlyPat) : null
    if (imatch) { name = imatch[1].trim(); if (age === null) age = parseInt(imatch[2], 10) }
    else if (imatchOnly) name = imatchOnly[1].trim()
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
    const EXCLUDE_NAT = /^(在籍|本籍|戸籍|書籍|移籍|国籍|原籍|入籍|除籍|学籍|党籍|軍籍|転籍|復籍|船籍)$/
    if (natInline && !EXCLUDE_NAT.test(natInline[1])) nationality = natInline[1].trim()
  }
  let nearestStation = extractFieldTwoPhase(
    ['最寄り?駅','最寄駅','最寄り?','沿線','通勤駅'],
    bodyText, attachText,
    v => { const c = v.replace(/（[^）]*）.*$/, '').trim(); return /[駅線]$/.test(c) || c.length <= 10 },
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
    /(?:社会人歴|就労歴|通算|合計|累計|キャリア)[：:\s　]*[約]?\s*(\d+)\s*年/,
  ]) {
    const m = allTextNorm.match(p)
    if (m) { const y = parseInt(m[1], 10); if (y > 0 && y <= 50 && String(y).length < 4) { experienceYears = y; break } }
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
  const sigArea = (bodyText + '\n' + attachText).slice(-1200)
  const mPre = sigArea.match(/(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人)([\S]{2,20})/)
  if (mPre) fromCompany = sanitizeFromCompany(`${mPre[0].match(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人/)?.[0]}${mPre[1]}`)
  if (!fromCompany) {
    const mPost = sigArea.match(/([\S]{2,20})(?:株式会社|有限会社|合同会社)/)
    if (mPost) fromCompany = sanitizeFromCompany(`${mPost[1]}${mPost[0].match(/株式会社|有限会社|合同会社/)?.[0]}`)
  }

  return { name, age, gender, nationality, nearestStation, prefecture, experienceYears, desiredRate, availableFrom, desiredProject, fromCompany, nameSkillYears }
}

function splitMultiCandidateBody(body) {
  // ■氏名：形式（■●▪▶ 等のビュレット付き）も認識
  const CANDIDATE_FIELD_RE = /【[^】]{1,10}】|[◇◆][^\n：:]{1,15}[：:]|(?:^|\n)[ 　]*[■●▪▶]?[ 　]*(?:名前|氏名)[　 ]*[：:]|[■●▪▶][ 　]*(?:最寄(?:り?駅?)|希望単価|スキル|業務経験|稼働開始|稼働時期|アピール)/
  // 【 氏 名 】（半角スペース区切り形式）・■氏名：形式にも対応
  const NAME_FIELD_RE = /【[^】]{0,5}(?:氏名|お名前|名前|姓名|氏　名|氏　　名)[^】]{0,5}】|【氏[^】]{0,3}】|【[ 　]*氏[ 　]*名[ 　]*】|^[■●▪▶]?[ 　]*氏名[　 ]*[：:]|^名前[　 ]*[：:]|[◇◆]名前[　 ]*[：:]|^[■●▪▶][A-Za-zＡ-Ｚａ-ｚ.\-]{1,8}（\d+歳/m
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
