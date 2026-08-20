-- 役割系統ヒントが何人に付くかの見積り（2026-08-20）
--
-- 条件（inferRoleFamilyHint と同じ）:
--   ① roles が空
--   ② 技術系カテゴリ（languages/frameworks/libraries/databases/dwh/clouds/infrastructures/os）
--      のスキルが3種類以上
--   ③ 本文＋添付に管理寄りの語が無い
WITH c AS (
  SELECT id,
         coalesce(raw_profile->'roles','[]'::jsonb) AS roles,
         coalesce(raw_profile->'skillsByCategory','{}'::jsonb) AS cats,
         coalesce(raw_profile->>'text','') || ' ' || coalesce(raw_profile->>'attachmentText','') AS txt
  FROM candidates WHERE data_env='prod' AND merged_into IS NULL
),
x AS (
  SELECT id,
         jsonb_array_length(roles) AS n_roles,
         (SELECT count(DISTINCT v) FROM jsonb_each(cats) e,
                 LATERAL jsonb_array_elements_text(e.value) v
           WHERE e.key IN ('languages','frameworks','libraries','databases','dwh','clouds','infrastructures','os')
         ) AS n_tech,
         txt ~ '進捗管理|課題管理|品質管理|要員管理|工数管理|ベンダーコントロール|マネジメント|折衝|取りまとめ|統括|PMO|プロジェクト[　 ]?マネージャー|管理業務' AS has_mgmt
  FROM c
)
SELECT 'prod の人材' AS 指標, count(*)::text AS 値 FROM x
UNION ALL SELECT '役割が1つも無い人', count(*)::text FROM x WHERE n_roles = 0
UNION ALL SELECT '  うち技術3件以上', count(*)::text FROM x WHERE n_roles = 0 AND n_tech >= 3
UNION ALL SELECT '  うち管理語なし（★ヒントが付く人）', count(*)::text
  FROM x WHERE n_roles = 0 AND n_tech >= 3 AND NOT has_mgmt
UNION ALL SELECT '（参考）役割が1つ以上ある人', count(*)::text FROM x WHERE n_roles > 0;
