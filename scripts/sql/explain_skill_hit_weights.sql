-- fetch_candidates_for_project の実行時間の内訳を測る。
-- anon の statement_timeout（既定8秒）に対してどこが効いているかの切り分け用。
-- CLI は最後の文の結果しか返さないので、見たい文だけ残して実行する。
--
-- 実行: npx supabase db query --linked -f scripts/sql/explain_skill_hit_weights.sql

EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM fetch_candidates_for_project(
  'prod', ARRAY['SQL','テスト','Java','C#','基本設計','VB.net'],
  NULL, NULL, '大阪府 新大阪', NULL,
  500, 40, 15, 15, 20, 10, false,
  '大阪府', NULL,
  '{"SQL":3,"テスト":1,"Java":4,"C#":4,"基本設計":1,"VB.net":2}'::jsonb
);
