#!/usr/bin/env python3
"""
relevance_keywords 月次レビュースクリプト（Claude Code用）

使い方:
  python3 scripts/relevance_keywords_review.py

match_count が低いキーワードや疑わしいエントリを一覧表示し、
削除・修正候補の SQL を出力する。
Claude Code は毎月このスクリプトを実行し、出力を確認して
必要に応じて Supabase SQL Editor で削除/追加を行うこと。
"""

import os
import re
import json
from urllib.request import urlopen, Request
from urllib.error import URLError
from collections import Counter


SUPABASE_URL = "https://argizomylbolpqxgmvim.supabase.co"


def get_anon_key() -> str:
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env.local')
    if os.path.exists(env_path):
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('VITE_SUPABASE_ANON_KEY='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    return os.environ.get('SUPABASE_ANON_KEY', '')


def fetch_all_keywords(key: str) -> list:
    url = (
        f"{SUPABASE_URL}/rest/v1/relevance_keywords"
        "?select=id,keyword,type,match_count,last_matched_at,source,created_at"
        "&order=type.asc,match_count.asc"
        "&limit=2000"
    )
    req = Request(url, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
    })
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except URLError as e:
        print(f"[エラー] Supabase への接続に失敗しました: {e}")
        return []


# 疑わしいパターン
SUSPICIOUS_PATTERNS = [
    (r'^.{1,2}$',                '短すぎる（2文字以下）'),
    (r'^\d+$',                   '数字のみ'),
    (r'^[ぁ-ん]{1,2}$',          '短いひらがな'),
    (r'^[ァ-ン]{1,2}$',          '短いカタカナ'),
    (r'\s{2,}',                  'スペース多数'),
    (r'^[.,:;!?。、：；！？]+$', '句読点のみ'),
    (r'.{51,}',                  '50文字超（長すぎる可能性）'),
]


def main():
    key = get_anon_key()
    if not key:
        print("[エラー] SUPABASE_ANON_KEY が取得できませんでした。")
        print("  .env.local に VITE_SUPABASE_ANON_KEY を設定するか、")
        print("  環境変数 SUPABASE_ANON_KEY を設定してください。")
        return

    print("\n=== relevance_keywords 月次レビュー ===\n")

    keywords = fetch_all_keywords(key)
    if not keywords:
        print("キーワードが0件か、取得に失敗しました。")
        return

    # 統計
    by_type = Counter(k['type'] for k in keywords)
    total_matches = sum(k.get('match_count', 0) for k in keywords)
    print(f"総キーワード数: {len(keywords)}件")
    for t in ('candidate', 'project', 'exclude'):
        print(f"  - {t:<10}: {by_type.get(t, 0)}件")
    print(f"累計マッチ数: {total_matches}回\n")

    # match_count = 0 のキーワード（一度もヒットしていない）
    zero_match = [k for k in keywords if k.get('match_count', 0) == 0]
    if zero_match:
        print(f"── 未マッチキーワード（match_count=0）: {len(zero_match)}件 ──")
        print(f"  ※ 30日以上経過しているものは削除を検討")
        for k in zero_match[:30]:
            print(f"  [{k['type']:<10}] {k['keyword']}")
        if len(zero_match) > 30:
            print(f"  ... 他 {len(zero_match) - 30}件")
        print()

    # 疑わしいパターン
    suspects = []
    for k in keywords:
        reasons = [msg for pat, msg in SUSPICIOUS_PATTERNS if re.search(pat, k['keyword'])]
        if reasons:
            suspects.append({**k, 'reasons': reasons})
    if suspects:
        print(f"── 要確認エントリ: {len(suspects)}件 ──")
        print(f"  {'type':<10} {'keyword':<35} {'match':>6}  理由")
        print("  " + "-" * 75)
        for k in suspects:
            kw_display = repr(k['keyword'])[:33]
            print(f"  {k['type']:<10} {kw_display:<35} {k.get('match_count', 0):>6}  {', '.join(k['reasons'])}")
        print()

    # match_count 上位（よく使われているキーワード）
    top = sorted(keywords, key=lambda x: -x.get('match_count', 0))[:15]
    print("── match_count 上位15件 ──")
    for k in top:
        print(f"  [{k['type']:<10}] {k['keyword']:<35}  match={k.get('match_count', 0)}")
    print()

    # 削除候補 SQL
    del_candidates = [k for k in zero_match if k.get('source') == 'manual']
    del_candidates += suspects
    # 重複除去
    seen = set()
    del_unique = []
    for k in del_candidates:
        if k['id'] not in seen:
            seen.add(k['id'])
            del_unique.append(k)

    if del_unique:
        print("── 削除候補 SQL（要確認後に Supabase SQL Editor で実行） ──")
        ids_str = ', '.join(str(k['id']) for k in del_unique)
        print(f"DELETE FROM relevance_keywords WHERE id IN ({ids_str});")
        print()

    # キーワード追加提案（Claude Code が判断して追記する）
    print("── 追加候補キーワードがあれば以下に SQL を記述して実行 ──")
    print("INSERT INTO relevance_keywords (keyword, type, source) VALUES")
    print("  ('キーワード', 'candidate', 'manual'),  -- 例")
    print("  ('キーワード', 'project',   'manual')")
    print("ON CONFLICT (keyword) DO NOTHING;")


if __name__ == '__main__':
    main()
