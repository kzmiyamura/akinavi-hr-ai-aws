#!/usr/bin/env python3
"""
AI解析品質チェックスクリプト
ai_logs.raw_body × ai_result × candidates/projects を突合し、24項目の品質問題を検出する。

使い方:
  python3 scripts/quality_check.py [--days 1]

オプション:
  --days N  過去N日分を対象（デフォルト: 1）
"""

import subprocess
import json
import sys
import re
import argparse
from datetime import datetime

# ────────────────────────────────────────────
# 自社（受信側）の会社名・ドメイン（from_company 誤認識チェック用）
# ────────────────────────────────────────────
OWN_COMPANY_NAMES = ['株式会社ボイス', 'i-voice', 'アキナビ', 'akinavi']
OWN_EMAIL_DOMAINS = ['i-voice.co.jp']

# 既知スキルキーワード（スキル抽出漏れチェック用）
SKILL_KEYWORDS = [
    'Java', 'Python', 'PHP', 'Ruby', 'Go', 'C#', 'C++', 'TypeScript', 'JavaScript',
    'React', 'Vue', 'Angular', 'Spring', 'Laravel', 'Rails', 'Django', 'Node',
    'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Linux', 'Windows',
    'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'MongoDB', 'Redis',
    'Git', 'Jenkins', 'CI/CD', 'Ansible', 'Cisco', 'Juniper',
    '機械学習', 'AI', 'データ分析', 'Tableau', 'PowerBI',
    'VBA', 'Excel', 'PMO', 'Salesforce',
]

# 案件メールキーワード
PROJECT_KEYWORDS = ['管理ID', '清算幅', 'ご提案をお待ち', 'エンド直', '商流', '募集', '合う人材', '紹介いただける']

# 人材メールキーワード
CANDIDATE_KEYWORDS = ['スキルシート', '即日参画', 'ご要員', '直要員', 'BP要員', '弊社エンジニア', '要員のご紹介']


def run_query(sql: str, output='json') -> list:
    """Supabase CLI 経由でSQLを実行し結果を返す"""
    result = subprocess.run(
        ['supabase', 'db', 'query', '--linked', sql, '-o', output],
        capture_output=True, text=True,
        cwd='/Users/kazukimiyamura/Desktop/0430/akinavi-hr-ai-aws'
    )
    if result.returncode != 0:
        print(f'[SQL ERROR] {result.stderr[:300]}', file=sys.stderr)
        return []
    raw = result.stdout
    start = raw.find('[')
    end = raw.rfind(']') + 1
    if start == -1:
        return []
    try:
        return json.loads(raw[start:end])
    except Exception as e:
        print(f'[JSON PARSE ERROR] {e}', file=sys.stderr)
        return []


