-- 1メール複数人材の AI 校正で、別人の値が混入していないかを見る（2026-08-17）
--
-- 危険な経路: apply.mjs:230 `if (list.length === 1) return list[0]`
--   AI が1人しか返さないと、名前照合なしでその値を採用する。
--   本文は6000字で切られるので（trimBodyForLlm）、長い複数人材メールでは
--   「AI から見えているのは先頭の数人だけ」になりうる。
--
-- ログは llm_shadow（candidate_id × source='body'・body_fields に AI の返した人物配列）。
WITH big AS (          -- 本文6000字超の複数人材メールに属する人
  SELECT c.id, c.name
  FROM candidates c
  WHERE c.data_env = 'prod' AND c.merged_into IS NULL
    AND length(c.raw_profile->>'text') > 6000
    AND md5(c.raw_profile->>'text') IN (
      SELECT md5(raw_profile->>'text') FROM candidates
      WHERE data_env = 'prod' AND merged_into IS NULL AND raw_profile->>'text' IS NOT NULL
      GROUP BY 1 HAVING count(*) >= 2)
),
logs AS (
  SELECT s.candidate_id, s.body_fields,
         jsonb_array_length(s.body_fields) AS n_people
  FROM llm_shadow s
  WHERE s.source = 'body' AND s.body_fields IS NOT NULL
    AND s.candidate_id IN (SELECT id FROM big)
)
SELECT '対象（6000字超メールの人材）' AS 指標, count(*)::text AS 値 FROM big
UNION ALL SELECT '  本文AIのログが残っている人', count(*)::text FROM logs
UNION ALL SELECT '  ★AIが1人しか返さなかった回（名前照合なしで採用される）',
  count(*)::text FROM logs WHERE n_people = 1
UNION ALL SELECT '  AIが2人以上返した回（名前一致しなければ不採用＝安全）',
  count(*)::text FROM logs WHERE n_people > 1
UNION ALL SELECT '  ★1人だけ返し、その名前が本人と違う（＝別人の値を適用した疑い）',
  count(*)::text FROM logs l JOIN big b ON b.id = l.candidate_id
  WHERE l.n_people = 1
    AND replace(lower(coalesce(l.body_fields->0->>'name','')), '.', '')
        <> replace(lower(b.name), '.', '')
UNION ALL SELECT '（参考）複数人材メール全体での本文AIログ件数',
  count(*)::text FROM llm_shadow WHERE source='body' AND body_fields IS NOT NULL
UNION ALL SELECT '（参考）そのうち1人だけ返した回',
  count(*)::text FROM llm_shadow WHERE source='body' AND body_fields IS NOT NULL
    AND jsonb_array_length(body_fields) = 1;
