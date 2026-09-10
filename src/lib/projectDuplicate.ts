/**
 * 案件の二重登録を登録前に見つける（#182）。
 *
 * 人材側にはメール一致・氏名＋スキルJaccardの重複判定があるが、**案件側は素の INSERT** で
 * 何のチェックも無かった。実害（prod 2026-09-08）:
 *   15:19:22  「大手銀行海外店の与信管理システムのヘルプ…」  本文694文字
 *   16:01:58  「１．大手銀行海外店の与信管理システムの照…」  本文694文字（同一本文）
 * 同じ本文を42分後に貼り直しただけで2件になる。タイトルが違うのは、同じ本文から
 * 抽出したタイトルが揺れたため。**タイトルでは検出できない**ので本文で見る。
 *
 * 一覧は select('*') で raw_data ごと読み込み済みなので、この判定に追加の問い合わせは要らない
 * （CLAUDE.md「Egress を使わずに検証する」）。読み込み済みのページにしか当たらないが、
 * 二重登録はほぼ直近に起きるので実用上そこで捕まる。
 */

/** 比較用の正規化。空白の違いと不可視文字だけの差を同一とみなす */
export function normalizeProjectText(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/[​-‍﻿]/g, '')   // ゼロ幅文字
    .replace(/\r\n?/g, '\n')
    .replace(/[\s　]+/g, ' ')
    .trim()
    // 保存側が raw_data.text を 10,000 文字で切っているので、比較もそこで揃える
    .slice(0, 10000)
}

export interface ProjectLike {
  id: string
  title: string
  created_at?: string | null
  raw_data?: Record<string, unknown> | null
}

/**
 * 同じ本文から登録済みの案件を探す。見つからなければ null。
 * 空文字どうしを「一致」にしないよう、正規化後が空なら判定しない。
 */
export function findDuplicateProjectByText<T extends ProjectLike>(
  projects: readonly T[],
  text: string | null | undefined,
): T | null {
  const target = normalizeProjectText(text)
  if (!target) return null
  for (const p of projects) {
    const stored = (p.raw_data as { text?: unknown } | null | undefined)?.text
    if (typeof stored !== 'string') continue
    if (normalizeProjectText(stored) === target) return p
  }
  return null
}
