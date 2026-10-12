-- 勤務地の縛りの判定を1か所に置く（2026-10-12）
--
-- ■ なぜ関数に切り出すか
--   勤務地の判定はすでに3か所にある（fetch_candidates_for_project の SQL /
--   match-batch の getRegion+extractPrefCore / archive_query の控え集計）。
--   ここに「縛り」という4つめの規則をコピーで足すと、片方だけ直したときに
--   **「画面には出ないのに提案メールには出る」**が起きる。
--   実際に同じ病気を踏んでいる: スキル一致は2026-08-12 まで JS と SQL で別実装で、
--   "C" を持つ人が「Azure Functions」に一致していた。
--   そこで判定を SQL 関数にし、呼ぶ側は条件を書かない。
--
-- ■ 判定の中身（ユーザー判断「フルリモートでない限り勤務地縛り100」）
--   落とすのは「地方が違う人」だけ。同一県・同一地方・居住地不明は残す。
--   フルリモート案件と、案件の都道府県が特定できない案件では縛らない。

-- 都道府県の表記から「大阪」「東京」のような核を取り出す。
--
-- ⚠ **京都府と北海道は最短一致では壊れる**（2026-10-12 に実測で発見）。
--   これまで使っていた `(\S+?)[都道府県]` は最短一致なので、
--     「京都府」→ 「京」＋「都」      … get_region('京') は NULL
--     「北海道」→ 「北海」＋「道」    … get_region('北海') は NULL
--   になっていた。「東京都」は「京」が文字クラス [都道府県] に入っていないので
--   偶然「東京」と取れており、他の44県も偶然正しかったため気付かれていなかった。
--   実害: prod で京都府5人・北海道12人が**自分の県の案件でも勤務地0点**。
--   京都の案件に京都の人材が一致しない（近畿の案件で特に効く）。
--   先に固有名で判定する。「東京都」は「京都」を含むので**東京を先に見る**こと。
CREATE OR REPLACE FUNCTION public.extract_pref_core(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_text, '') LIKE '%北海道%' THEN '北海道'
    WHEN COALESCE(p_text, '') LIKE '%東京%'   THEN '東京'   -- 「東京都」が下の京都に食われないよう先
    WHEN COALESCE(p_text, '') LIKE '%京都%'   THEN '京都'
    ELSE COALESCE(
      (regexp_match(COALESCE(p_text, ''), '(\S+?)[都道府県]'))[1],
      regexp_replace(
        split_part(trim(COALESCE(p_text, '')), ' ', 1),
        '(市|区|町|村|郡).*$', ''
      )
    )
  END
$$;

COMMENT ON FUNCTION public.extract_pref_core(text) IS
  '「大阪府」「東京都 千代田区」→「大阪」「東京」。京都府・北海道は最短一致で壊れるため
   固有名で先に判定する（2026-10-12）。match-batch の extractPrefCore と対';

