#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_fetch_candidates_selective.py — fetch_candidates_for_project の候補者の絞り込みを
「汎用スキル（誰でも持っている）だけの合致では候補にしない」に変えたマイグレーションを生成する。

gen_fetch_candidates_migration.py / gen_fetch_candidates_nice.py と同じ方式。
関数は 200 行以上あり、手で書き写すと写経ミスで配点が変わる。

使い方: python scripts/gen_fetch_candidates_selective.py <入力sql> <出力sql>
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

# ── ① 選別に使えるスキル（汎用を除いた必須スキル）を先に求める ──
old_decl = "  v_nice_len        int;"
new_decl = (
    old_decl + "\n"
    "  v_sel_skills      text[];\n"
    "  v_has_generic     boolean;"
)
assert old_decl in body, "尚可スキルの変数宣言が見つからない（先に nice のマイグレーションを当てる）"
body = body.replace(old_decl, new_decl, 1)

old_calc = "  v_is_full_remote := COALESCE(p_remote_policy,'')"
new_calc = (
    "  -- 汎用スキル（skill_master.is_generic）を除いた必須スキル。\n"
    "  -- 「基本設計」だけ合致した人を候補に残さないために使う。配点には影響しない\n"
    "  v_sel_skills  := selective_skills(p_required_skills);\n"
    "  v_has_generic := v_skills_len > 0\n"
    "                   AND COALESCE(array_length(v_sel_skills, 1), 0) < v_skills_len;\n"
    "\n" + old_calc
)
assert old_calc in body
body = body.replace(old_calc, new_calc, 1)

# ── ② 選別スキルの充足を別に取る（汎用が混ざっている案件のときだけ） ──
old_nice_cte = "  nice AS MATERIALIZED ("
new_nice_cte = (
    "  sel AS MATERIALIZED (\n"
    "    -- 汎用スキルを除いた必須スキルの充足。絞り込みにだけ使い、点数には入れない。\n"
    "    -- 汎用が混ざっていない案件では呼ばない（NULL を渡すと空集合が返る）\n"
    "    SELECT candidate_id\n"
    "      FROM skill_hit_weights(p_data_env,\n"
    "                             CASE WHEN v_has_generic THEN v_sel_skills END,\n"
    "                             NULL)\n"
    "  ),\n"
    "  nice AS MATERIALIZED ("
)
assert old_nice_cte in body, "nice CTE が無い（先に nice のマイグレーションを当てる）"
body = body.replace(old_nice_cte, new_nice_cte, 1)

old_join = "    LEFT JOIN nice ON nice.candidate_id = c.id"
new_join = (
    old_join + "\n"
    "    LEFT JOIN sel ON sel.candidate_id = c.id"
)
assert old_join in body
body = body.replace(old_join, new_join, 1)

old_nice_col = "      COALESCE(nice.nice_w, 0) AS nice_w"
new_nice_col = (
    old_nice_col + ",\n"
    "      (sel.candidate_id IS NOT NULL) AS sel_ok"
)
assert old_nice_col in body
body = body.replace(old_nice_col, new_nice_col, 1)

# ── ③ 絞り込み条件 ──
old_where = "    WHERE (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)"
new_where = (
    "    WHERE (v_skills IS NULL OR v_skills_len = 0 OR pre.hit_w > 0)\n"
    "      -- 汎用スキル（テスト・基本設計 等、全人材の4割超が持つもの）だけの合致では\n"
    "      -- 候補にしない。PowerShell 案件の上位20人中4人が PowerShell も\n"
    "      -- Azure Functions も持たず「基本設計」だけで入っていた（2026-08-13 実測）。\n"
    "      -- 必須が汎用スキルだけの案件では selective_skills が元の配列を返すので\n"
    "      -- v_has_generic が false になり、この条件は効かない\n"
    "      AND (NOT v_has_generic OR pre.sel_ok)"
)
assert old_where in body, "絞り込みの WHERE が変わった？"
body = body.replace(old_where, new_where, 1)

header = u"""-- 汎用スキルだけの合致では候補にしない（2026-08-13）
--
-- 必須スキルに「基本設計」「テスト」のような、全人材の4割超が持つ項目が入っていると、
-- 技術要件を1つも満たさない人が候補に残り、上位にも入っていた。実測（prod・open案件）:
--   化成品案件      候補1,468人のうち 632人(43%) が「基本設計」だけで残っていた
--   PowerShell案件  上位20人のうち 4人(20%) が PowerShell も Azure Functions も
--                   Microsoft 365 も EntraID も持たず「基本設計」だけで上位にいた
-- 高速モードは上位20件しか AI 採点しないので、この4人は営業が見る枠を潰していた。
--
-- 「汎用かどうか」は skill_master.is_generic（refresh_generic_skills が貼る）で判定する。
-- 分類が技術名でない（methodologies / others）かつ充足率がしきい値以上のものだけが対象で、
-- Java(47.6%) や SQL(77.3%) のような技術名は充足率が高くても対象にしない。
--
-- 変えていないこと: 配点は一切変えていない。候補に残った人の点数は従来どおり
--   （汎用スキルの合致も従来どおり加点される。絞り込みの資格判定にだけ使わない）。

"""

io.open(dst_path, "w", encoding="utf-8").write(header + body)
print("generated: " + dst_path)
