-- ワーカーが1人あたり何バイト「読んで」いるかを測る（2026-09-26）
-- なぜ: AI校正の egress が UPDATE 由来かという問いの確認。
--       PATCH は return=minimal で返り本文ゼロなので、出ているのは SELECT と Storage だけ。
-- 本体は返さない。octet_length だけ。
WITH sample AS (
  SELECT id, name, resume_url, raw_profile, created_at,
         desired_rate, from_company, experience_years, skills
  FROM candidates
  WHERE data_env = 'prod' AND merged_into IS NULL
    AND raw_profile->>'_llm_checked_at' IS NOT NULL
    AND created_at > now() - interval '2 days'
  LIMIT 100
)
SELECT '① DB読み: 今のselect（raw_profile丸ごと）' AS 項目,
       round(octet_length(json_agg(s)::text)/count(*)/1024.0)::text || ' KB/人' AS 値, 1 AS ord
FROM sample s
UNION ALL
SELECT '② うち attachmentText の分',
       round(sum(octet_length(COALESCE(raw_profile->>'attachmentText','')))/count(*)/1024.0)::text || ' KB/人', 2
FROM sample
UNION ALL
SELECT '③ うち text（LLMに渡す本文・必須）',
       round(sum(octet_length(COALESCE(raw_profile->>'text','')))/count(*)/1024.0)::text || ' KB/人', 3
FROM sample
UNION ALL
SELECT '④ Storage読み: 経歴書1件の平均',
       round(avg((metadata->>'size')::bigint)/1024.0)::text || ' KB/件', 4
FROM storage.objects WHERE bucket_id = 'attachments'
ORDER BY 3;
