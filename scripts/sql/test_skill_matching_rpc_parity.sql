-- 判定の「定義」と「実体」が食い違っていないかを実データで確認する（2026-08-12）
--
-- 定義: skill_satisfies(候補者スキル, 必須スキル) … 1件ずつ判定する読める形
-- 実体: skill_hit_weights(...)                  … マッチングが実際に使う集合演算版
-- 実体は性能のため別に書き下しているので、片方だけ直すと単体テストは通るのに
-- 本番の順位だけずれる。prod の必須スキルごとに、候補に残る人の集合が一致することを確認する。
--
-- 実行: npx supabase db query --linked -f scripts/sql/test_skill_matching_rpc_parity.sql
-- 期待: 「結果」が全て PASS（実体のみ・定義のみ が 0人）
--
-- 注: 定義側を全候補者×全スキルで回すと statement timeout になるため、
--     「どちらかが true になり得る組」＝候補者スキルが必須スキルを文字として含むか、
--     正規化後が一致するか、包含関係がある組 に絞って評価している。
--     この外側は両方 false になるしかないので、絞っても検出力は落ちない。

WITH req AS (
  SELECT DISTINCT lower(trim(s)) AS q
    FROM projects p, jsonb_array_elements_text(p.required_skills) s
   WHERE p.data_env = 'prod' AND trim(s) != ''
),
cs AS MATERIALIZED (
  SELECT DISTINCT lower(trim(s.value)) AS s
    FROM candidates c CROSS JOIN LATERAL jsonb_array_elements_text(c.skills) s(value)
   WHERE c.data_env = 'prod' AND c.merged_into IS NULL
     AND c.duplicate_flag = false AND trim(s.value) != ''
),
-- 定義側で「必須スキルを満たす」と判定されたスキル表記
ok_skill AS (
  SELECT req.q, cs.s
    FROM req JOIN cs
      ON cs.s LIKE '%' || req.q || '%'
      OR skill_canon(cs.s) = skill_canon(req.q)
      OR EXISTS (SELECT 1 FROM skill_implications i
                  WHERE i.child = skill_canon(cs.s) AND i.parent = skill_canon(req.q))
   WHERE skill_satisfies(cs.s, req.q)
),
-- 候補者ごとに「定義側で満たしている必須スキルの数」
def AS (
  SELECT c.id, count(DISTINCT ok_skill.q) AS n
    FROM candidates c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.skills) s(value)
    JOIN ok_skill ON ok_skill.s = lower(trim(s.value))
   WHERE c.data_env = 'prod' AND c.merged_into IS NULL AND c.duplicate_flag = false
   GROUP BY c.id
),
-- 実体側。重みを渡さなければ hit_w = 満たした必須スキルの件数になる
act AS (
  SELECT h.candidate_id AS id, h.hit_w AS n
    FROM skill_hit_weights('prod', ARRAY(SELECT q FROM req), NULL) h
),
cmp AS (
  SELECT COALESCE(act.id, def.id) AS id,
         COALESCE(act.n, 0) AS 実体, COALESCE(def.n, 0) AS 定義
    FROM act FULL OUTER JOIN def ON def.id = act.id
)
SELECT CASE WHEN count(*) FILTER (WHERE 実体 != 定義) = 0 THEN 'PASS' ELSE '★FAIL' END AS 結果,
       count(*)                                   AS 突き合わせた候補者,
       count(*) FILTER (WHERE 実体 != 定義)         AS 食い違い,
       count(*) FILTER (WHERE 実体 > 定義)          AS 実体の方が多い,
       count(*) FILTER (WHERE 実体 < 定義)          AS 定義の方が多い
  FROM cmp;
