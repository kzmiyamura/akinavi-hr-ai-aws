#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_fetch_candidates_nice.py — fetch_candidates_for_project に尚可（歓迎）スキルの
加点を足したマイグレーションを、既存定義から機械的に生成する。

gen_fetch_candidates_migration.py と同じ方式。関数は 200 行近くあり手で写すと
写経ミスで配点が変わるため、直す箇所だけを置換して出力する。

使い方: python scripts/gen_fetch_candidates_nice.py <入力sql> <出力sql>
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

SIG_OLD = "text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, boolean, text, text, integer, jsonb"
SIG_NEW = SIG_OLD + ", text[]"

# ── ① 再実行できるよう新シグネチャも DROP する ──
old_drop = "DROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_OLD
assert old_drop in body, "旧シグネチャの DROP が見つからない（定義が変わった？）"
body = body.replace(
    old_drop,
    old_drop + "\nDROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_NEW,
    1,
)

# ── ② 尚可スキルを受け取るパラメータを末尾に足す ──
#    途中に挿すと位置指定で呼んでいる箇所が壊れるので必ず末尾に足す
old_param = "  p_skill_weights     jsonb   DEFAULT NULL\n)"
new_param = (
    "  p_skill_weights     jsonb   DEFAULT NULL,\n"
    "  -- 尚可（歓迎）スキル。必須の分母は増やさず、スキル比率に最大 +10% だけ乗せる\n"
    "  -- （match-batch の niceToHaveSkills と同じ扱い）\n"
    "  p_nice_skills       text[]  DEFAULT NULL\n)"
)
assert old_param in body, "パラメータ末尾の形が変わった？"
body = body.replace(old_param, new_param, 1)

# ── ③ 尚可スキルの件数を数える変数 ──
old_decl = "  v_project_has_remote boolean;"
new_decl = old_decl + "\n  v_nice_len        int;"
assert old_decl in body
body = body.replace(old_decl, new_decl, 1)

old_len = "  v_is_full_remote := COALESCE(p_remote_policy,'')"
new_len = (
    "  SELECT COUNT(*)\n"
    "    INTO v_nice_len\n"
    "    FROM unnest(COALESCE(p_nice_skills, ARRAY[]::text[])) x\n"
    "   WHERE trim(x) != '';\n"
    "\n" + old_len
)
assert old_len in body
body = body.replace(old_len, new_len, 1)

# ── ④ 尚可スキルの充足数を取る CTE。必須と同じ skill_satisfies で判定する ──
#    重みは渡さない（1件1点）。必須の hit_w とは別枠で持つ
old_hw = (
    "  ),\n"
    "  pre AS MATERIALIZED ("
)
new_hw = (
    "  ),\n"
    "  nice AS MATERIALIZED (\n"
    "    -- 尚可スキルの充足数。判定は必須と同じ skill_hit_weights（skill_satisfies）。\n"
    "    -- 重みを渡さないので1件1点になる。尚可が無いときは空集合で済ませる\n"
    "    SELECT candidate_id, hit_w AS nice_w\n"
    "      FROM skill_hit_weights(p_data_env,\n"
    "                             CASE WHEN v_nice_len > 0 THEN p_nice_skills END,\n"
    "                             NULL)\n"
    "  ),\n"
    "  pre AS MATERIALIZED ("
)
assert old_hw in body, "hw / pre の並びが変わった？"
body = body.replace(old_hw, new_hw, 1)

old_join = (
    "      (c.raw_profile->>'hakenOk')::boolean                  AS haken_ok\n"
    "    FROM candidates c\n"
    "    LEFT JOIN hw ON hw.candidate_id = c.id"
)
new_join = (
    "      (c.raw_profile->>'hakenOk')::boolean                  AS haken_ok,\n"
    "      COALESCE(nice.nice_w, 0) AS nice_w\n"
    "    FROM candidates c\n"
    "    LEFT JOIN hw ON hw.candidate_id = c.id\n"
    "    LEFT JOIN nice ON nice.candidate_id = c.id"
)
assert old_join in body, "pre CTE の JOIN の形が変わった？"
body = body.replace(old_join, new_join, 1)

# ── ⑤ スキル比率に尚可の加点を乗せる ──
#    match-batch: skillRatio = min(1, skillRatio + niceHits / nice.length * 0.1)
#    必須が0点の人にも同じように乗る（match-batch と揃える）。
#    ただし「必須を1つも満たさない人を候補に入れる」ことはしない（後段の WHERE は据え置き）
old_skill = (
    "        ROUND(CASE\n"
    "            WHEN v_skills_len = 0 OR v_total_weight = 0 THEN 20.0/40.0\n"
    "            WHEN pre.hit_w = 0                          THEN 0.0\n"
    "            ELSE LEAST(pre.hit_w / v_total_weight, 1.0)\n"
    "          END * p_weight_skill)"
)
new_skill = (
    "        ROUND(LEAST(\n"
    "            CASE\n"
    "              WHEN v_skills_len = 0 OR v_total_weight = 0 THEN 20.0/40.0\n"
    "              WHEN pre.hit_w = 0                          THEN 0.0\n"
    "              ELSE LEAST(pre.hit_w / v_total_weight, 1.0)\n"
    "            END\n"
    "            -- 尚可スキルの加点（最大 +10%）。分母は尚可の件数で、必須には影響しない\n"
    "            + CASE WHEN v_nice_len > 0\n"
    "                   THEN LEAST(pre.nice_w / v_nice_len, 1.0) * 0.1\n"
    "                   ELSE 0 END\n"
    "          , 1.0) * p_weight_skill)"
)
assert old_skill in body, "スキル配点の式が変わった？"
body = body.replace(old_skill, new_skill, 1)

# GRANT を新シグネチャに合わせる（元ファイルでは複数行に折り返されている）
old_grant = (
    "  integer, integer, integer, boolean, text, text, integer, jsonb\n"
    ") TO anon, authenticated;"
)
new_grant = (
    "  integer, integer, integer, boolean, text, text, integer, jsonb, text[]\n"
    ") TO anon, authenticated;"
)
assert old_grant in body, "GRANT の形が変わった？（折り返し位置を確認）"
body = body.replace(old_grant, new_grant, 1)

header = u"""-- 尚可（歓迎）スキルを順位付けにも反映する（2026-08-13）
--
-- 表示スコア（match-batch）は尚可スキルの充足率でスキル比率を最大 +10% 底上げしていたが、
-- 順位付けをする fetch_candidates_for_project は p_nice_skills を受け取ってすらおらず
-- 尚可を完全に無視していた。「同じ判定が3か所にあって片方だけ直っている」型の食い違いで、
-- 尚可を満たす人が順位で不利なまま画面のスコアだけ高く出ていた。
--
-- 変更点:
--   1. p_nice_skills を末尾に足す（位置指定の呼び出しを壊さないため必ず末尾）
--   2. 尚可の充足数を skill_hit_weights（判定は skill_satisfies）で取る。
--      重みは渡さないので1件1点。必須の hit_w とは別枠で持つ
--   3. スキル比率に `尚可充足率 * 0.1` を足して 1.0 で頭打ち（match-batch と同じ式）
--
-- 変えていないこと:
--   - 必須スキル・経験・単価・勤務地・リモート・派遣の配点
--   - 候補者の絞り込み条件。尚可だけ満たす人を候補に入れることはしない
--     （必須を1つも満たさない人は従来どおり返さない）

"""

io.open(dst_path, "w", encoding="utf-8").write(header + body)
print("generated: " + dst_path)
