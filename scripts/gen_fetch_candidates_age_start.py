#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""
gen_fetch_candidates_age_start.py — fetch_candidates_for_project に
「年齢の上限」と「稼働を案件の開始日で比べる」を足したマイグレーションを、既存定義から機械的に生成する。

背景と部品は supabase/migrations/20261125_1_age_and_start_gate_helpers.sql（#192）。
同じ方式の前例: gen_fetch_candidates_years_must.py（関数は370行あり、手で写すと配点が変わる）。

使い方:
  python scripts/gen_fetch_candidates_age_start.py \
    supabase/migrations/20261031_3_fetch_candidates_years_must.sql \
    supabase/migrations/20261031_4_top_match_marks_years_must.sql \
    supabase/migrations/20261125_2_fetch_candidates_age_start.sql \
    supabase/migrations/20261125_3_top_match_marks_start.sql
"""
import io
import sys

rpc_src, marks_src, rpc_dst, marks_dst = sys.argv[1:5]

SIG_OLD = ("text, text[], numeric, numeric, text, text, integer, integer, integer, integer, integer, integer, "
           "boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean, jsonb")
SIG_NEW = SIG_OLD + ", date"


def make_sub(holder):
    def sub(old, new, what):
        assert holder[0].count(old) == 1, u"%s が見つからない／複数ある（定義が変わった？）" % what
        holder[0] = holder[0].replace(old, new, 1)
    return sub


# ================================================================ RPC
s = io.open(rpc_src, encoding="utf-8").read()
h = [s[s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project"):]]
sub = make_sub(h)

old_drop = "DROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_OLD
sub(old_drop, old_drop + "\nDROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_NEW, u"最新シグネチャの DROP")

sub("  p_required_skill_years jsonb DEFAULT NULL\n)",
    "  p_required_skill_years jsonb DEFAULT NULL,\n"
    "  -- 案件の開始日（projects.start_date）。「今出せる人」の稼働を max(今日, これ) と比べる（#192）。\n"
    "  -- NULL なら今日（従来どおり）\n"
    "  p_start_date        date    DEFAULT NULL\n)",
    u"p_required_skill_years の引数定義")

sub("  v_has_generic     boolean;\n",
    "  v_has_generic     boolean;\n"
    "  v_age_max         integer;\n",
    u"DECLARE")

sub("  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';\n",
    "  v_is_full_remote := COALESCE(p_remote_policy,'') ~ 'フルリモート|完全リモート|100[%％]リモート';\n"
    "  -- 必須欄の「43歳以下」等を年齢の上限として読む（#192）。スキルとしての照合はそのまま\n"
    "  -- （誰も満たさないので全員同じだけ減点＝順位は変わらない。match-batch と点数を揃えるため触らない）\n"
    "  v_age_max := required_age_max(p_required_skills);\n",
    u"v_is_full_remote の代入")

sub("      ,parse_available_from(c.raw_profile->>'availableFrom') AS avail_date\n",
    "      ,parse_available_from(c.raw_profile->>'availableFrom') AS avail_date\n"
    "      ,c.raw_profile->>'age' AS age_raw\n",
    u"avail_date の列")

sub("      AND offerable_ok(p_offerable_only, pre.flow_raw, pre.has_resume, pre.avail_date)\n",
    "      -- 稼働は max(今日, 案件の開始日) と比べる（#192: 12/1開始の案件で「12月〜」の人が落ちていた）\n"
    "      AND offerable_ok(p_offerable_only, pre.flow_raw, pre.has_resume, pre.avail_date, p_start_date)\n",
    u"出せる人の縛り")

sub("      AND pre.years_ok\n  ),",
    "      AND pre.years_ok\n"
    "      -- 年齢のマスト（#192）。上限を超える人・年齢が取れていない人(4%)を外す\n"
    "      AND age_gate_ok(v_age_max, pre.age_raw)\n  ),",
    u"年数の足切り")

sub("  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean, jsonb\n) TO anon, authenticated;",
    "  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean, jsonb, date\n) TO anon, authenticated;",
    u"GRANT")

header = (
    u"-- 自動生成: scripts/gen_fetch_candidates_age_start.py\n"
    u"-- 入力: supabase/migrations/20261031_3_fetch_candidates_years_must.sql\n"
    u"--\n"
    u"-- fetch_candidates_for_project に #192 の2点を足す（2026-11-25）。部品と背景は 20261125_1。\n"
    u"--   ・必須欄の「43歳以下」等を年齢の上限として読み、超える人・年齢不明の人を外す\n"
    u"--   ・「今出せる人だけ」の稼働を max(今日, 案件の開始日) と比べる（p_start_date）\n"
    u"-- ⚠ この関数は手で書き写さないこと。直すときは生成スクリプトを使う。\n\n"
)
io.open(rpc_dst, "w", encoding="utf-8", newline="\n").write(header + h[0])

# ================================================================ 上位候補の印
m = io.open(marks_src, encoding="utf-8").read()
hm = [m[m.index("CREATE OR REPLACE FUNCTION public.refresh_top_match_marks"):]]
subm = make_sub(hm)
subm("        p_required_skill_years => p.raw_data->'requiredSkillYears'\n",
     "        p_required_skill_years => p.raw_data->'requiredSkillYears',\n"
     "        -- 案件の開始日（#192）。渡さないと印だけ「稼働が今日以前」のまま残る\n"
     "        p_start_date => p.start_date\n",
     u"印の RPC 呼び出し")
mheader = (
    u"-- 自動生成: scripts/gen_fetch_candidates_age_start.py\n"
    u"-- 入力: supabase/migrations/20261031_4_top_match_marks_years_must.sql\n"
    u"--\n"
    u"-- 「上位候補」印の計算に案件の開始日を渡す（#192・2026-11-25）。年齢の上限は required_skills から\n"
    u"-- RPC が自分で読むので、渡すものは開始日だけ。適用後に refresh_top_match_marks('prod') を1回呼ぶ。\n\n"
)
io.open(marks_dst, "w", encoding="utf-8", newline="\n").write(mheader + hm[0])
print(u"wrote %s / %s" % (rpc_dst, marks_dst))
