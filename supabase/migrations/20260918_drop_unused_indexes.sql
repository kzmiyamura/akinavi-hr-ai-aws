-- ============================================================================
-- DB掃除 ③-b 一度も使われていない索引を落とす
-- ============================================================================
-- 索引は「引くのは速くなるが、書くたびに更新され、容量を食う」。
-- 使われていないものは費用だけ払っている。
--
-- 根拠の確かめ方（「0回」を鵜呑みにしないため）:
--   pg_stat_database.stats_reset = リセットされていない
--   DB稼働 35.9日 / 一番使われている索引は 8,210,373回
--   → 統計は生きており、0回は「36日以上一度も使われていない」を意味する
--
-- ⚠ ただし **auto_match_enabled = false でマッチングの cron が止まっている**。
--    マッチングだけが使う索引は、要らないのではなく「動いていないから0回」の
--    可能性がある。そこで**スキル系の索引は落とさず残す**（下に理由つきで列挙）。
--    自動マッチングを再開して1週間回したあとで、もう一度測って判断する。
-- ============================================================================

-- ── 落とすもの: 同じ用途の索引が別にあって、そちらが使われているもの ────────

-- candidate_skills.skill の単純索引（1504 kB・0回）。
-- 同じ列の trgm 索引 idx_candidate_skills_skill_trgm（4136 kB・218回）が使われている。
-- スキル一致判定は語境界＋別名＋包含で行うので、完全一致の索引は出番が無い。
DROP INDEX IF EXISTS public.idx_candidate_skills_skill;

-- candidate_skills.category（1592 kB・0回）。
-- カテゴリ単独で絞る画面が無い（カテゴリ別表示は candidate_id で引いた後に
-- アプリ側で分ける。idx_candidate_skills_candidate_id は 72,245回 使われている）。
DROP INDEX IF EXISTS public.idx_candidate_skills_category;

-- candidates.prefecture の trgm（200 kB・0回）。
-- 正規化した idx_candidates_prefecture_norm（16回）が使われている。
-- 都道府県は表記ゆれを正規化してから等値で引くので、部分一致の索引は要らない。
DROP INDEX IF EXISTS public.idx_candidates_prefecture_trgm;

-- candidates_archive_light.prefecture（216 kB・0回）。
-- 同上。idx_cal_norm_prefecture（1回）が正規化版。
DROP INDEX IF EXISTS public.idx_cal_prefecture;

-- 合計 約3.4MB。小さいが、書き込みのたびの更新費用も消える。

-- ============================================================================
-- 落とさずに残すもの（0回だが、理由が「使われていない」と言い切れない）
-- ============================================================================
--   idx_candidates_skills_trgm   6000 kB / 0回
--   candidates_skills_gin        1832 kB / 0回
--     → どちらも candidates.skills 用。マッチング（fetch_candidates_for_project）と
--       人材画面のスキル絞り込みが触りうる。auto-match が止まっている今の0回は
--       「要らない」の根拠にならない。**7.8MB あるので、再開後に必ず測り直す。**
--
--   candidate_skills_pkey        5504 kB / 0回
--     → 主キー。一意性の制約そのものなので回数に関係なく落とせない。
--
--   ai_logs_pkey                 3216 kB / 5回
--     → 同上。
-- ============================================================================

-- ============================================================================
-- 戻し方（2026-09-18 の実物から取った定義）
-- ============================================================================
-- 落としたあとで「あの索引が要る」と分かったら、そのまま貼れば戻る。
--
--   CREATE INDEX idx_candidate_skills_skill
--     ON public.candidate_skills USING btree (skill);
--
--   CREATE INDEX idx_candidate_skills_category
--     ON public.candidate_skills USING btree (category);
--
--   CREATE INDEX idx_candidates_prefecture_trgm
--     ON public.candidates USING gin (((raw_profile ->> 'prefecture'::text)) gin_trgm_ops)
--     WHERE ((raw_profile ->> 'prefecture'::text) IS NOT NULL);
--
--   CREATE INDEX idx_cal_prefecture
--     ON public.candidates_archive_light USING btree (prefecture);
--
-- 本番で戻すときは CONCURRENTLY を付けて、書き込みを止めないこと。
-- ============================================================================
