#!/usr/bin/env python3
"""
skill_match 品質チェックスクリプト（Claude Code用）

使い方:
  python3 scripts/skill_match_review.py

candidates / candidate_skills テーブルを集計し、
スキルタグの品質を確認する。以下の観点でレポートを出力する。

  1. 資格タグが多すぎる候補者（誤タグの疑い）
  2. スキル総数が多すぎる候補者（誤タグの疑い）
  3. カテゴリ別スキル分布
  4. 最近登録された候補者のスキルタグ一覧（目視確認用）
  5. 削除候補の SQL（要確認）
"""

import os
import json
from urllib.request import urlopen, Request
from urllib.error import URLError
from collections import Counter
from datetime import datetime, timezone, timedelta


SUPABASE_URL = "https://argizomylbolpqxgmvim.supabase.co"
# 警告しきい値
CERT_WARN_THRESHOLD   = 4   # 資格タグがこれ以上あれば要確認
SKILL_WARN_THRESHOLD  = 30  # スキル総数がこれ以上あれば要確認
REVIEW_RECENT_DAYS    = 7   # 直近N日の候補者を目視確認対象にする


def get_anon_key() -> str:
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env.local')
    if os.path.exists(env_path):
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('VITE_SUPABASE_ANON_KEY='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    return os.environ.get('SUPABASE_ANON_KEY', '')


def fetch(key: str, path: str) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    req = Request(url, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
    })
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except URLError as e:
        print(f"[エラー] {path} 取得失敗: {e}")
        return []