-- 案件側の都道府県の核。正規化済みの work_prefecture を正とし、
-- 無いときだけ work_location の文字列から切り出す（fetch_candidates_for_project と同じ順序）。
CREATE OR REPLACE FUNCTION public.work_pref_core(p_work_prefecture text, p_work_location text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(trim(p_work_prefecture), '') != ''
      THEN COALESCE(NULLIF(extract_pref_core(p_work_prefecture), ''), trim(p_work_prefecture))
    ELSE extract_pref_core(p_work_location)
  END
$$;

COMMENT ON FUNCTION public.work_pref_core(text, text) IS
  '案件の都道府県の核。work_prefecture を正とし、無いときだけ work_location から切り出す';

/**
 * この候補者を、この案件の候補として残すか。
 *
 * ⚠ 真を返す条件を**増やす**ときは scripts/sql/test_location_gate.sql にケースを足すこと。
 *   ここは「候補に入るかどうか」を決めるので、緩めると通えない人が一覧に戻り、
 *   きつくすると本人に声をかけられなくなる。
 *
 * 残す理由をそれぞれ書いておく:
 *   ・縛りを外している（画面のトグル）        … 営業が意図して全員見たいとき
 *   ・フルリモート案件                        … 通勤しないので居住地は関係ない
 *   ・案件の都道府県が特定できない            … 比べる相手が無い。
 *       get_region() は47都道府県を網羅しているので NULL＝県として成立していない。
 *       勤務地が『客先（詳細は面談時）』のような案件では文字列がそのまま核になるため、
 *       空文字だけを見ると**候補が全員消える**（2026-10-12 にテストで検出）
 *   ・居住地が取れていない人材（prod 実測3.3%）… 取れていない＝通えない ではない
 *   ・同一県                                  … 満点の人
 *   ・同一地方                                … 淀屋橋に兵庫・京都から通うのは普通
 */
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
    OR COALESCE(p_cand_pref_raw, '')  = ''
    OR COALESCE(p_cand_pref_core, '') = ''
    OR p_cand_pref_core = p_work_pref_core
    OR get_region(p_cand_pref_core) = get_region(p_work_pref_core)
$$;

COMMENT ON FUNCTION public.location_gate_ok(boolean, boolean, text, text, text) IS
  '勤務地の縛り。フルリモートでない限り地方が違う人材を候補から外す。
   同一県・同一地方・居住地不明は残す。fetch_candidates_for_project と
   location_gate_candidates が共有する唯一の定義（2026-10-12）';

/**
 * 勤務地の縛りを通る人材の id。
 *
 * fetch_candidates_for_project を呼べない経路（auto-match は自前で候補集合を作る）が
 * 同じ条件で絞れるようにする。skill_hit_weights と同じ使い方を想定している。
 *
 * ⚠ 2026-10-12 時点で auto-match はまだこれを呼んでいない（app_config.auto_match_enabled
 *   が false で止まっているため）。auto-match を再開するときは必ず通すこと。
 *   通さないと「マッチング画面には出ない人が提案メールに出る」。
 */
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
   WHERE c.data_env = p_data_env
     AND c.merged_into IS NULL
     AND location_gate_ok(
           true,
           COALESCE(p_remote_policy, '') ~ 'フルリモート|完全リモート|100[%％]リモート',
           work_pref_core(p_work_prefecture, p_work_location),
           COALESCE(c.raw_profile->>'prefecture', ''),
           extract_pref_core(c.raw_profile->>'prefecture')
         )
$$;

GRANT EXECUTE ON FUNCTION public.extract_pref_core(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.work_pref_core(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.location_gate_ok(boolean, boolean, text, text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.location_gate_candidates(text, text, text, text)
  TO anon, authenticated, service_role;

-- 確認（`supabase db query -f` は最後の文の結果だけを返す）
SELECT
  extract_pref_core('大阪府')                                      AS "核_大阪府",
  work_pref_core('大阪府', '大阪府 淀屋橋')                         AS "案件核_大阪",
  work_pref_core(NULL, '客先（詳細は面談時）')                      AS "案件核_ゴミ",
  get_region(work_pref_core(NULL, '客先（詳細は面談時）')) IS NULL  AS "ゴミは県として不成立",
  location_gate_ok(true, false, '大阪', '大阪府', '大阪')            AS "同一県_true",
  location_gate_ok(true, false, '大阪', '兵庫県', '兵庫')            AS "同一地方_true",
  location_gate_ok(true, false, '大阪', '東京都', '東京')            AS "別地方_false",
  location_gate_ok(true, false, '大阪', '', '')                     AS "居住地不明_true",
  location_gate_ok(true, true,  '大阪', '東京都', '東京')            AS "フルリモート_true",
  location_gate_ok(false, false, '大阪', '東京都', '東京')           AS "縛りなし_true",
  location_gate_ok(true, false, '客先（詳細は面談時）', '東京都', '東京') AS "案件県不明_true",
  -- 最短一致で壊れていた2件（これが false だと京都・北海道の人が自県の案件から消える）
  extract_pref_core('京都府')                                      AS "核_京都府",
  extract_pref_core('東京都')                                      AS "核_東京都",
  extract_pref_core('北海道')                                      AS "核_北海道",
  location_gate_ok(true, false, work_pref_core('京都府', NULL), '京都府', extract_pref_core('京都府'))
    AS "京都案件に京都の人_true",
  location_gate_ok(true, false, work_pref_core('京都府', NULL), '大阪府', extract_pref_core('大阪府'))
    AS "京都案件に大阪の人_true（同じ近畿）",
  location_gate_ok(true, false, work_pref_core('京都府', NULL), '東京都', extract_pref_core('東京都'))
    AS "京都案件に東京の人_false",
  (SELECT count(*) FROM location_gate_candidates('prod', '大阪府', '大阪府 淀屋橋', '出社'))
    AS "大阪案件を通る人材",
  (SELECT count(*) FROM location_gate_candidates('prod', '東京都', '東京都 品川', '出社'))
    AS "東京案件を通る人材";
