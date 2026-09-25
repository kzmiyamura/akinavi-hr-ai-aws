-- 登録から AI校正までの間隔を測る（2026-09-26）
-- なぜ: 経歴書をローカル控えから読むようにしたが、控えの取得は15分おき。
--       ワーカーが15分より早く処理していると、控える前に Storage から落としてしまう。
--       どれだけの割合がその競合に当たるかを知りたい。
WITH c AS (
  SELECT EXTRACT(EPOCH FROM ((raw_profile->>'_llm_checked_at')::timestamptz - created_at))/60 AS lag_min
  FROM candidates
  WHERE data_env = 'prod' AND merged_into IS NULL
    AND resume_url IS NOT NULL
    AND raw_profile->>'_llm_checked_at' IS NOT NULL
    AND created_at > now() - interval '3 days'
)
SELECT '対象人数' AS 項目, count(*)::text AS 値, 1 AS ord FROM c
UNION ALL SELECT '中央値（分）', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_min))::text, 2 FROM c
UNION ALL SELECT '15分以内に校正（＝控えが間に合わない）',
  count(*) FILTER (WHERE lag_min < 15)::text || ' 件 ('
  || round(100.0*count(*) FILTER (WHERE lag_min < 15)/NULLIF(count(*),0))::text || '%)', 3 FROM c
UNION ALL SELECT '30分以内',
  count(*) FILTER (WHERE lag_min < 30)::text || ' 件 ('
  || round(100.0*count(*) FILTER (WHERE lag_min < 30)/NULLIF(count(*),0))::text || '%)', 4 FROM c
UNION ALL SELECT '1時間以内',
  count(*) FILTER (WHERE lag_min < 60)::text || ' 件 ('
  || round(100.0*count(*) FILTER (WHERE lag_min < 60)/NULLIF(count(*),0))::text || '%)', 5 FROM c
ORDER BY 3;
