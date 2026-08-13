#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_fetch_candidates_migration.py — fetch_candidates_for_project の新しいマイグレーションを
既存定義から機械的に生成する。

この関数は 200 行近くあり、手で書き写すと写経ミスで配点が変わる。
直したい箇所だけを置換して出力する。

使い方: python scripts/gen_fetch_candidates_migration.py <入力sql> <出力sql>
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

# 関数定義の本体だけを取り出す（DROP 行から GRANT の直前まで）
start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

# ── ① 単価の読み取りを parse_rate_wan に置き換える ──
old_rate = (
    "NULLIF(REGEXP_REPLACE(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, ''), "
    "'[^0-9.]', '', 'g'), '')::numeric AS rate_val"
)
new_rate = (
    "parse_rate_wan(COALESCE(c.raw_profile->>'desiredRate', c.desired_rate::text, '')) AS rate_val"
)
assert old_rate in body, "単価パースの行が見つからない（定義が変わった？）"
body = body.replace(old_rate, new_rate)

# ── ② 派遣案件の可否を受け取るパラメータを足す ──
old_param = "  p_require_haken     boolean DEFAULT false,"
new_param = (
    "  p_require_haken     boolean DEFAULT false,\n"
    "  -- 案件の契約形態。'派遣' のとき人材側の hakenOk で加減点する（match-batch と同じ扱い）\n"
    "  p_contract_type     text    DEFAULT NULL,"
)
assert old_param in body
body = body.replace(old_param, new_param, 1)

# 旧シグネチャの DROP に加えて、新シグネチャも消しておく（再実行できるように）
body = body.replace(
    "DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);",
    "DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, integer, jsonb);\n"
    "DROP FUNCTION IF EXISTS fetch_candidates_for_project(text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb);",
)

# ── ③ hakenOk を pre CTE に持ち上げる ──
old_hit = "      COALESCE(hw.hit_w, 0) AS hit_w"
new_hit = (
    "      COALESCE(hw.hit_w, 0) AS hit_w,\n"
    "      (c.raw_profile->>'hakenOk')::boolean                  AS haken_ok"
)
assert old_hit in body
body = body.replace(old_hit, new_hit, 1)

# ── ④ 派遣案件の加減点を rule_score に反映する ──
old_tail = "      ) AS rule_score"
new_tail = (
    "      )\n"
    "      -- 派遣案件の加減点。表示スコア（match-batch）にだけ入っていて順位に反映されず、\n"
    "      -- 「派遣NGなのに上位」「常駐可なのに順位が上がらない」が起きていた（2026-08-13）\n"
    "      + CASE WHEN p_contract_type = '派遣' AND pre.haken_ok = true THEN 5 ELSE 0 END\n"
    "      AS rule_score_raw"
)
assert old_tail in body
body = body.replace(old_tail, new_tail, 1)

# scored を参照している箇所で上限を適用する
old_top = (
    "    SELECT id, rule_score, created_at\n"
    "      FROM scored"
)
new_top = (
    "    SELECT id,\n"
    "           -- 派遣NGの人は派遣案件で 20pt 上限（match-batch と同じ）\n"
    "           CASE WHEN p_contract_type = '派遣' AND haken_ok = false\n"
    "                THEN LEAST(rule_score_raw, 20) ELSE LEAST(rule_score_raw, 100) END AS rule_score,\n"
    "           created_at\n"
    "      FROM scored"
)
assert old_top in body, "top CTE の形が変わった？"
body = body.replace(old_top, new_top, 1)

# scored CTE に haken_ok を残す（top で参照するため）
old_scored_head = "    SELECT\n      pre.id,\n      pre.created_at,"
new_scored_head = "    SELECT\n      pre.id,\n      pre.created_at,\n      pre.haken_ok,"
assert old_scored_head in body
body = body.replace(old_scored_head, new_scored_head, 1)

header = u"""-- fetch_candidates_for_project を順位付けと表示スコアで揃える（2026-08-13）
--
-- 画面に出るスコアは match-batch が計算し、候補者の絞り込みと順位付けはこの関数が行う。
-- 両者の配点が揃っておらず「順位は上なのにスコアが低い」「数が合わない」が起きていた。
-- ここでは順位付け側に残っていた次の食い違いを潰す。
--
-- ① 希望単価の読み取りが壊れていた（最重要）
--    REGEXP_REPLACE(desiredRate,'[^0-9.]','','g') は数字以外を消して**連結**するため、
--    「55万円以上希望（PMOなどは67万円）」→ 5567、「80万（140～180h）」→ 80140180 になり、
--    予算超過扱いで単価が 0点になっていた。parse_rate_wan で「万」単位の金額だけを読み、
--    複数あるときは最大値を採る（条件次第の高い方で予算超過を判定する）
-- ② 派遣案件の加減点が順位に入っていなかった
--    match-batch は「派遣NG→20pt上限」「常駐可→+5pt」を掛けているのに、順位側は無視。
--    p_contract_type を受け取って同じ扱いにする
--
-- 配点そのもの（スキル・経験・勤務地・リモートの各係数）は変更していない。

-- 「万」単位の希望単価を読む。複数あるときは最大値。
-- match-batch の parseRateWan と同じ規則にすること（片方だけ直すと順位と表示がズレる）。
CREATE OR REPLACE FUNCTION public.parse_rate_wan(p_text text)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(
    (SELECT MAX((m[1])::numeric)
       FROM regexp_matches(COALESCE(p_text, ''), '(\\d+(?:\\.\\d+)?)\\s*万', 'g') m
      WHERE (m[1])::numeric > 0 AND (m[1])::numeric <= 500),
    -- 「万」が付かない純粋な数値（desired_rate 列の値など）はそのまま採る
    (CASE WHEN COALESCE(p_text, '') ~ '^\\s*\\d+(\\.\\d+)?\\s*$'
          THEN trim(p_text)::numeric END)
  )
$$;

COMMENT ON FUNCTION public.parse_rate_wan(text) IS
  '希望単価文字列から万単位の金額を読む。複数あれば最大値。match-batch の parseRateWan と対';

GRANT EXECUTE ON FUNCTION public.parse_rate_wan(text) TO anon, authenticated, service_role;

"""

io.open(dst_path, "w", encoding="utf-8").write(header + body)
print("generated: " + dst_path)
