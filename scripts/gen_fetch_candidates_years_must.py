#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""
gen_fetch_candidates_years_must.py — fetch_candidates_for_project に
「スキル年数」と「居住地」のマストを足したマイグレーションを、既存定義から機械的に生成する。

gen_fetch_candidates_offerable_gate.py と同じ方式（関数は300行近くあり、手で写すと配点が変わる）。

設計（2026-10-31 営業の指示「求める居住地とスキル年数はマスト」）:
  ・案件が年数を書いた技術（raw_data.requiredSkillYears）は、届かない人・年数が取れていない人を外す
    → skill_years_gate_ok（20261031_1_skill_years_must_helpers.sql）
  ・年数の指定が無い技術は外さず、年数が取れていない人はそのスキルの点を半分にする
    → skill_hit_pairs の組ごとに skill_is_tech / skill_years_meets で見る
  ・居住地が取れていない人は、駅名から県を補う（resolve_work_prefecture）。それでも
    分からなければ勤務地の縛りで外す（location_gate_ok 側を直す）

使い方: python scripts/gen_fetch_candidates_years_must.py <入力sql> <出力sql> [関数名]
  入力は 20261020_5_fetch_candidates_offerable_gate.sql（出せる人の縛りが入った版）
  関数名を渡すと別名で作る（本番で旧版と並べて比べるため。既定は fetch_candidates_for_project）
