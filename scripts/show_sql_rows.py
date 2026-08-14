#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""`npx supabase db query` の出力（先頭に "Initialising login role..." が付く JSON）を
読みやすい表にする。標準入力から受け取る。

  npx supabase db query --linked -f x.sql | python scripts/show_sql_rows.py

egress を使わずに検証するため、SQL 側で集計した数行を返す運用が前提
（CLAUDE.md「Egress を使わずに検証する」）。行数が多い出力には使わない。
"""
import io
import json
import sys

raw = io.open(sys.stdin.fileno(), encoding="utf-8", errors="replace").read()
i = raw.find("{")
if i < 0:
    print(raw.strip() or "(出力なし)")
    sys.exit(0)

try:
    doc = json.loads(raw[i:])
except ValueError as e:
    print("JSON として読めません: %s" % e)
    print(raw[i:][:800])
    sys.exit(1)

if doc.get("_tag") == "Error":
    print("SQL エラー: %s" % doc.get("error", {}).get("message", "")[:1200])
    sys.exit(1)

rows = doc.get("rows") or []
if not rows:
    print("0 行")
    sys.exit(0)

cols = list(rows[0].keys())


def cell(v):
    return "" if v is None else str(v)


widths = [max(len(c), *(len(cell(r.get(c))) for r in rows)) for c in cols]
print(" | ".join(c.ljust(w) for c, w in zip(cols, widths)))
print("-+-".join("-" * w for w in widths))
for r in rows:
    print(" | ".join(cell(r.get(c)).ljust(w) for c, w in zip(cols, widths)))
print("(%d 行)" % len(rows))
