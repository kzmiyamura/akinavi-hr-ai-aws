-- fetch_candidate_raw_profile から parsedGrid・aiAnalysis を除外
--
-- parsedGrid : HF Spaces 品質チェック専用（UI 未使用・数KB〜数十KB）
-- aiAnalysis : AI レスポンス丸ごとの二重保存（各フィールドはトップレベルに保存済み）
--
-- 既存レコード後方互換:
--   - availableFrom が aiAnalysis の中にしかない古いレコードは
--     aiAnalysis.availableFrom をトップレベルに昇格させて返す
--   - 新規レコードは inbound-email で最初からトップレベルに保存される

CREATE OR REPLACE FUNCTION fetch_candidate_raw_profile(p_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    -- parsedGrid と aiAnalysis を除去
    (raw_profile - 'parsedGrid' - 'aiAnalysis')
    -- 古いレコード向け: availableFrom がトップレベルになければ aiAnalysis から昇格
    || CASE
         WHEN (raw_profile->>'availableFrom') IS NULL
          AND (raw_profile->'aiAnalysis'->>'availableFrom') IS NOT NULL
         THEN jsonb_build_object('availableFrom', raw_profile->'aiAnalysis'->>'availableFrom')
         ELSE '{}'::jsonb
       END
  FROM candidates
  WHERE id = p_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION fetch_candidate_raw_profile(uuid) TO anon, authenticated;
