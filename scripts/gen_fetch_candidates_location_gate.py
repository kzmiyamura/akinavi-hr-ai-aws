#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""
gen_fetch_candidates_location_gate.py — fetch_candidates_for_project に
「勤務地の縛り」を足したマイグレーションを、既存定義から機械的に生成する。

gen_fetch_candidates_role.py と同じ方式。関数は 280 行近くあり手で写すと
写経ミスで配点が変わるため、直す箇所だけを置換して出力する。

設計（2026-10-12 ユーザー判断「フルリモートでない限り勤務地縛り100」）:
  勤務地は配点ではなく**前提条件**。通えない人を候補に入れない。
  落とすのは「地方が違う人」だけで、同一県・同一地方・居住地不明は残す。
  フルリモート案件と、案件の都道府県が取れていない案件には効かせない。

使い方: python scripts/gen_fetch_candidates_location_gate.py <入力sql> <出力sql>
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

SIG_OLD = ("text, text[], numeric, numeric, text, text, integer, integer, integer, "
           "integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer")
SIG_NEW = SIG_OLD + ", boolean"

# ── ① 新シグネチャも DROP（再実行できるように）──
old_drop = "DROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_OLD
assert old_drop in body, u"旧シグネチャの DROP が見つからない（定義が変わった？）"
body = body.replace(
    old_drop,
    old_drop + "\nDROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_NEW,
    1)

# ── ② 引数を1つ足す ──
old_arg = "  p_weight_role       integer DEFAULT 30\n)"
assert old_arg in body, u"p_weight_role の引数定義が見つからない"
new_arg = (
    "  p_weight_role       integer DEFAULT 30,\n"
    "  -- 勤務地の縛り（2026-10-12）。true で「地方が違う人」を候補から外す。\n"
    "  -- フルリモート案件・案件の都道府県が取れていない案件では効かない。\n"
    "  -- 既定を true にしているのは、通えない人を並べても営業が使えないため。\n"
    "  -- 画面から false にすると従来どおり全員を点数で並べる\n"
    "  p_location_gate     boolean DEFAULT true\n)"
)
body = body.replace(old_arg, new_arg, 1)

# ── ③ 都道府県の切り出しを共有関数に置き換える ──
#    最短一致 `(\S+?)[都道府県]` は「京都府」→「京」・「北海道」→「北海」と壊れており、
#    prod で京都5人・北海道12人が自県の案件でも勤務地0点だった（2026-10-12 実測）。
#    式を2か所に持つとまた片方だけ直すので、extract_pref_core / work_pref_core に寄せる。
old_cand_pref = (
    "      COALESCE(\n"
    "        (regexp_match(c.raw_profile->>'prefecture', '(\\S+?)[都道府県]'))[1],\n"
    "        regexp_replace(\n"
    "          split_part(trim(COALESCE(c.raw_profile->>'prefecture', '')), ' ', 1),\n"
    "          '(市|区|町|村|郡).*$', ''\n"
    "        )\n"
    "      ) AS pref_core,"
)
assert old_cand_pref in body, u"候補者側の pref_core の式が見つからない"
body = body.replace(
    old_cand_pref,
    "      -- 「京都府」→「京」・「北海道」→「北海」と壊れていたため共有関数に寄せた（2026-10-12）\n"
    "      extract_pref_core(c.raw_profile->>'prefecture') AS pref_core,",
    1)

old_work_pref = (
    "  IF COALESCE(trim(p_work_prefecture), '') != '' THEN\n"
    "    v_work_pref_core := COALESCE(\n"
    "      (regexp_match(p_work_prefecture, '(\\S+?)[都道府県]'))[1],\n"
    "      trim(p_work_prefecture)\n"
    "    );\n"
    "  ELSE\n"
    "    v_work_pref_core := COALESCE(\n"
    "      (regexp_match(p_work_location, '(\\S+?)[都道府県]'))[1],\n"
    "      regexp_replace(\n"
    "        split_part(trim(COALESCE(p_work_location, '')), ' ', 1),\n"
    "        '(市|区|町|村|郡).*$', ''\n"
    "      )\n"
    "    );\n"
    "  END IF;"
)
assert old_work_pref in body, u"案件側の v_work_pref_core の式が見つからない"
body = body.replace(
    old_work_pref,
    "  -- 正規化済みの work_prefecture を正とし、無いときだけ work_location から切り出す。\n"
    "  -- 判定は work_pref_core / extract_pref_core に1つだけ置く（2026-10-12）\n"
    "  v_work_pref_core := work_pref_core(p_work_prefecture, p_work_location);",
    1)