"""
import io
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
fn = sys.argv[3] if len(sys.argv) > 3 else "fetch_candidates_for_project"
s = io.open(src_path, encoding="utf-8").read()

start = s.index("DROP FUNCTION IF EXISTS fetch_candidates_for_project")
body = s[start:]

SIG_OLD = ("text, text[], numeric, numeric, text, text, integer, integer, integer, "
           "integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean")
SIG_NEW = SIG_OLD + ", jsonb"


def sub(old, new, what):
    global body
    assert old in body, u"%s が見つからない（定義が変わった？）" % what
    body = body.replace(old, new, 1)


# ── ① 新シグネチャも DROP（再実行できるように）──
old_drop = "DROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_OLD
sub(old_drop, old_drop + "\nDROP FUNCTION IF EXISTS fetch_candidates_for_project(%s);" % SIG_NEW, u"旧シグネチャの DROP")

# ── ② 引数を1つ足す ──
sub("  p_offerable_only    boolean DEFAULT true\n)",
    "  p_offerable_only    boolean DEFAULT true,\n"
    "  -- 案件が年数を書いた技術 {\"Java\":[10]}（projects.raw_data.requiredSkillYears）。2026-10-31。\n"
    "  -- 届かない人と年数が取れていない人を候補から外す（営業の指示「スキル年数はマスト」）。\n"
    "  -- NULL・空なら絞らない\n"
    "  p_required_skill_years jsonb DEFAULT NULL\n)",
    u"p_offerable_only の引数定義")

# ── ③ 必須スキルの充足を組で取り、年数が取れていない技術の重みを数える ──
sub("  WITH hw AS MATERIALIZED (\n"
    "    -- 必須スキルの充足はここに集約している（auto-match も同じ関数を呼ぶ）\n"
    "    SELECT candidate_id, hit_w\n"
    "      FROM skill_hit_weights(p_data_env, p_required_skills, p_skill_weights)\n"
    "  ),",
    "  WITH hp AS MATERIALIZED (\n"
    "    -- 必須スキルの充足（組）。判定は skill_hit_pairs に集約している（skill_hit_weights はこの合計）\n"
    "    SELECT candidate_id, name, w FROM skill_hit_pairs(p_data_env, p_required_skills, p_skill_weights)\n"
    "  ),\n"
    "  tech AS MATERIALIZED (\n"
    "    -- 年数を見る必須スキル（技術だけ。工程・英語・マスタに無い語は見ない）\n"
    "    -- 必須スキルの数だけ判定する（充足した組ごとに呼ぶと3,456回になり、1案件30秒かかった）\n"
    "    SELECT q AS name FROM unnest(COALESCE(v_skills, ARRAY[]::text[])) q WHERE skill_is_tech(q)\n"
    "  ),\n"
    "  ry AS MATERIALIZED (\n"
    "    -- 案件が年数を書いた技術と、必要な月数（複数書かれていれば短い方）。定義は skill_years_gate_ok と同じ\n"
    "    SELECT lower(trim(r.key)) AS name, 12 * min(x::numeric) AS need\n"
    "      FROM jsonb_each(CASE WHEN jsonb_typeof(p_required_skill_years) = 'object'\n"
    "                           THEN p_required_skill_years ELSE '{}'::jsonb END) r\n"
    "      CROSS JOIN LATERAL jsonb_array_elements_text(\n"
    "        CASE WHEN jsonb_typeof(r.value) = 'array' THEN r.value ELSE '[]'::jsonb END) x\n"
    "     WHERE x ~ '^[0-9.]+$' AND skill_is_tech(r.key)\n"
    "     GROUP BY 1\n"
    "  ),\n"
    "  hy AS MATERIALIZED (\n"
    "    -- 年数が取れている組。skillYears のキーで、スキル一致と同じ規則で照合する（MySQL 5年 → SQL）。\n"
    "    -- 1人ずつ skill_years_meets で見ると1案件67秒かかったので集合で取る（本番実測）\n"
    "    SELECT candidate_id, name, months\n"
    "      FROM skill_hit_pairs(p_data_env,\n"
    "                           ARRAY(SELECT name FROM tech UNION SELECT name FROM ry),\n"
    "                           NULL, true)\n"
    "  ),\n"
    "  hw AS MATERIALIZED (\n"
    "    -- unv_w = 満たしているのに年数が取れていない技術の重み。スキル点はこの半分を引く\n"
    "    -- （2026-10-31「スキル年数はマスト」。年数の指定が無い技術は外さず、年数の分かる人を上にする）\n"
    "    SELECT hp.candidate_id,\n"
    "           SUM(hp.w) AS hit_w,\n"
    "           COALESCE(SUM(hp.w) FILTER (\n"
    "             WHERE hp.name IN (SELECT name FROM tech) AND hy.candidate_id IS NULL), 0) AS unv_w\n"
    "      FROM hp LEFT JOIN hy ON hy.candidate_id = hp.candidate_id AND hy.name = hp.name\n"
    "     GROUP BY hp.candidate_id\n"
    "  ),\n"
    "  yok AS MATERIALIZED (\n"
    "    -- 案件が年数を書いた技術を全部満たす人（年数が取れていない人は入らない）\n"
    "    SELECT hy.candidate_id\n"
    "      FROM hy JOIN ry ON ry.name = hy.name AND hy.months >= ry.need\n"
    "     GROUP BY hy.candidate_id\n"
    "    HAVING count(*) = (SELECT count(*) FROM ry)\n"
    "  ),",
    u"hw CTE")

# ── ④ pre: 居住地を駅名で補う・半分にする重み・年数の足切り ──
sub("      extract_pref_core(c.raw_profile->>'prefecture') AS pref_core,\n"
    "      COALESCE(c.raw_profile->>'prefecture', '')            AS pref_raw,\n",
    "      -- 居住地が取れていない人は最寄駅から県を補う（2026-10-31）。駅名も無い・引けない人は\n"
    "      -- 空のまま＝勤務地の縛りで外れる（location_gate_ok。「求める居住地はマスト」）。\n"
    "      -- 本番実測: 1,665人中 県が空 74人・うち駅名あり 15人・駅名から引ける 7人\n"
    "      extract_pref_core(COALESCE(NULLIF(c.raw_profile->>'prefecture', ''),\n"
    "                                 resolve_work_prefecture(c.raw_profile->>'nearestStation'))) AS pref_core,\n"
    "      COALESCE(NULLIF(c.raw_profile->>'prefecture', ''),\n"
    "               resolve_work_prefecture(c.raw_profile->>'nearestStation'), '') AS pref_raw,\n",
    u"pre の居住地列")

sub("      COALESCE(hw.hit_w, 0) AS hit_w,\n",
    "      COALESCE(hw.hit_w, 0) AS hit_w,\n"
    "      COALESCE(hw.unv_w, 0) AS unv_w,\n"
    "      -- 案件が年数を書いた技術を全部満たすか（年数が取れていない人は満たさない）\n"
    "      (NOT EXISTS (SELECT 1 FROM ry) OR yok.candidate_id IS NOT NULL) AS years_ok,\n",
    u"pre の hit_w 列")

sub("    LEFT JOIN hw ON hw.candidate_id = c.id\n",
    "    LEFT JOIN hw ON hw.candidate_id = c.id\n"
    "    LEFT JOIN yok ON yok.candidate_id = c.id\n",
    u"pre の hw 結合")

# ── ⑤ スキル点: 年数が取れていない技術は半分 ──
sub("              ELSE LEAST(pre.hit_w / v_total_weight, 1.0)\n",
    "              -- 年数が取れていない技術は重みの半分だけ数える（2026-10-31）\n"
    "              ELSE LEAST((pre.hit_w - 0.5 * pre.unv_w) / v_total_weight, 1.0)\n",
    u"スキル比率の式")

# ── ⑥ 足切り ──
sub("      AND offerable_ok(p_offerable_only, pre.flow_raw, pre.has_resume, pre.avail_date)\n  ),",
    "      AND offerable_ok(p_offerable_only, pre.flow_raw, pre.has_resume, pre.avail_date)\n"
    "      -- スキル年数のマスト（2026-10-31 営業の指示）。案件が「Java 10年以上」と書いていても\n"
    "      -- 年数で絞っておらず、本番で 345人が候補だった（絞ると23人）\n"
    "      AND pre.years_ok\n  ),",
    u"出せる人の縛りの条件")

# ── ⑦ GRANT のシグネチャ ──
sub("  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean\n) TO anon, authenticated;",
    "  integer, integer, integer, boolean, text, text, integer, jsonb, text[], text, integer, boolean, boolean, jsonb\n) TO anon, authenticated;",
    u"GRANT")

if fn != "fetch_candidates_for_project":
    body = body.replace("fetch_candidates_for_project(", fn + "(")
    body = body.replace("public.fetch_candidates_for_project", "public." + fn)
# 比較用に、直した勤務地の縛りを別名で作って呼ぶとき（本番の location_gate_ok を先に変えないため）
gate_fn = sys.argv[4] if len(sys.argv) > 4 else None
if gate_fn:
    body = body.replace("location_gate_ok(", gate_fn + "(")

header = (
    u"-- 自動生成: scripts/gen_fetch_candidates_years_must.py\n"
    u"-- 入力: supabase/migrations/20261020_5_fetch_candidates_offerable_gate.sql\n"
    u"--\n"
    u"-- fetch_candidates_for_project に「スキル年数」と「居住地」のマストを足す（2026-10-31）。\n"
    u"-- 部品と背景は 20261031_1_skill_years_must_helpers.sql。\n"
    u"--   ・案件が年数を書いた技術は、届かない人・年数が取れていない人を外す\n"
    u"--   ・年数の指定が無い技術は、年数が取れていない人のスキル点を半分にする\n"
    u"--   ・居住地が空なら最寄駅から県を補い、それでも分からなければ外す\n"
    u"-- ⚠ match-batch（画面に出る点数）の calcRuleScore も同じ半分ルールにしてある。片方だけ直さない\n"
    u"-- ⚠ この関数は手で書き写さないこと。直すときはこの生成スクリプトを使う。\n\n"
)
io.open(dst_path, "w", encoding="utf-8", newline="\n").write(header + body)
print(u"wrote %s (%s)" % (dst_path, fn))
