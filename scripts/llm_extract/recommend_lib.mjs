// 提案所見（案件×候補者）の共通部品。
// recommend.mjs（手動CLI）と shadow_worker.mjs（キュー）の両方が使う。
// AIに渡すテキストの作り方が2か所に分かれると、同じペアでも結果が食い違うためここに集約する。

/** 案件をAIに渡すテキストに整える。本文があれば本文が正（項目は抽出済みの再掲） */
export function projectText(p) {
  const rd = p.raw_data ?? {}
  const head = [
    `案件名: ${p.title ?? ''}`,
    p.client ? `クライアント: ${p.client}` : null,
    `必須スキル: ${((p.required_skills ?? [])).join('、') || 'なし'}`,
    rd.niceToHaveSkills?.length ? `尚可スキル: ${rd.niceToHaveSkills.join('、')}` : null,
    p.work_location ? `勤務地: ${p.work_location}` : null,
    p.remote_policy ? `リモート: ${p.remote_policy}` : null,
    p.contract_type ? `契約形態: ${p.contract_type}` : null,
    p.budget_max != null ? `単価上限: ${p.budget_max}万円` : null,
  ].filter(Boolean).join('\n')
  const body = String(rd.text ?? '')
  return body.length > 50 ? `${head}\n\n--- 元メール本文 ---\n${body}` : head
}

/** 候補者をAIに渡すテキストに整える。経歴本文があればそれを使う */
export function candidateText(c) {
  const rp = c.raw_profile ?? {}
  const head = [
    `氏名: ${c.name ?? ''}`,
    c.experience_years != null ? `総経験年数: ${c.experience_years}年` : null,
    c.desired_rate ? `希望単価: ${c.desired_rate}` : null,
    c.from_company ? `所属: ${c.from_company}` : null,
    `保有スキル: ${((c.skills ?? [])).join('、') || 'なし'}`,
  ].filter(Boolean).join('\n')
  const body = String(rp.attachmentText ?? rp.text ?? '')
  return body.length > 50 ? `${head}\n\n--- 経歴書・メール本文 ---\n${body}` : head
}

/** ai_raw.recommendation に書く形。所見が出せなかったときも印（at + skipped）を書く。
    印が無いとキューが同じペアを永久に拾い続ける */
export function buildRecommendationRecord(r) {
  if (!r?.pitch) {
    return { at: new Date().toISOString(), skipped: '出力不能（pitch なし）' }
  }
  return {
    at: new Date().toISOString(),
    model: r.model,
    required: r.required, verdict: r.verdict, pitch: r.pitch,
    strengths: r.strengths, gaps: r.gaps, confidence: r.confidence,
  }
}
