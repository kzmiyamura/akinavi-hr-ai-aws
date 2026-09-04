/**
 * 会社名の正規化。
 *
 * 送信元によって「株式会社JapanTechnology」「JapanTechnology」のように法人格の有無が
 * 揺れるため、そのまま比較すると同じ会社が別会社として扱われる。実測（2026-08-29・
 * prod 直近7日）で JapanTechnology は 78人 と 37人 に分裂しており、「同じ会社からの
 * 二重登録」の判定が効いていなかった。
 *
 * 比較のときだけ正規化する（表示は元の値のまま）。会社名そのものを書き換えると、
 * 送信元が実際に名乗っている表記が失われるため。
 */

/** 法人格の表記ゆれ。前株・後株・略記・英語表記をまとめて落とす */
const CORP_FORMS =
  /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|医療法人|\(株\)|（株）|\(有\)|（有）|㈱|㈲|Inc\.?|Corp(?:oration)?\.?|Co\.,?\s*Ltd\.?|Ltd\.?|LLC|K\.?K\.?)/gi

/**
 * 比較用のキーに変換する。
 * 法人格・空白・記号を落とし、全角英数を半角に、小文字に揃える。
 * 例) 「株式会社JapanTechnology」「JapanTechnology」「ＪａｐａｎTechnology」→ japantechnology
 */
export function normalizeCompany(value: string | null | undefined): string {
  if (!value) return ''
  return String(value)
    // 全角英数・記号を半角へ
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(CORP_FORMS, '')
    // 中黒・ハイフン・ドット・空白は表記ゆれが大きいので落とす
    .replace(/[\s　・･\-‐−ー–—.,、。･]/g, '')
    .toLowerCase()
    .trim()
}

/** 2つの会社名が同じ会社を指すか */
export function isSameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCompany(a)
  const nb = normalizeCompany(b)
  return na !== '' && na === nb
}

/**
 * 「同一人材の可能性」に並べるのは**他社のレコードだけ**にする（2026-09-05 ユーザー指示）。
 *
 * 同じ会社から同じ人が2回来ているのは「別ルートの提案」ではなく単なる二重登録で、
 * 単価も条件も同じなので営業の判断材料にならない。prod 実測（2026-09-05・正規化名が
 * 一致するペア 38,466組）では 2,241組（5.8%）が同一会社だった。
 *
 * 会社名が片方でも取れていない相手は**残す**。同社だと断定できないため
 * （同 1,760組）。落とすと本物の他社レコードまで消える。
 */
export function keepOtherCompanyOnly<T extends { from_company?: string | null }>(
  list: readonly T[],
  myCompany: string | null | undefined,
): T[] {
  return list.filter((d) => !isSameCompany(myCompany, d.from_company))
}
