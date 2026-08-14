-- role_affinity の単体テスト。期待値と食い違ったら NG 行が出る。
-- 「実装案件に PMO を出さない」「PM案件に PG を出さない」が効くかを主に見る。
WITH cases(required, candidate, expected, memo) AS (VALUES
  -- 完全一致
  ('PMO',                'PMO',                      1.0, '同一ラベル'),
  ('ヘルプデスク',       'ヘルプデスク',             1.0, '同一ラベル'),
  -- 同系統
  ('プロジェクトマネージャー', 'プロジェクトリーダー', 0.7, 'PM案件にPL＝近い'),
  ('システムエンジニア', 'プログラマー',             0.7, '実装案件にPG＝近い'),
  ('ヘルプデスク',       '運用保守',                 0.7, 'ヘルプデスク案件に運用保守'),
  -- PMO の多重所属（ユーザー指摘: 運用サポートはPMOも含む）
  ('ヘルプデスク',       'PMO',                      0.7, '運用サポート案件のPMOは落とさない'),
  ('運用保守',           'PMO',                      0.7, '同上'),
  ('プロジェクトマネージャー', 'PMO',                0.7, 'PMOはマネジメント系でもある'),
  -- 系統違い（除外ではなく低い点）
  ('システムエンジニア', 'PMO',                      0.2, '★実装案件のPMO＝今回の不具合'),
  ('プログラマー',       'プロジェクトマネージャー', 0.2, '★PM案件にPGの逆パターン'),
  ('ヘルプデスク',       'MLエンジニア',             0.2, '畑違い'),
  -- 不明は中立
  ('システムエンジニア', NULL,                       0.5, '人材側に役割なし'),
  (NULL,                 'PMO',                      0.5, '案件側に要求役割なし'),
  ('',                   'PMO',                      0.5, '空文字も不明扱い')
)
SELECT
  CASE WHEN role_affinity(required, candidate) = expected THEN 'ok' ELSE 'NG' END AS result,
  COALESCE(required, '(null)')  AS 案件が求める,
  COALESCE(candidate, '(null)') AS 人材の主役割,
  expected                      AS 期待,
  role_affinity(required, candidate) AS 実際,
  memo
FROM cases
ORDER BY result DESC, memo;
