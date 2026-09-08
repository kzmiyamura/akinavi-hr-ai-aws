-- ── fetch_candidates_for_project に人材のレベルを渡す ───────────────────────
-- 既存の定義を機械的に書き換える。手で書き直すと 20カラムの列挙を間違えて
-- 人材検索を落とす（2026-08-31 に実際に落とした）。置換できなければ例外にする。
DO $patch$
DECLARE
  src  text;
  n_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fetch_candidates_for_project';

  IF src IS NULL THEN
    RAISE EXCEPTION 'fetch_candidates_for_project が見つかりません';
  END IF;

  IF position('main_role_level' in src) > 0 THEN
    RAISE NOTICE 'fetch_candidates_for_project は適用済みです';
    RETURN;
  END IF;

  -- 主役割を取り出している行の直後に、その役割の到達レベルを足す
  n_before := (length(src) - length(replace(src, ',c.raw_profile->''roles''->>0 AS main_role', '')))
              / length(',c.raw_profile->''roles''->>0 AS main_role');
  IF n_before <> 1 THEN
    RAISE EXCEPTION '主役割の行が % 箇所見つかりました（1箇所のはず）。手で確認してください', n_before;
  END IF;

  src := replace(src,
    ',c.raw_profile->''roles''->>0 AS main_role',
    ',c.raw_profile->''roles''->>0 AS main_role'
    || E'\n      ,c.raw_profile->''_roleLevels''->>(c.raw_profile->''roles''->>0) AS main_role_level');

  IF position('role_affinity(p_required_role, pre.main_role)' in src) = 0 THEN
    RAISE EXCEPTION 'role_affinity の呼び出しが想定の形ではありません';
  END IF;

  src := replace(src,
    'role_affinity(p_required_role, pre.main_role)',
    'role_affinity(p_required_role, pre.main_role, pre.main_role_level)');

  EXECUTE src;
  RAISE NOTICE 'fetch_candidates_for_project に到達レベルを渡すようにしました';
END
$patch$;
