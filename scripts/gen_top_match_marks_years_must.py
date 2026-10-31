#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""
gen_top_match_marks_years_must.py — refresh_top_match_marks（人材一覧の「上位候補」印）が
fetch_candidates_for_project に案件の年数指定（raw_data.requiredSkillYears）を渡すようにする。

渡さないと、印だけ「Java 10年以上」の足切りが効かない＝マッチング画面と印の順位が食い違う。
関数は90行あり手で写すと崩れるので、既存定義から1行足して出力する。

使い方: python scripts/gen_top_match_marks_years_must.py <入力sql> <出力sql>
  入力は 20261020_top_match_marks_on_arrival.sql
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

start = s.index("CREATE OR REPLACE FUNCTION public.refresh_top_match_marks(p_data_env text DEFAULT 'prod')")
end = s.index("$$;", start) + len("$$;")
fn = s[start:end]

old = "        p_required_role => p.raw_data->'aiInterpretation'->>'requiredRole'\n"
assert old in fn, u"p_required_role の行が見つからない（定義が変わった？）"
fn = fn.replace(
    old,
    "        p_required_role => p.raw_data->'aiInterpretation'->>'requiredRole',\n"
    "        -- 案件が年数を書いた技術（2026-10-31「スキル年数はマスト」）。渡さないと印だけ足切りが効かない\n"
    "        p_required_skill_years => p.raw_data->'requiredSkillYears'\n",
    1)

header = (
    u"-- 自動生成: scripts/gen_top_match_marks_years_must.py\n"
    u"-- 入力: supabase/migrations/20261020_top_match_marks_on_arrival.sql\n"
    u"--\n"
    u"-- 「上位候補」印の計算に、案件の年数指定を渡す（2026-10-31）。\n"
    u"-- fetch_candidates_for_project に年数の足切りが入った（20261031_3）ので、印も同じ候補から選ぶ。\n"
    u"-- 適用後に refresh_top_match_marks('prod') を1回呼ぶ。\n\n"
)
io.open(dst_path, "w", encoding="utf-8", newline="\n").write(header + fn + "\n")
print(u"wrote %s" % dst_path)
