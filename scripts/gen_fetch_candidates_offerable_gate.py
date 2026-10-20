#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""
gen_fetch_candidates_offerable_gate.py — fetch_candidates_for_project に
「今うちから出せる人だけ」の縛りを足したマイグレーションを、既存定義から機械的に生成する。

gen_fetch_candidates_location_gate.py と同じ方式。関数は 280 行近くあり手で写すと
写経ミスで配点が変わるため、直す箇所だけを置換して出力する。

設計（2026-10-20 営業の指示「ボタンをおけ」）:
  上位5人のうち出せる人は27%しかいなかった（本番実測）。採点式に
  所属・経歴書・稼働時期が入っていないので、重みでは直らない。
  人材マップの絞りと同じ3条件を**前提条件**にする（勤務地の縛りと同じ形）。
  条件そのものは offerable_ok（20261020_4_offerable_gate_shared.sql）に1つだけ置く。

使い方: python scripts/gen_fetch_candidates_offerable_gate.py <入力sql> <出力sql>
  入力は 20261012_2_fetch_candidates_location_gate.sql（勤務地の縛りが入った版）
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

SIG_OLD = ("text, text[], numeric, numeric, text, text, integer, integer, integer, "
           "integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean")
SIG_NEW = SIG_OLD + ", boolean"

# ── ① 新シグネチャも DROP（再実行できるように）──
old_drop = "DROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_OLD
assert old_drop in body, u"旧シグネチャの DROP が見つからない（定義が変わった？）"
body = body.replace(
    old_drop,
    old_drop + "\nDROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_NEW,
    1)

# ── ② 引数を1つ足す ──
old_arg = "  p_location_gate     boolean DEFAULT true\n)"
assert old_arg in body, u"p_location_gate の引数定義が見つからない"
new_arg = (
    "  p_location_gate     boolean DEFAULT true,\n"
    "  -- 今うちから出せる人だけ（2026-10-20）。自社or1社先 × 経歴書あり × 稼働が今日以前。\n"
    "  -- 未取得は通さない（人材マップの絞りと同じ）。既定 true なのは、上位5人のうち\n"
    "  -- 出せる人が27%しかいなかったため（本番実測）。画面から false にすると従来どおり\n"
    "  p_offerable_only    boolean DEFAULT true\n)"
)
body = body.replace(old_arg, new_arg, 1)

# ── ③ pre に判定に使う3列を足す（raw_profile を読むのはここだけ、という約束を守る）──
old_pre = "      ,c.raw_profile->'roles'->>0 AS main_role\n"
assert old_pre in body, u"pre の main_role 列が見つからない"
new_pre = (
    old_pre +
    "      -- 出せる人の判定に使う3列（2026-10-20）。式は offerable_ok に置き、ここでは値だけ取る\n"
    "      ,c.raw_profile->>'commercialFlow' AS flow_raw\n"
    "      ,(c.resume_url IS NOT NULL OR c.drive_url IS NOT NULL OR c.box_url IS NOT NULL) AS has_resume\n"
    "      ,parse_available_from(c.raw_profile->>'availableFrom') AS avail_date\n"
)
body = body.replace(old_pre, new_pre, 1)

# ── ④ 候補の絞り込みに足す（勤務地の縛りの直後）──
old_where = (
    "      AND location_gate_ok(p_location_gate, v_is_full_remote,\n"
    "                           v_work_pref_core, pre.pref_raw, pre.pref_core)\n  ),"
)
assert old_where in body, u"勤務地の縛りの条件が見つからない"
new_where = (
    "      AND location_gate_ok(p_location_gate, v_is_full_remote,\n"
    "                           v_work_pref_core, pre.pref_raw, pre.pref_core)\n"
    "      -- 今うちから出せる人だけ（2026-10-20 営業の指示「ボタンをおけ」）。\n"
    "      -- 本番実測: 公開15案件の上位5人（75人）のうち、すぐ稼働 24・来月以降 25・\n"
    "      -- 読めない 26。3つ全部OK は 20人(27%)。出せる人が1人もいない案件が3件。\n"
    "      -- 採点式には所属・経歴書・稼働が入っていないので、重みでは直らない。\n"
    "      -- 条件そのものは offerable_ok に1つだけ置く（20261020_4_offerable_gate_shared.sql）\n"
    "      AND offerable_ok(p_offerable_only, pre.flow_raw, pre.has_resume, pre.avail_date)\n  ),"
)
body = body.replace(old_where, new_where, 1)

# ── ⑤ GRANT のシグネチャを更新 ──
old_grant = ("  text, text[], numeric, numeric, text, text, integer, integer, integer,\n"
             "  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean")
assert old_grant in body, u"GRANT のシグネチャが見つからない"
body = body.replace(old_grant, old_grant + ", boolean", 1)

header = u"""-- 自動生成: scripts/gen_fetch_candidates_offerable_gate.py
-- 入力: %s
--
-- fetch_candidates_for_project に「今うちから出せる人だけ」の縛りを足す。
--
-- 背景（2026-10-20 営業の指示「ボタンをおけ」）:
--   公開15案件の上位5人（75人）のうち、自社or1社先×経歴書あり×すぐ稼働 を
--   全部満たす人は **20人(27%%)**。出せる人が1人もいない案件が3件。
--   採点式（スキル・経験・単価・勤務地・リモート）にこの3つは入っていないので、
--   重みをいくら動かしても直らない。人材マップで絞れる3条件と同じものを、
--   勤務地の縛りと同じ**前提条件**にする。既定 ON、画面のスイッチで切れる。
--   ⚠ top_match_marks（人材一覧の「上位候補」印）もこの関数を呼ぶので、
--      印も「出せる人の上位」になる。適用後に refresh_top_match_marks を1回呼ぶこと。
--
-- ⚠ この関数は手で書き写さないこと。直すときはこの生成スクリプトを使う。

""" % src_path

io.open(dst_path, "w", encoding="utf-8").write(header + body)
print(u"生成しました: %s" % dst_path)
