-- 勤務地の縛り: 居住地が分からない人を通さない（2026-10-31 営業の指示「求める居住地はマスト」）
--
-- 2026-10-12 の設計では「居住地不明は残す（3.3%。取れていない＝通えないではない）」だった。
-- 実際には大阪の C#.NET 案件の5位に「妙典or行徳」（千葉）の人が入り、
-- 大阪の生産管理案件では候補40人のうち22人が居住地不明だった（本番実測 2026-10-31）。
-- fetch_candidates_for_project 側で、居住地が空の人は最寄駅から県を補ってから渡す
-- （resolve_work_prefecture。妙典or行徳→千葉県）。それでも分からない人はここで落とす。
--
-- 縛らない場合は従来どおり:
--   ・p_gate=false（画面で縛りを外したとき）
--   ・フルリモート案件
--   ・案件の都道府県が取れていない案件（比べる相手が無い）
CREATE OR REPLACE FUNCTION public.location_gate_ok(
  p_gate            boolean,
  p_is_full_remote  boolean,
  p_work_pref_core  text,
  p_cand_pref_raw   text,
  p_cand_pref_core  text
)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT
    NOT COALESCE(p_gate, true)
    OR COALESCE(p_is_full_remote, false)
    OR get_region(p_work_pref_core) IS NULL
    OR (COALESCE(p_cand_pref_core, '') <> ''
        AND (p_cand_pref_core = p_work_pref_core
             OR get_region(p_cand_pref_core) = get_region(p_work_pref_core)))
$$;

COMMENT ON FUNCTION public.location_gate_ok(boolean, boolean, text, text, text) IS
  '勤務地の縛り。フルリモートでない限り、地方が違う人と居住地が分からない人を候補から外す（2026-10-31 に不明も外す）。'
  'fetch_candidates_for_project と location_gate_candidates が共有する唯一の定義';

-- auto-match 用の入口も同じ補い方にする（駅名から県を補ってから縛る）
CREATE OR REPLACE FUNCTION public.location_gate_candidates(
  p_data_env        text,
  p_work_prefecture text,
  p_work_location   text,
  p_remote_policy   text
)
RETURNS TABLE(candidate_id uuid)
LANGUAGE sql STABLE
AS $$
  SELECT c.id
    FROM candidates c
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(c.raw_profile->>'prefecture', ''),
                                        resolve_work_prefecture(c.raw_profile->>'nearestStation'), '') AS pref) p
   WHERE c.data_env = p_data_env
     AND c.merged_into IS NULL
     AND location_gate_ok(
           true,
           COALESCE(p_remote_policy, '') ~ 'フルリモート|完全リモート|100[%％]リモート',
           work_pref_core(p_work_prefecture, p_work_location),
           p.pref,
           extract_pref_core(NULLIF(p.pref, ''))
         )
$$;
