-- ZIP添付で届いた人材の棚卸し（2026-08-17）
-- 新機能（ZIP展開）が入る前に取り込まれた人は、中のスキルシートが読まれていない。
-- 誰が対象で、いま何が欠けているのかを数える。行は返さず件数で見る。
WITH z AS (
  SELECT c.id, c.name, c.created_at, c.resume_url,
         c.raw_profile->>'attachmentNames' AS att_names,
         c.raw_profile->'skillYears' AS sy,
         c.experience_years,
         c.raw_profile->>'_llm_checked_at' AS llm_at,
         c.raw_profile->>'_llm_stage' AS llm_stage
  FROM candidates c
  WHERE c.data_env = 'prod' AND c.merged_into IS NULL
    AND c.raw_profile::text ILIKE '%.zip%'
)
SELECT 'ZIP添付が記録されている人材' AS 指標, count(*)::text AS 値 FROM z
UNION ALL SELECT '  経歴書URLあり', count(*)::text FROM z WHERE resume_url IS NOT NULL
UNION ALL SELECT '  経歴書URLなし（ZIPが読まれていない疑い）', count(*)::text FROM z WHERE resume_url IS NULL
UNION ALL SELECT '  skillYears が空', count(*)::text FROM z
  WHERE sy IS NULL OR jsonb_typeof(sy) <> 'object' OR sy = '{}'::jsonb
UNION ALL SELECT '  経験年数 null', count(*)::text FROM z WHERE experience_years IS NULL
UNION ALL SELECT '  AI校正済み', count(*)::text FROM z WHERE llm_at IS NOT NULL
UNION ALL SELECT '  最古の登録', coalesce(min(created_at)::text, '-') FROM z
UNION ALL SELECT '  最新の登録', coalesce(max(created_at)::text, '-') FROM z;
