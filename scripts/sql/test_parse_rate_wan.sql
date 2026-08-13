-- parse_rate_wan の単体テスト。
-- 旧実装は数字以外を消して連結していたため、複数の数字がある文字列で桁が壊れていた
-- （「55万円以上希望（PMOなどは67万円）」→ 5567、「80万（140～180h）」→ 80140180）。
WITH t(入力, 期待) AS (VALUES
  ('55万円以上希望（PMOなどは67万円）', 67),      -- 条件次第の高い方で予算超過を判定する
  ('80万（140～180h） ※応相談',        80),      -- 稼働時間(140/180)は「万」が付かないので混ざらない
  ('70万（140～180h）※応相談',         70),
  ('58万',                              58),
  ('65',                                65),      -- desired_rate 列の素の数値
  ('応相談',                          NULL),
  ('',                                NULL)
)
SELECT 入力,
       期待,
       parse_rate_wan(入力) AS 実際,
       CASE WHEN parse_rate_wan(入力) IS NOT DISTINCT FROM 期待::numeric
            THEN 'PASS' ELSE 'FAIL' END AS 判定
FROM t;
