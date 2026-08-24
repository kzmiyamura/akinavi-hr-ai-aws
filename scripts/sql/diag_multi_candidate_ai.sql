-- 1メール複数人材 × AI校正の安全性を測る（2026-08-17）
--
-- 懸念: AI に渡す本文は trimBodyForLlm で 6000字に切られる（shadow_worker_lib.mjs:26）。
-- 複数人材メールは全員が同じ本文（raw_profile.text＝メール全文）を持つため、
-- 6000字を超えるメールでは**後ろの人が AI から見えない**。
-- そのとき AI が1人しか返さないと pickBodyFieldsFor（apply.mjs:230）が
-- `list.length === 1` で無条件に採用してしまい、別人の値が入りうる。
--
-- ここでは「同じ本文を共有する人数」と「本文が6000字を超えるか」を数える。
WITH multi AS (
  SELECT md5(raw_profile->>'text') AS mail_key,
         count(*) AS people,
         max(length(raw_profile->>'text')) AS body_len,
         count(*) FILTER (WHERE raw_profile->>'_llm_checked_at' IS NOT NULL) AS ai_done
  FROM candidates
  WHERE data_env = 'prod' AND merged_into IS NULL
    AND raw_profile->>'text' IS NOT NULL
  GROUP BY 1
  HAVING count(*) >= 2
)
SELECT '複数人材メールの通数' AS 指標, count(*)::text AS 値 FROM multi
UNION ALL SELECT '  対象人数の合計', coalesce(sum(people),0)::text FROM multi
UNION ALL SELECT '  うち本文6000字超（AIから後ろの人が見えない）通数',
  count(*)::text FROM multi WHERE body_len > 6000
UNION ALL SELECT '  ↑その人数合計', coalesce(sum(people),0)::text FROM multi WHERE body_len > 6000
UNION ALL SELECT '  ↑うちAI校正済みの人数', coalesce(sum(ai_done),0)::text FROM multi WHERE body_len > 6000
UNION ALL SELECT '最大人数のメール（人数）', coalesce(max(people),0)::text FROM multi
UNION ALL SELECT '最長本文（字）', coalesce(max(body_len),0)::text FROM multi;