def main():
    key = get_anon_key()
    if not key:
        print("[エラー] SUPABASE_ANON_KEY が取得できませんでした。")
        return

    print("\n=== skill_match 品質チェック ===\n")

    # candidate_skills を全件取得
    skills_data = fetch(key,
        "candidate_skills?select=candidate_id,category,skill"
        "&limit=10000"
    )
    if not skills_data:
        print("candidate_skills が0件か取得失敗。")
        return

    # candidates（名前・日時）を取得 ※data_env問わず全件
    candidates_data = fetch(key,
        "candidates?select=id,name,created_at,data_env"
        "&order=created_at.desc"
        "&limit=2000"
    )
    cand_map = {c['id']: c for c in candidates_data}

    # ── 0. カバレッジ確認 ────────────────────────────────────────
    total_candidates = len(candidates_data)
    cands_with_skills = len(set(s['candidate_id'] for s in skills_data))
    no_skill_count = total_candidates - cands_with_skills
    coverage = cands_with_skills / total_candidates * 100 if total_candidates else 0
    print(f"── スキルタグ カバレッジ ──")
    print(f"  候補者総数:            {total_candidates}名")
    print(f"  スキルタグあり:        {cands_with_skills}名  ({coverage:.1f}%)")
    print(f"  スキルタグなし（0件）: {no_skill_count}名")
    if coverage < 50:
        print(f"  ⚠️  カバレッジが低い。Edge Function の再デプロイが必要な可能性あり。")
        print(f"      → supabase functions deploy inbound-email")
    print()

    # ── 1. カテゴリ別分布 ────────────────────────────────────────
    cat_counter = Counter(s['category'] for s in skills_data)
    print("── カテゴリ別スキル登録数 ──")
    for cat, n in cat_counter.most_common():
        bar = '█' * min(n // 5, 40)
        print(f"  {cat:<20} {n:>5}件  {bar}")
    print()

    # ── 2. 候補者ごとに集計 ───────────────────────────────────────
    from collections import defaultdict
    cand_skills: dict[str, list] = defaultdict(list)
    cand_certs:  dict[str, list] = defaultdict(list)
    for s in skills_data:
        cid = s['candidate_id']
        cand_skills[cid].append(s['skill'])
        if s['category'] == 'certifications':
            cand_certs[cid].append(s['skill'])

    # ── 3. 資格タグが多すぎる候補者 ──────────────────────────────
    cert_suspects = [
        (cid, certs) for cid, certs in cand_certs.items()
        if len(certs) >= CERT_WARN_THRESHOLD
    ]
    cert_suspects.sort(key=lambda x: -len(x[1]))

    if cert_suspects:
        print(f"── 資格タグ {CERT_WARN_THRESHOLD}件以上の候補者（誤タグ疑い）: {len(cert_suspects)}名 ──")
        for cid, certs in cert_suspects[:20]:
            c = cand_map.get(cid, {})
            name = c.get('name', '不明')[:20]
            dt   = c.get('created_at', '')[:10]
            print(f"  {name:<22} ({dt})  資格{len(certs)}件: {', '.join(certs[:5])}{'...' if len(certs)>5 else ''}")
        print()
    else:
        print(f"── 資格タグ {CERT_WARN_THRESHOLD}件以上の候補者: なし ✅\n")

    # ── 4. スキル総数が多すぎる候補者 ────────────────────────────
    skill_suspects = [
        (cid, skills) for cid, skills in cand_skills.items()
        if len(skills) >= SKILL_WARN_THRESHOLD
    ]
    skill_suspects.sort(key=lambda x: -len(x[1]))

    if skill_suspects:
        print(f"── スキル総数 {SKILL_WARN_THRESHOLD}件以上の候補者（誤タグ疑い）: {len(skill_suspects)}名 ──")
        for cid, skills in skill_suspects[:20]:
            c = cand_map.get(cid, {})
            name = c.get('name', '不明')[:20]
            dt   = c.get('created_at', '')[:10]
            print(f"  {name:<22} ({dt})  {len(skills)}件")
        print()
    else:
        print(f"── スキル総数 {SKILL_WARN_THRESHOLD}件以上の候補者: なし ✅\n")

    # ── 5. 直近N日の候補者の資格タグ目視確認 ───────────────────────
    cutoff = (datetime.now(timezone.utc) - timedelta(days=REVIEW_RECENT_DAYS)).isoformat()
    recent = [c for c in candidates_data if c.get('created_at', '') >= cutoff]
    if recent:
        print(f"── 直近{REVIEW_RECENT_DAYS}日の候補者 ({len(recent)}名) 資格タグ一覧 ──")
        for c in recent[:30]:
            cid  = c['id']
            name = c.get('name', '不明')[:20]
            dt   = c.get('created_at', '')[:10]
            certs = cand_certs.get(cid, [])
            total = len(cand_skills.get(cid, []))
            cert_str = ', '.join(certs) if certs else '（なし）'
            warn = ' ⚠️' if len(certs) >= CERT_WARN_THRESHOLD else ''
            print(f"  {name:<22} ({dt})  スキル計{total:>3}件  資格: {cert_str}{warn}")
        print()
    else:
        print(f"── 直近{REVIEW_RECENT_DAYS}日の新規候補者なし\n")

    # ── 6. 削除 SQL の提示 ──────────────────────────────────────
    if cert_suspects or skill_suspects:
        suspect_ids = list({cid for cid, _ in cert_suspects[:10]} |
                           {cid for cid, _ in skill_suspects[:10]})
        print("── 要確認候補者の candidate_skills 削除 SQL ──")
        print("-- 以下を Supabase SQL Editor で対象候補者ごとに確認・実行:")
        for cid in suspect_ids[:5]:
            c = cand_map.get(cid, {})
            print(f"-- {c.get('name','?')} ({cid})")
            print(f"SELECT * FROM candidate_skills WHERE candidate_id = '{cid}' ORDER BY category, skill;")
        print()
        print("-- 資格タグのみ全削除する場合:")
        for cid, certs in cert_suspects[:3]:
            c = cand_map.get(cid, {})
            cert_list = ', '.join(f"'{x}'" for x in certs)
            print(f"-- {c.get('name','?')}: DELETE FROM candidate_skills")
            print(f"   WHERE candidate_id = '{cid}' AND category = 'certifications';")


if __name__ == '__main__':
    main()
