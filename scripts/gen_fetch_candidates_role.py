#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_fetch_candidates_role.py — fetch_candidates_for_project に「役割の合致度」を足した
マイグレーションを、既存定義から機械的に生成する。

gen_fetch_candidates_nice.py と同じ方式。関数は 270 行近くあり手で写すと
写経ミスで配点が変わるため、直す箇所だけを置換して出力する。

加点の設計（2026-08-14 ユーザー判断「他と一緒でうまく点数付けしたらいい」）:
  ゲートにはしない。role_affinity(0.2〜1.0) を中立0.5からの差分として
  ±(p_weight_role/2) の範囲で加減点する。
    同一役割 1.0 → +weight/2      同系統 0.7 → +weight*0.2
    不明     0.5 →  0（既存挙動と完全に一致）  系統違い 0.2 → -weight*0.3
  requiredRole 未設定の案件では必ず 0 になるので、既存の順位は動かない。

使い方: python scripts/gen_fetch_candidates_role.py <入力sql> <出力sql>
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
s = io.open(src_path, encoding="utf-8").read()

start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

SIG_OLD = ("text, text[], numeric, numeric, text, text, integer, integer, integer, "
           "integer, integer, integer, boolean, text, text, integer, jsonb, text[]")
SIG_NEW = SIG_OLD + ", text, integer"

# ── ① 新シグネチャも DROP（再実行できるように）──
old_drop = "DROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_OLD
assert old_drop in body, "旧シグネチャの DROP が見つからない（定義が変わった？）"
body = body.replace(old_drop, old_drop + "\nDROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_NEW, 1)

# ── ② 引数を2つ足す ──
old_arg = "  p_nice_skills       text[]  DEFAULT NULL\n)"
assert old_arg in body, "p_nice_skills の引数定義が見つからない"
new_arg = (
    "  p_nice_skills       text[]  DEFAULT NULL,\n"
    "  -- 案件が求める役割（AI解釈 raw_data.aiInterpretation.requiredRole）。\n"
    "  -- 人材側の raw_profile.roles[0]（主役割）と role_affinity で突き合わせる。\n"
    "  -- NULL なら加減点ゼロ＝この機能を入れる前と同じ順位になる\n"
    "  p_required_role     text    DEFAULT NULL,\n"
    "  p_weight_role       integer DEFAULT 30\n)"
)
body = body.replace(old_arg, new_arg, 1)

# ── ③ pre CTE に主役割を足す ──
old_pre = "      (sel.candidate_id IS NOT NULL) AS sel_ok\n"
assert old_pre in body, "pre CTE の sel_ok が見つからない"
new_pre = old_pre + "      ,c.raw_profile->'roles'->>0 AS main_role\n"
body = body.replace(old_pre, new_pre, 1)

# ── ④ 派遣の加減点の隣に役割の加減点を足す ──
#    重み付き合計の外側。中立(0.5)で 0 になるので既存案件の点は動かない
old_haken = (
    "      + CASE WHEN p_contract_type = '派遣' AND pre.haken_ok = true THEN 5 ELSE 0 END\n"
    "      AS rule_score_raw"
)
assert old_haken in body, "派遣の加減点が見つからない"
new_haken = (
    "      + CASE WHEN p_contract_type = '派遣' AND pre.haken_ok = true THEN 5 ELSE 0 END\n"
    "      -- 役割の合致度（2026-08-14）。実装案件のPMO・PM案件のPG を沈める。\n"
    "      -- ゲートではなく加減点。中立(0.5)＝0 なので requiredRole 未設定なら無影響\n"
    "      + ROUND((role_affinity(p_required_role, pre.main_role) - 0.5) * p_weight_role)\n"
    "      AS rule_score_raw"
)
body = body.replace(old_haken, new_haken, 1)

# ── ⑤ GRANT のシグネチャを更新 ──
old_grant = ("  text, text[], numeric, numeric, text, text, integer, integer, integer,\n"
             "  integer, integer, integer, boolean, text, text, integer, jsonb, text[]")
assert old_grant in body, "GRANT のシグネチャが見つからない"
body = body.replace(old_grant, old_grant + ", text, integer", 1)

header = u"""-- 自動生成: scripts/gen_fetch_candidates_role.py
-- 入力: %s
--
-- fetch_candidates_for_project に「案件が求める役割」との合致度を足す。
--
-- 背景（2026-08-14）:
--   人材側は raw_profile.roles に主役割を持っていたのに、案件側に要求役割が無く
--   採点に使われていなかった。PMO歴10年の人が実装案件の1位（95点）になっていた。
--   案件側の requiredRole は AI解釈が入れる（単語一致では取れないため）。
--
-- 加減点はゲートではない（ユーザー判断「他と一緒でうまく点数付けしたらいい」）:
--   同一役割 +15 / 同系統 +6 / 不明 0 / 系統違い -9（p_weight_role=30 のとき）
--   requiredRole が NULL の案件は必ず 0 なので、既存の順位は一切動かない。
--
-- ⚠ この関数は手で書き写さないこと。直すときはこの生成スクリプトを使う。

""" % src_path

io.open(dst_path, "w", encoding="utf-8").write(header + body)
print("生成しました: %s" % dst_path)