# ── ④ 候補の絞り込みに勤務地の条件を足す ──
#    スキルの絞り込みと同じ場所（重い candidates_lite に触る前）に置く
old_where = "      AND (NOT v_has_generic OR pre.sel_ok)\n  ),"
assert old_where in body, u"汎用スキルの絞り込み条件が見つからない"
new_where = (
    "      AND (NOT v_has_generic OR pre.sel_ok)\n"
    "      -- 勤務地の縛り（2026-10-12 ユーザー判断「フルリモートでない限り勤務地縛り100」）。\n"
    "      -- 勤務地は配点ではなく前提条件。通えない人は候補に入れない。\n"
    "      --\n"
    "      -- 実測（prod 1,915人・2026-10-12）:\n"
    "      --   大阪府在住  40人（2.1%）／関西の他県 24人／居住地不明 64人（3.3%）\n"
    "      --   関西外    1,787人（93.3%）\n"
    "      -- 大阪の案件（販売管理・淀屋橋）では C#.NET を満たす514人のうち\n"
    "      -- 大阪14・関西他9・不明3 に対し**関西外が488人**で、上位10人を過ぎると\n"
    "      -- 以降は全員が通えない人だった。順位は正しくても一覧の95%が使えない。\n"
    "      --\n"
    "      -- 落とすのは「地方が違う」人だけ:\n"
    "      --   ・同一県            … 残す（満点）\n"
    "      --   ・同一地方          … 残す（淀屋橋に兵庫・京都から通うのは普通）\n"
    "      --   ・居住地が取れていない … 残す（3.3%。取れていない＝通えないではない）\n"
    "      --   ・フルリモート案件   … 縛らない\n"
    "      --   ・案件の都道府県が不明 … 縛らない（比べる相手が無い）\n"
    "      --\n"
    "      -- ⚠ 「不明」の判定に空文字を使ってはいけない。案件の勤務地が\n"
    "      --   『客先（詳細は面談時）』のように県名を含まないとき、v_work_pref_core には\n"
    "      --   **その文字列がそのまま入る**（空にはならない）。空だけを見ていると\n"
    "      --   どの県とも一致せず**候補が全員消える**（居住地不明の3人だけが残った）。\n"
    "      --   get_region() は47都道府県を網羅しているので、NULL なら県として\n"
    "      --   成立していない＝縛る相手が無い、と判定する。\n"
    "      --   prod の案件15件は現在すべて県が取れているが、取れない案件は必ず来る。\n"
    "      --   以前は勤務地が全員0点になるだけで害が無かったが、ゲートにすると空になる\n"
    "      -- 人材側の「稼働可能地域」(raw_profile.availableRegions) は AI 全廃で\n"
    "      -- 埋まらなくなっており、実質すべて null なので判定には使えない。\n"
    "      -- 関東在住で大阪常駐が可能な人を残したいときは p_location_gate=false にする\n"
    "      -- 条件そのものは location_gate_ok に1つだけ置く（20261012_1_location_gate_shared.sql）。\n"
    "      -- auto-match のように自前で候補集合を作る経路も同じ関数を呼べるようにするため、\n"
    "      -- ここに条件をコピーしない\n"
    "      AND location_gate_ok(p_location_gate, v_is_full_remote,\n"
    "                           v_work_pref_core, pre.pref_raw, pre.pref_core)\n  ),"
)
body = body.replace(old_where, new_where, 1)

# ── ④ GRANT のシグネチャを更新 ──
old_grant = ("  text, text[], numeric, numeric, text, text, integer, integer, integer,\n"
             "  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer")
assert old_grant in body, u"GRANT のシグネチャが見つからない"
body = body.replace(old_grant, old_grant + ", boolean", 1)

header = u"""-- 自動生成: scripts/gen_fetch_candidates_location_gate.py
-- 入力: %s
--
-- fetch_candidates_for_project に「勤務地の縛り」を足す。
--
-- 背景（2026-10-12 ユーザー判断「フルリモートでない限り勤務地縛り100」）:
--   勤務地は20点の配点だった。同一県=満点／同一地方=半分／別地方=0点なので
--   **順位そのものは壊れていない**（大阪案件の上位10人は大阪9・関西1・関西外0）。
--   壊れていたのは一覧の中身で、C#.NET を満たす514人のうち488人（95%%）が
--   関西外＝通えない人だった。営業がスクロールする分母のほとんどが無駄になる。
--
--   そこで勤務地を配点ではなく**前提条件**にする。フルリモート案件を除き、
--   地方が違う人は候補に入れない。同一県・同一地方・居住地不明は残す。
--
-- ⚠ この関数は手で書き写さないこと。直すときはこの生成スクリプトを使う。

""" % src_path

io.open(dst_path, "w", encoding="utf-8").write(header + body)
print(u"生成しました: %s" % dst_path)
