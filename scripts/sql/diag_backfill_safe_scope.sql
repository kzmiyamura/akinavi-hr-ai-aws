-- 役割の再計算を「やっても壊れない範囲」に絞る（2026-08-17）
--
-- 除外する理由:
--  ・複数人材メール: raw_profile.text はメール全文なので、再計算すると
--    他人の記述まで本人の役割になる（今より悪化する）
--  ・経歴書あり: 元の役割は本文＋添付から出しており、本文だけで再計算すると
--    添付由来の正しい役割まで消える
WITH grp AS (
  SELECT md5(raw_profile->>'text') AS k, count(*) AS n
  FROM candidates WHERE data_env='prod' AND merged_into IS NULL AND raw_profile->>'text' IS NOT NULL
  GROUP BY 1
),
c AS (
  SELECT c.id, c.resume_url, c.raw_profile->>'text' AS body,
         coalesce(c.raw_profile->'roles','[]'::jsonb) AS roles,
         g.n AS people_in_mail
  FROM candidates c JOIN grp g ON g.k = md5(c.raw_profile->>'text')
  WHERE c.data_env='prod' AND c.merged_into IS NULL
    AND c.raw_profile->>'text' ~ '(要員|人材|エンジニア|技術者)\s*以外にも|他にも多数'
    AND jsonb_array_length(coalesce(c.raw_profile->'roles','[]'::jsonb)) > 0
)
SELECT '定型文あり・役割あり（全体）' AS 指標, count(*)::text AS 値 FROM c
UNION ALL SELECT '  うち複数人材メール（再計算しない）', count(*)::text FROM c WHERE people_in_mail > 1
UNION ALL SELECT '  うち経歴書あり（再計算しない）', count(*)::text FROM c WHERE people_in_mail = 1 AND resume_url IS NOT NULL
UNION ALL SELECT '★ 安全に再計算できる件数（単独メール・添付なし）', count(*)::text FROM c
  WHERE people_in_mail = 1 AND resume_url IS NULL
UNION ALL SELECT '   ↑の本文合計サイズ(KB)',
  coalesce(round(sum(length(body))/1024.0)::text, '0') FROM c
  WHERE people_in_mail = 1 AND resume_url IS NULL;
