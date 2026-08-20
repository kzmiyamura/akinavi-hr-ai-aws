-- 役割の妥当性調査 その3: 根拠が本文か添付か（2026-08-19）
--
-- 仮説: 「運用保守」は経歴書の**担当工程欄**（要件定義/基本設計/…/運用保守）に必ず並ぶ語。
-- 本人の役割ではなく工程の1つとして書かれているだけなのに役割として拾っている疑い。
-- 本文（営業が人を説明する文）に出ていれば本人の役割の可能性が高く、
-- 添付にしか出ていなければ工程欄の巻き添えの可能性が高い。
WITH c AS (
  SELECT id,
         coalesce(raw_profile->>'text','') AS body,
         coalesce(raw_profile->>'attachmentText','') AS att,
         coalesce(raw_profile->'roles','[]'::jsonb) AS roles
  FROM candidates WHERE data_env='prod' AND merged_into IS NULL
)
SELECT '運用保守が付いている人' AS 指標, count(*)::text AS 値 FROM c WHERE roles ? '運用保守'
UNION ALL SELECT '  本文に「運用保守/運用管理」がある', count(*)::text FROM c
  WHERE roles ? '運用保守' AND body ~ '運用[　 ]?(保守|管理)'
UNION ALL SELECT '  ★添付にしかない（工程欄の巻き添えの疑い）', count(*)::text FROM c
  WHERE roles ? '運用保守' AND body !~ '運用[　 ]?(保守|管理)' AND att ~ '運用[　 ]?(保守|管理)'
UNION ALL SELECT '  どちらにも無い（別経路で付与）', count(*)::text FROM c
  WHERE roles ? '運用保守' AND body !~ '運用[　 ]?(保守|管理)' AND att !~ '運用[　 ]?(保守|管理)'
UNION ALL SELECT '── PMO ──', ''
UNION ALL SELECT 'PMOが付いている人', count(*)::text FROM c WHERE roles ? 'PMO'
UNION ALL SELECT '  本文にPMOがある', count(*)::text FROM c
  WHERE roles ? 'PMO' AND body ~ 'PMO'
UNION ALL SELECT '  ★添付にしかない', count(*)::text FROM c
  WHERE roles ? 'PMO' AND body !~ 'PMO' AND att ~ 'PMO'
UNION ALL SELECT '── ヘルプデスク ──', ''
UNION ALL SELECT 'ヘルプデスクが付いている人', count(*)::text FROM c WHERE roles ? 'ヘルプデスク'
UNION ALL SELECT '  本文にある', count(*)::text FROM c
  WHERE roles ? 'ヘルプデスク' AND body ~ 'ヘルプ[　 ]?デスク|サービス[　 ]?デスク|ユーザー[　 ]?サポート'
UNION ALL SELECT '  ★添付にしかない', count(*)::text FROM c
  WHERE roles ? 'ヘルプデスク' AND body !~ 'ヘルプ[　 ]?デスク|サービス[　 ]?デスク|ユーザー[　 ]?サポート'
    AND att ~ 'ヘルプ[　 ]?デスク|サービス[　 ]?デスク|ユーザー[　 ]?サポート';
