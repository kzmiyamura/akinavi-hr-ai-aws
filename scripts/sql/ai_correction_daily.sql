-- AI校正が実際に何人/日に届いているかを日別で出す（2026-09-26）
-- なぜ: ワーカーのログの day=N/300 は候補者校正だけでなく
--       案件・解釈・推薦も同じカウンタを使う。ログの数字＝校正人数ではない。
-- 本体は返さない。日別の件数だけ。
SELECT
  to_char((raw_profile->>'_llm_checked_at')::timestamptz + interval '9 hours', 'MM/DD') AS jst_day,
  count(*)                                                     AS 校正済,
  count(*) FILTER (WHERE resume_url IS NOT NULL)               AS うち経歴書あり
FROM candidates
WHERE data_env = 'prod'
  AND raw_profile->>'_llm_checked_at' IS NOT NULL
  AND (raw_profile->>'_llm_checked_at')::timestamptz > now() - interval '8 days'
GROUP BY 1
ORDER BY 1;
