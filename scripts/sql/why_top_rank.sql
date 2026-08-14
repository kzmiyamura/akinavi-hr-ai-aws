-- 画面のランキング上位が「なぜその順なのか」を submissions 側から見る。
-- 画面は verdict の段階（推せる>条件付き>未評価>見送り）で先に並べ替えてから
-- match_score を見るので、スコアだけ見ても順位が説明できない。
-- 返るのは8行だけ（egress を使わない検証）。
SELECT
  row_number() OVER (
    ORDER BY
      CASE s.ai_raw->'recommendation'->>'verdict'
        WHEN '推せる'   THEN 0
        WHEN '条件付き' THEN 1
        WHEN '見送り'   THEN 3
        ELSE 2
      END,
      s.match_score DESC
  ) AS 画面順位,
  c.name,
  c.raw_profile->'roles'->>0                        AS 主役割,
  s.match_score                                     AS 保存スコア,
  COALESCE(s.ai_raw->'recommendation'->>'verdict', '(未評価)') AS 所見,
  role_affinity(
    (SELECT raw_data->'aiInterpretation'->>'requiredRole'
       FROM projects WHERE id = s.project_id),
    c.raw_profile->'roles'->>0
  )                                                 AS 役割合致度
FROM submissions s
JOIN candidates c ON c.id = s.candidate_id
WHERE s.project_id = '3d378a6f-b730-4091-ab57-a88621b4b0a0'
  AND s.data_env = 'prod'
ORDER BY 画面順位
LIMIT 8;
