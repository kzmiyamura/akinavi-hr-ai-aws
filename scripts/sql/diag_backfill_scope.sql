-- 既存データの汚れの範囲を数える（2026-08-17）
-- ① 所属会社に当社名（宛先）が入っている
-- ② 営業定型文（他にも多数おります）を含む本文で、役割が付いている
WITH c AS (
  SELECT id, name, from_company,
         raw_profile->>'from' AS mail_from,
         raw_profile->>'text' AS body,
         coalesce(raw_profile->'roles', '[]'::jsonb) AS roles
  FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL
)
SELECT '① 所属会社が当社名（株式会社ボイス等）' AS 指標, count(*)::text AS 値 FROM c
  WHERE from_company ILIKE '%ボイス%' OR from_company ILIKE '%i-voice%'
     OR from_company ILIKE '%アキナビ%' OR from_company ILIKE '%akinavi%'
UNION ALL SELECT '① 所属会社が「〜から社名変更になります」', count(*)::text FROM c
  WHERE from_company ILIKE '%社名変更%'
UNION ALL SELECT '① 所属会社に敬称が残っている（様・御中）', count(*)::text FROM c
  WHERE from_company ~ '(様|御中)$'
UNION ALL SELECT '② 定型文を含む本文の人材', count(*)::text FROM c
  WHERE body ~ '(要員|人材|エンジニア|技術者)\s*以外にも|他にも多数'
UNION ALL SELECT '②  うち役割が1つ以上ついている', count(*)::text FROM c
  WHERE (body ~ '(要員|人材|エンジニア|技術者)\s*以外にも|他にも多数')
    AND jsonb_array_length(roles) > 0
UNION ALL SELECT '②  うち定型文にある役割語がついている', count(*)::text FROM c
  WHERE (body ~ '(要員|人材|エンジニア|技術者)\s*以外にも|他にも多数')
    AND (roles ? 'ヘルプデスク' OR roles ? '運用保守' OR roles ? 'テストエンジニア')
UNION ALL SELECT '②  本文の平均文字数（転送量の見積り用）',
  coalesce(round(avg(length(body)))::text, '-') FROM c
  WHERE (body ~ '(要員|人材|エンジニア|技術者)\s*以外にも|他にも多数')
    AND jsonb_array_length(roles) > 0;