def check(number, title: str, items: list, formatter):
    """チェック結果を出力する共通関数"""
    label = f'{number:02d}' if isinstance(number, int) else str(number)
    if items:
        print(f'\n❌ [{label}] {title} — {len(items)}件')
        for item in items[:5]:  # 最大5件表示
            print(f'    {formatter(item)}')
        if len(items) > 5:
            print(f'    ... 他{len(items)-5}件')
    else:
        print(f'  ✅ [{label}] {title}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=1)
    args = parser.parse_args()
    days = args.days

    since = f"NOW() - INTERVAL '{days} days'"
    print(f'=== AI解析品質チェック（過去{days}日） ===')
    print(f'実行時刻: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print()

    # ── ① 名前が「不明」なのに本文に人名がある ──────────────────
    rows = run_query(f"""
        SELECT l.id, l.from_address, l.subject, c.name, l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.name IN ('不明', '')
          AND l.raw_body IS NOT NULL
          AND (l.raw_body LIKE '%様%' OR l.raw_body LIKE '%氏%' OR l.raw_body LIKE '%さん%')
    """)
    check(1, '名前=不明なのに本文に人名的な語がある', rows,
          lambda r: f"{r['subject'][:50]} | body: {(r['raw_body'] or '')[:60].replace(chr(10),' ')}")

    # ── ② 名前がイニシャル2文字以下 ──────────────────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.id
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.name IS NOT NULL
          AND c.name NOT IN ('不明', '')
          AND length(c.name) <= 2
    """)
    check(2, '名前がイニシャル2文字以下', rows,
          lambda r: f"name={r['name']} | {r['subject'][:50]}")

    # ── ③ email が NULL なのに本文にメアドがある ─────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.email IS NULL
          AND l.raw_body ~ '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{{2,}}'
          AND l.raw_body IS NOT NULL
    """)
    # 差出人メール自身は除外（本文中に別メアドがある場合のみ問題）
    filtered = []
    for r in rows:
        emails_in_body = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', r.get('raw_body') or '')
        other_emails = [e for e in emails_in_body if e != r.get('from_address')]
        if other_emails:
            r['found_email'] = other_emails[0]
            filtered.append(r)
    check(3, 'email=NULLなのに本文に別メアドがある', filtered,
          lambda r: f"name={r['name']} | 本文メアド={r.get('found_email','?')} | {r['subject'][:40]}")

    # ── ④ 電話番号が本文にあるのに未抽出（phone=NULL）────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.phone, l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.phone IS NULL
          AND l.raw_body ~ '\\d{{2,4}}[\\-−]\\d{{2,4}}[\\-−]\\d{{4}}'
          AND l.raw_body IS NOT NULL
    """)
    check(4, 'phone=NULLなのに本文に電話番号がある', rows,
          lambda r: f"name={r['name']} | {r['subject'][:50]}")

    # ── ⑤ desired_rate=NULL なのに本文に「万」がある ─────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.desired_rate, l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.desired_rate IS NULL
          AND l.raw_body ~ '\\d{{2,3}}万'
          AND l.raw_body IS NOT NULL
    """)
    def rate_formatter(r):
        m = re.search(r'(\d{2,3}万[円/月]*)', r.get('raw_body') or '')
        found = m.group(1) if m else '?'
        return f"name={r['name']} | 本文に{found} | {r['subject'][:40]}"
    check(5, 'desired_rate=NULLなのに本文に単価がある', rows, rate_formatter)

    # ── ⑥ experience_years=NULL なのに本文に「経験○年」がある ─────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.experience_years, l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.experience_years IS NULL
          AND l.raw_body ~ '経験[約]?\\d+年|\\d+年[以上の]?経験'
          AND l.raw_body IS NOT NULL
    """)
    def exp_formatter(r):
        m = re.search(r'経験[約]?\d+年|\d+年[以上の]?経験', r.get('raw_body') or '')
        found = m.group(0) if m else '?'
        return f"name={r['name']} | 本文に「{found}」| {r['subject'][:40]}"
    check(6, 'experience_years=NULLなのに本文に経験年数がある', rows, exp_formatter)

    # ── ⑦ experience_years が異常値 ─────────────────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.experience_years
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND (c.experience_years > 50 OR c.experience_years < 0)
    """)
    check(7, 'experience_yearsが異常値（50超 or 負数）', rows,
          lambda r: f"name={r['name']} | years={r['experience_years']} | {r['subject'][:40]}")

    # ── ⑧ desired_rate が異常値 ──────────────────────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.desired_rate
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.desired_rate IS NOT NULL
          AND (
            c.desired_rate ~ '^\\d+$'
            AND (CAST(c.desired_rate AS INTEGER) < 10 OR CAST(c.desired_rate AS INTEGER) > 300)
          )
    """)
    check(8, 'desired_rateが異常値（10万以下 or 300万超）', rows,
          lambda r: f"name={r['name']} | rate={r['desired_rate']} | {r['subject'][:40]}")

    # ── ⑨ from_company が自社名になっている ─────────────────────
    own_names_sql = ', '.join(f"'{n}'" for n in OWN_COMPANY_NAMES)
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.from_company
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.from_company IN ({own_names_sql})
    """)
    check(9, 'from_companyが自社名（受信側の会社名）になっている', rows,
          lambda r: f"name={r['name']} | company={r['from_company']} | from={r['from_address']}")

    # ── ⑩ from_company と差出人ドメインが無関係 ─────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, c.from_company
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND c.from_company IS NOT NULL
          AND c.from_company NOT IN ('不明', '', '1社先')
          AND l.from_address NOT ILIKE '%' || split_part(
                regexp_replace(c.from_company, '株式会社|合同会社|有限会社|(株)|(有)', '', 'g'),
                '', 1) || '%'
    """)
    # Python側でドメイン↔会社名の簡易突合
    mismatches = []
    for r in rows:
        company = (r.get('from_company') or '').replace('株式会社','').replace('合同会社','').replace('有限会社','').strip()
        domain = r.get('from_address', '').split('@')[-1].split('.')[0].lower()
        # ローマ字変換は難しいのでGFD等の短縮名で簡易判定
        if len(company) >= 2 and domain and company[:2].lower() not in domain and domain not in company.lower():
            mismatches.append(r)
    check(10, 'from_companyと差出人ドメインが一致しない疑い', mismatches,
          lambda r: f"company={r['from_company']} | from={r['from_address']}")

    # ── ⑪ candidateなのに本文に案件キーワードが多い ──────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name, l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND l.raw_body IS NOT NULL
          AND (
            l.raw_body LIKE '%ご提案をお待ち%'
            OR l.raw_body LIKE '%管理ID%'
            OR l.raw_body LIKE '%清算幅%'
            OR l.raw_body LIKE '%合う人材%'
          )
    """)
    check(11, 'candidate保存なのに本文に案件キーワードがある（分類ミス疑い）', rows,
          lambda r: f"name={r['name']} | {r['subject'][:60]}")

    # ── ⑫ projectなのに本文に人材キーワードが多い ────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, p.title, l.raw_body
        FROM ai_logs l
        JOIN projects p ON p.id = l.linked_id
        WHERE l.type = 'project'
          AND l.created_at >= {since}
          AND l.raw_body IS NOT NULL
          AND (
            l.raw_body LIKE '%スキルシート%'
            OR l.raw_body LIKE '%即日参画%'
            OR l.raw_body LIKE '%ご要員%'
            OR l.raw_body LIKE '%BP要員%'
          )
    """)
    check(12, 'project保存なのに本文に人材キーワードがある（分類ミス疑い）', rows,
          lambda r: f"title={r['title'][:40]} | {r['subject'][:40]}")

    # ── ⑬ スキル数=0なのに本文にスキル単語がある ─────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name,
               jsonb_array_length(COALESCE(c.skills, '[]'::jsonb)) as skill_count,
               l.raw_body
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND jsonb_array_length(COALESCE(c.skills, '[]'::jsonb)) = 0
          AND l.raw_body IS NOT NULL
    """)
    filtered = []
    for r in rows:
        body = r.get('raw_body') or ''
        found = [kw for kw in SKILL_KEYWORDS if kw.lower() in body.lower()]
        if found:
            r['found_skills'] = found[:3]
            filtered.append(r)
    check(13, 'スキル数=0なのに本文にスキルキーワードがある', filtered,
          lambda r: f"name={r['name']} | 本文スキル例: {r.get('found_skills',[])} | {r['subject'][:40]}")

    # ── ⑭ スキル数が50以上（過剰抽出） ──────────────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, c.name,
               jsonb_array_length(COALESCE(c.skills, '[]'::jsonb)) as skill_count
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND jsonb_array_length(COALESCE(c.skills, '[]'::jsonb)) >= 50
    """)
    check(14, 'スキル数が50以上（過剰抽出疑い）', rows,
          lambda r: f"name={r['name']} | skill_count={r['skill_count']} | {r['subject'][:40]}")

    # ── ⑮ 抽出スキルが本文に存在しない（ハルシネーション） ─────────
    rows = run_query(f"""
        SELECT c.id, c.name, c.skills, l.raw_body, l.subject
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND l.raw_body IS NOT NULL
          AND jsonb_array_length(COALESCE(c.skills, '[]'::jsonb)) > 0
        LIMIT 50
    """)
    hallucinations = []
    for r in rows:
        body = (r.get('raw_body') or '').lower()
        skills = r.get('skills') or []
        if isinstance(skills, str):
            try: skills = json.loads(skills)
            except: skills = []
        ghost_skills = []
        for s in skills:
            name = (s.get('name') if isinstance(s, dict) else str(s)).lower()
            if name and len(name) >= 3 and name not in body:
                ghost_skills.append(name)
        if len(ghost_skills) >= 3:  # 3つ以上本文にないスキルがあれば報告
            r['ghost_skills'] = ghost_skills[:5]
            hallucinations.append(r)
    check(15, '抽出スキルが本文に存在しない（ハルシネーション疑い）', hallucinations,
          lambda r: f"name={r['name']} | 本文外スキル: {r.get('ghost_skills',[])} | {r['subject'][:40]}")

    # ── ⑯ raw_body が空 or 100文字以下 ──────────────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, l.type,
               length(l.raw_body) as body_len
        FROM ai_logs l
        WHERE l.type IN ('candidate', 'project')
          AND l.created_at >= {since}
          AND (l.raw_body IS NULL OR length(l.raw_body) < 100)
    """)
    check(16, 'raw_bodyが空 or 100文字未満（本文取得失敗疑い）', rows,
          lambda r: f"type={r['type']} | body_len={r['body_len']} | {r['subject'][:50]}")

    # ── ⑰ raw_body にHTMLタグが残っている ───────────────────────
    rows = run_query(f"""
        SELECT l.from_address, l.subject, l.type
        FROM ai_logs l
        WHERE l.type IN ('candidate', 'project')
          AND l.created_at >= {since}
          AND l.raw_body IS NOT NULL
          AND l.raw_body ~ '<(html|div|span|p|br|table|td)[^>]*>'
    """)
    check(17, 'raw_bodyにHTMLタグが残っている（stripHtml失敗）', rows,
          lambda r: f"type={r['type']} | {r['subject'][:60]}")

    # ── ⑱ raw_body の日本語率が低い（文字化けや英語本文の混入） ───
    rows = run_query(f"""
        SELECT l.from_address, l.subject, l.raw_body
        FROM ai_logs l
        WHERE l.type = 'candidate'
          AND l.created_at >= {since}
          AND l.raw_body IS NOT NULL
          AND length(l.raw_body) > 200
        LIMIT 100
    """)
    low_jp = []
    for r in rows:
        body = r.get('raw_body') or ''
        jp_chars = len(re.findall(r'[\u3040-\u9fff]', body))
        total = max(len(body), 1)
        jp_ratio = jp_chars / total
        if jp_ratio < 0.05:  # 5%未満
            r['jp_ratio'] = round(jp_ratio * 100, 1)
            low_jp.append(r)
    check(18, 'raw_bodyの日本語率が5%未満（文字化け or 英語本文）', low_jp,
          lambda r: f"jp_ratio={r.get('jp_ratio')}% | {r['subject'][:60]}")

    # ── ⑲ 同一from+subjectで10分以内に複数ログ（DEDUP漏れ） ──────
    rows = run_query(f"""
        SELECT from_address, subject, COUNT(*) as cnt,
               MIN(created_at AT TIME ZONE 'Asia/Tokyo') as first_at
        FROM ai_logs
        WHERE type IN ('candidate', 'project')
          AND created_at >= {since}
        GROUP BY from_address, subject
        HAVING COUNT(*) >= 2
    """)
    check(19, '同一from+subjectで複数ログ（DEDUP漏れ疑い）', rows,
          lambda r: f"count={r['cnt']} | {r['subject'][:50]} | from={r['from_address']}")

    # ── ⑳ 同一 linked_id に複数のai_logs ────────────────────────
    rows = run_query(f"""
        SELECT linked_id, COUNT(*) as cnt, MIN(type) as type,
               MIN(created_at AT TIME ZONE 'Asia/Tokyo') as first_at
        FROM ai_logs
        WHERE linked_id IS NOT NULL
          AND created_at >= {since}
        GROUP BY linked_id
        HAVING COUNT(*) >= 2
    """)
    check(20, '同一linked_idに複数のai_logs（二重解析疑い）', rows,
          lambda r: f"linked_id={str(r['linked_id'])[:8]} | count={r['cnt']} | type={r['type']}")

    # ── ㉑ duration_ms > 30秒 ────────────────────────────────────
    rows = run_query(f"""
        SELECT from_address, subject, type, model, duration_ms
        FROM ai_logs
        WHERE created_at >= {since}
          AND duration_ms > 30000
        ORDER BY duration_ms DESC
    """)
    check(21, 'AI呼び出しが30秒超（タイムアウトリスク）', rows,
          lambda r: f"model={r['model']} | {r['duration_ms']}ms | {r['subject'][:40]}")

    # ── ㉒ status=error のログ ────────────────────────────────────
    rows = run_query(f"""
        SELECT from_address, subject, model, error_message
        FROM ai_logs
        WHERE status = 'error'
          AND created_at >= {since}
        ORDER BY created_at DESC
    """)
    check(22, 'status=errorのログ', rows,
          lambda r: f"model={r['model']} | error={str(r['error_message'])[:80]}")

    # ── ㉓ linked_id があるのにcandidate/project が存在しない ─────
    rows = run_query(f"""
        SELECT l.id, l.type, l.from_address, l.subject, l.linked_id
        FROM ai_logs l
        LEFT JOIN candidates c ON c.id = l.linked_id AND l.type = 'candidate'
        LEFT JOIN projects p ON p.id = l.linked_id AND l.type = 'project'
        WHERE l.linked_id IS NOT NULL
          AND l.created_at >= {since}
          AND c.id IS NULL
          AND p.id IS NULL
    """)
    check(23, 'linked_idがあるのにcandidate/projectレコードが存在しない', rows,
          lambda r: f"type={r['type']} | {r['subject'][:50]}")

    # ── ㉔ type=candidateでlinked_id=NULL（DB保存失敗） ──────────
    rows = run_query(f"""
        SELECT from_address, subject, status, error_message
        FROM ai_logs
        WHERE type = 'candidate'
          AND status = 'success'
          AND linked_id IS NULL
          AND created_at >= {since}
    """)
    check(24, 'type=candidate・status=successなのにlinked_id=NULL（DB保存失敗）', rows,
          lambda r: f"{r['subject'][:60]} | from={r['from_address']}")

    # ══════════════════════════════════════════════════════════════
    # 同一人物疑いチェック（candidates テーブル全体を対象）
    # ══════════════════════════════════════════════════════════════
    print()
    print('─' * 50)
    print('【同一人物疑いチェック】（prod環境 全件対象）')
    print('─' * 50)

    # ── D01 同一メールアドレスで複数レコード ─────────────────────
    rows = run_query("""
        SELECT email, COUNT(*) as cnt,
               string_agg(name, ' / ' ORDER BY created_at) as names,
               string_agg(id::text, ',' ORDER BY created_at) as ids
        FROM candidates
        WHERE data_env = 'prod'
          AND email IS NOT NULL
        GROUP BY email
        HAVING COUNT(*) >= 2
        ORDER BY cnt DESC
    """)
    check('D01', '同一メールアドレスで複数レコード（upsert漏れ）', rows,
          lambda r: f"email={r['email']} | count={r['cnt']} | names={r['names']}")

    # ── D02 同一名前 × 同一from_company ──────────────────────────
    rows = run_query("""
        SELECT name, from_company, COUNT(*) as cnt,
               string_agg(id::text, ',' ORDER BY created_at) as ids,
               MIN(created_at AT TIME ZONE 'Asia/Tokyo') as first_at,
               MAX(created_at AT TIME ZONE 'Asia/Tokyo') as last_at
        FROM candidates
        WHERE data_env = 'prod'
          AND name IS NOT NULL
          AND name NOT IN ('不明', '')
          AND from_company IS NOT NULL
        GROUP BY name, from_company
        HAVING COUNT(*) >= 2
        ORDER BY cnt DESC
        LIMIT 30
    """)
    check('D02', '同一名前×同一会社で複数レコード', rows,
          lambda r: f"name={r['name']} | company={r['from_company']} | count={r['cnt']} | {str(r['first_at'])[:10]}〜{str(r['last_at'])[:10]}")

    # ── D03 同一名前 × 近い経験年数（±2年）────────────────────
    rows = run_query("""
        SELECT a.name,
               a.experience_years as years_a, b.experience_years as years_b,
               a.from_company as company_a, b.from_company as company_b,
               a.id as id_a, b.id as id_b
        FROM candidates a
        JOIN candidates b ON a.name = b.name AND a.id < b.id
        WHERE a.data_env = 'prod' AND b.data_env = 'prod'
          AND a.name IS NOT NULL AND a.name NOT IN ('不明', '')
          AND a.experience_years IS NOT NULL AND b.experience_years IS NOT NULL
          AND ABS(a.experience_years - b.experience_years) <= 2
        ORDER BY a.name
        LIMIT 30
    """)
    check('D03', '同一名前で経験年数が±2年以内の別レコード', rows,
          lambda r: f"name={r['name']} | years={r['years_a']}↔{r['years_b']} | {r['company_a']} / {r['company_b']}")

    # ── D04 同一from_address × イニシャルが同じ ─────────────────
    rows = run_query("""
        SELECT l.from_address,
               c.name,
               COUNT(*) OVER (PARTITION BY l.from_address, c.name) as cnt,
               c.id,
               c.from_company,
               c.created_at AT TIME ZONE 'Asia/Tokyo' as jst
        FROM candidates c
        JOIN ai_logs l ON l.linked_id = c.id
        WHERE c.data_env = 'prod'
          AND c.name IS NOT NULL
          AND length(c.name) <= 3
        ORDER BY l.from_address, c.name, c.created_at
    """)
    # Python側で from_address × name でグループ化してcnt>=2のみ
    from collections import defaultdict
    groups = defaultdict(list)
    for r in rows:
        key = (r.get('from_address',''), r.get('name',''))
        groups[key].append(r)
    dup_initials = []
    for (addr, name), items in groups.items():
        if len(items) >= 2:
            dup_initials.append({
                'from_address': addr,
                'name': name,
                'cnt': len(items),
                'ids': [str(i.get('id',''))[:8] for i in items],
            })
    check('D04', '同一差出人からイニシャルが同じ人材が複数登録', dup_initials,
          lambda r: f"name={r['name']} | from={r['from_address']} | count={r['cnt']}")

    # ── D05 スキルセット重複率80%以上の別レコード ────────────────
    rows = run_query("""
        SELECT
          a.id as id_a, a.name as name_a, a.from_company as company_a,
          b.id as id_b, b.name as name_b, b.from_company as company_b,
          jsonb_array_length(COALESCE(a.skills,'[]'::jsonb)) as skills_a,
          jsonb_array_length(COALESCE(b.skills,'[]'::jsonb)) as skills_b,
          (
            SELECT COUNT(*) FROM jsonb_array_elements_text(COALESCE(a.skills,'[]'::jsonb)) sa
            WHERE sa IN (SELECT jsonb_array_elements_text(COALESCE(b.skills,'[]'::jsonb)))
          ) as common_count
        FROM candidates a
        JOIN candidates b ON a.id < b.id
        WHERE a.data_env = 'prod' AND b.data_env = 'prod'
          AND jsonb_array_length(COALESCE(a.skills,'[]'::jsonb)) >= 5
          AND jsonb_array_length(COALESCE(b.skills,'[]'::jsonb)) >= 5
        HAVING (
            SELECT COUNT(*) FROM jsonb_array_elements_text(COALESCE(a.skills,'[]'::jsonb)) sa
            WHERE sa IN (SELECT jsonb_array_elements_text(COALESCE(b.skills,'[]'::jsonb)))
          ) * 1.0 / LEAST(
            jsonb_array_length(COALESCE(a.skills,'[]'::jsonb)),
            jsonb_array_length(COALESCE(b.skills,'[]'::jsonb))
          ) >= 0.8
        ORDER BY common_count DESC
        LIMIT 20
    """)
    check('D05', 'スキルセットの重複率80%以上の別レコード（同一人物疑い）', rows,
          lambda r: f"name={r['name_a']}({r['company_a']}) ↔ {r['name_b']}({r['company_b']}) | 共通{r['common_count']}件/{min(int(r['skills_a']),int(r['skills_b']))}件")

    # ── D06 duplicate_flag=true なのに merged_into が未設定 ───────
    rows = run_query("""
        SELECT id, name, from_company, email,
               created_at AT TIME ZONE 'Asia/Tokyo' as jst
        FROM candidates
        WHERE data_env = 'prod'
          AND duplicate_flag = true
          AND merged_into IS NULL
        ORDER BY created_at DESC
        LIMIT 20
    """)
    check('D06', 'duplicate_flag=trueなのにmerged_into未設定（放置された重複疑い）', rows,
          lambda r: f"name={r['name']} | company={r['from_company']} | {str(r['jst'])[:10]}")

    # ── D07 同一from_company × 近い経験年数 × 名前が不明 ─────────
    rows = run_query("""
        SELECT a.from_company,
               a.experience_years as years_a, b.experience_years as years_b,
               a.id as id_a, b.id as id_b,
               a.created_at AT TIME ZONE 'Asia/Tokyo' as jst_a,
               b.created_at AT TIME ZONE 'Asia/Tokyo' as jst_b
        FROM candidates a
        JOIN candidates b ON a.from_company = b.from_company AND a.id < b.id
        WHERE a.data_env = 'prod' AND b.data_env = 'prod'
          AND a.name IN ('不明', '') AND b.name IN ('不明', '')
          AND a.experience_years IS NOT NULL AND b.experience_years IS NOT NULL
          AND ABS(a.experience_years - b.experience_years) <= 1
          AND a.from_company IS NOT NULL
        ORDER BY a.from_company
        LIMIT 20
    """)
    check('D07', '名前=不明 × 同一会社 × 経験年数が±1年（同一人物疑い）', rows,
          lambda r: f"company={r['from_company']} | years={r['years_a']}↔{r['years_b']} | {str(r['jst_a'])[:10]} / {str(r['jst_b'])[:10]}")

    # ── D08 7日以内に同一from_addressから「名前=不明」が3件以上 ───
    rows = run_query("""
        SELECT l.from_address, COUNT(*) as cnt,
               MIN(l.created_at AT TIME ZONE 'Asia/Tokyo') as first_at
        FROM ai_logs l
        JOIN candidates c ON c.id = l.linked_id
        WHERE c.data_env = 'prod'
          AND c.name IN ('不明', '')
          AND l.created_at >= NOW() - INTERVAL '7 days'
        GROUP BY l.from_address
        HAVING COUNT(*) >= 3
        ORDER BY cnt DESC
    """)
    check('D08', '7日以内に同一差出人から「名前=不明」が3件以上（一括送信スパム疑い）', rows,
          lambda r: f"from={r['from_address']} | count={r['cnt']}")

    # ── サマリー ─────────────────────────────────────────────────
    print()
    print('=' * 50)
    print('チェック完了。❌ の項目を確認してください。')


if __name__ == '__main__':
    main()
