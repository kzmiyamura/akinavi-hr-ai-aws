-- 同一人物候補検索 RPC
-- 名前の表記ゆれ（ピリオド・スペース・全角スペース・中点・ハイフン）を除去して同名候補を返す
-- フロント側でスコアリングを行い重複候補として表示する

CREATE OR REPLACE FUNCTION find_duplicate_candidates(
  p_name       text,
  p_exclude_id uuid,
  p_data_env   text
)
RETURNS TABLE (
  id               uuid,
  name             text,
  email            text,
  raw_profile      jsonb,
  skills           jsonb,
  experience_years numeric,
  desired_rate     text,
  from_company     text,
  duplicate_flag   boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.name,
    c.email,
    c.raw_profile,
    c.skills,
    c.experience_years,
    c.desired_rate,
    c.from_company,
    c.duplicate_flag
  FROM candidates c
  WHERE c.data_env    = p_data_env
    AND c.id         != p_exclude_id
    AND regexp_replace(upper(c.name), '[. \-　・ー]', '', 'g')
      = regexp_replace(upper(p_name), '[. \-　・ー]', '', 'g')
  ORDER BY c.created_at DESC
  LIMIT 10;
$$;
