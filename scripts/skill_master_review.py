#!/usr/bin/env python3
"""
skill_master 月次レビュースクリプト（Claude Code用）

使い方:
  python3 scripts/skill_master_review.py

AIが登録したスキル（source='ai'）のうち、怪しいものを一覧表示して削除候補を提示する。
Claude Code は毎月このスクリプトを実行し、出力された削除候補を確認して
必要に応じて手動または Supabase SQL Editor で削除すること。
"""

import os
import re
import json
from urllib.request import urlopen, Request
from urllib.error import URLError


SUPABASE_URL = "https://argizomylbolpqxgmvim.supabase.co"


def get_anon_key() -> str:
    """プロジェクトルートの .env.local から VITE_SUPABASE_ANON_KEY を取得する"""
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env.local')
    if os.path.exists(env_path):
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('VITE_SUPABASE_ANON_KEY='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    return os.environ.get('SUPABASE_ANON_KEY', '')


# 怪しいパターンとその説明
SUSPICIOUS_PATTERNS = [
    (r'^.{1,2}$',                    '短すぎる（2文字以下）'),
    (r'^\d+$',                        '数字のみ'),
    (r'^\d[\d.]+$',                   'バージョン番号'),
    (r'^[ぁ-ん]+$',                   'ひらがなのみ'),
    (r'^[ァ-ン]{1,3}$',              '短いカタカナ（3文字以下）'),
    (r'(経験|以上|対応|管理|設計|構築|運用|実装|業務|機能|処理|開発|作成|担当|実績|習得|使用|利用|活用)',
                                      '技術語でない可能性がある日本語'),
    (r'\s{2,}',                       'スペース多数'),
    (r'^[.,:;!?。、：；！？]+$',       '句読点のみ'),
    (r'.{61,}',                       '60文字超（異常に長い）'),
]


def fetch_ai_skills(key: str) -> list:
    """skill_master から source='ai' のエントリを取得する"""
    url = (
        f"{SUPABASE_URL}/rest/v1/skill_master"
        "?source=eq.ai"
        "&select=id,name,category,match_count,created_at"
        "&order=match_count.asc,created_at.asc"
        "&limit=500"
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


def fetch_stats(key: str) -> dict:
    """skill_master の統計情報を取得する"""
    url = (
        f"{SUPABASE_URL}/rest/v1/skill_master"
        "?select=source,category"
        "&limit=10000"
    )
    req = Request(url, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
    })
    try:
        with urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        seed_count = sum(1 for s in data if s.get('source') == 'seed')
        ai_count = sum(1 for s in data if s.get('source') == 'ai')
        from collections import Counter
        category_counts = Counter(s.get('category') for s in data)
        return {
            'total': len(data),
            'seed': seed_count,
            'ai': ai_count,
            'by_category': dict(category_counts.most_common()),
        }
    except URLError:
        return {}


def main():
    key = get_anon_key()
    if not key:
        print("[エラー] SUPABASE_ANON_KEY が取得できませんでした。")
        print("  .env.local に VITE_SUPABASE_ANON_KEY を設定するか、")
        print("  環境変数 SUPABASE_ANON_KEY を設定してください。")
        return

    print("\n=== skill_master 月次レビュー ===\n")

    # 統計情報
    stats = fetch_stats(key)
    if stats:
        print(f"総エントリ数: {stats.get('total', '?')}件")
        print(f"  - seed: {stats.get('seed', '?')}件")
        print(f"  - ai  : {stats.get('ai', '?')}件\n")

    skills = fetch_ai_skills(key)
    if not skills:
        print("AI登録スキルが0件か、取得に失敗しました。")
        return

    print(f"AI登録スキル総数: {len(skills)}件\n")

    suspects = []
    for s in skills:
        name = s.get('name', '')
        reasons = [msg for pat, msg in SUSPICIOUS_PATTERNS if re.search(pat, name)]
        if reasons:
            suspects.append({**s, 'reasons': reasons})

    if not suspects:
        print("怪しいエントリなし。スキルマスターは良好な状態です。")
        return

    print(f"要確認エントリ: {len(suspects)}件\n")
    print(f"{'カテゴリ':<16} {'スキル名':<35} {'match':>6}  理由")
    print("-" * 90)

    for s in suspects:
        name_display = repr(s['name'])[:33]
        cat = s.get('category', '?')[:14]
        match = s.get('match_count', 0)
        reasons_str = ', '.join(s['reasons'])
        print(f"  {cat:<14} {name_display:<35} {match:>6}  {reasons_str}")

    print("\n--- 削除候補 SQL ---")
    suspect_ids = [s['id'] for s in suspects]
    print(f"-- 以下を Supabase SQL Editor で実行して削除（要確認後）:")
    print(f"DELETE FROM skill_master")
    print(f"WHERE id IN (")
    for i, sid in enumerate(suspect_ids):
        comma = "," if i < len(suspect_ids) - 1 else ""
        print(f"  '{sid}'{comma}")
    print(f");")

    print("\n--- 削除候補 ID リスト（Python用） ---")
    print(repr([s['id'] for s in suspects]))

    # match_count が高い AI スキル（正常登録の確認）
    high_match = [s for s in skills if s.get('match_count', 0) >= 5]
    if high_match:
        print(f"\n--- match_count ≥ 5 の AI スキル（{len(high_match)}件・正常登録の可能性が高い） ---")
        for s in sorted(high_match, key=lambda x: -x.get('match_count', 0))[:20]:
            print(f"  [{s.get('category','?'):<14}] {s.get('name',''):30s}  match={s.get('match_count',0)}")


if __name__ == '__main__':
    main()
