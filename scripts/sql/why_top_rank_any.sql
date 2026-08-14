-- 画面のランキング上位が「なぜその順なのか」を任意の案件で見る。
-- 案件は :pid で渡す（psql 変数が使えないので id をベタ書きして流用する運用）。
-- 画面は verdict の段階（推せる>条件付き>未評価>見送り）で先に並べ替えてから
-- match_score を見るので、スコアだけ見ても順位が説明できない。
-- 返るのは案件あたり6行だけ（egress を使わない検証）。
WITH target AS (
  SELECT unnest(ARRAY[
    '70f20768-b072-4ca4-a96b-610e1d1624d5',
    '1b1dece1-de6c-4d75-8401-ccdafe31043c'
  ]::uuid[]) AS pid
),
ranked AS (
  SELECT
    p.title,
    p.raw_data->'aiInterpretation'->>'requiredRole' AS 要求役割,
    c.name,
    c.raw_profile->'roles'->>0 AS 主役割,
    s.match_score,
    COALESCE(s.ai_raw->'recommendation'->>'verdict', '(未評価)') AS 所見,
    role_affinity(
      p.raw_data->'aiInterpretation'->>'requiredRole',
      c.raw_profile->'roles'->>0
    ) AS 役割合致度,
    row_number() OVER (
      PARTITION BY s.project_id
      ORDER BY
        CASE s.ai_raw->'recommendation'->>'verdict'
          WHEN '推せる' THEN 0 WHEN '条件付き' THEN 1 WHEN '見送り' THEN 3 ELSE 2 END,
        s.match_score DESC
    ) AS 画面順位
  FROM target t
  JOIN submissions s ON s.project_id = t.pid AND s.data_env = 'prod'
  JOIN projects   p ON p.id = t.pid
  JOIN candidates c ON c.id = s.candidate_id
)
SELECT left(title, 16) AS 案件, 要求役割, 画面順位, name, 主役割, match_score AS 点, 役割合致度, 所見
FROM ranked WHERE 画面順位 <= 6
ORDER BY 案件, 画面順位;
