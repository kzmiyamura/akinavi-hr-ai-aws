-- 大阪の通知ルールが1件も飛んでいない件の診断（2026-08-17）
-- ルール: station_keyword='大阪府' / skill_keywords={C#, Java, AS/400, AS400}
-- 判定は match.ts の matchesRule と同じく「駅+都道府県の連結に部分一致」「スキルは AND」。
-- 行は返さず件数だけを返す（egress 対策）。
WITH win AS (
  SELECT id, name, skills,
         coalesce(raw_profile->>'nearestStation','') || ' ' || coalesce(raw_profile->>'prefecture','') AS station
  FROM candidates
  WHERE data_env = 'prod'
    AND merged_into IS NULL
    AND (created_at > now() - interval '24 hours' OR updated_at > now() - interval '24 hours')
),
osaka AS (
  SELECT * FROM win WHERE station ILIKE '%大阪府%'
)
SELECT '直近24hの人材' AS 指標, count(*)::text AS 値 FROM win
UNION ALL SELECT '  うち駅/県に「大阪府」を含む', count(*)::text FROM osaka
UNION ALL SELECT '  うち駅/県に「大阪」を含む（府なし表記も拾う）',
  count(*)::text FROM win WHERE station ILIKE '%大阪%'
UNION ALL SELECT '大阪府かつ C# 保有', count(*)::text FROM osaka
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(s) LIKE '%c#%')
UNION ALL SELECT '大阪府かつ Java 保有', count(*)::text FROM osaka
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(s) LIKE '%java%')
UNION ALL SELECT '大阪府かつ AS400 系 保有', count(*)::text FROM osaka
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(replace(s,'/','')) LIKE '%as400%')
UNION ALL SELECT '★大阪府かつ 4条件すべて（＝現ルールが要求している条件）', count(*)::text FROM osaka
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(s) LIKE '%c#%')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(s) LIKE '%java%')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(s) LIKE '%as/400%')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s WHERE lower(s) LIKE '%as400%')
UNION ALL SELECT '★大阪府かつ いずれか1つ（＝OR にした場合）', count(*)::text FROM osaka
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(skills) s
                WHERE lower(s) LIKE '%c#%' OR lower(s) LIKE '%java%'
                   OR lower(replace(s,'/','')) LIKE '%as400%')
UNION ALL SELECT '通知ログの累計', count(*)::text FROM notification_log
UNION ALL SELECT '人材全体（prod）で「大阪」を含む', count(*)::text FROM candidates
  WHERE data_env='prod' AND merged_into IS NULL
    AND (coalesce(raw_profile->>'nearestStation','') || ' ' || coalesce(raw_profile->>'prefecture','')) ILIKE '%大阪%';
