"""
AkiNavi HR-AI — HF Spaces 品質チェックバッチ
- CPU only / 無料枠のみ / GPU 禁止
- Supabase pg_cron から夜間バッチとして呼び出す（UI からは参照しない）
- /health : キープアライブ + モデル状態確認
- /run_quality_check : parsedGrid から skillYears 再抽出 + スキル漏れ検出
"""

import json
import logging
import os
import re
import asyncio
import datetime
from contextlib import asynccontextmanager
from difflib import SequenceMatcher
from typing import Optional

import httpx
from fastapi import FastAPI, Header, HTTPException
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ── 環境変数 ──────────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
# pg_cron が X-Api-Secret ヘッダーで送るシークレット（任意・未設定なら認証スキップ）
API_SECRET = os.environ.get("API_SECRET", "")
# GitHub Issue 作成用（任意・未設定ならIssue作成スキップ）
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = "kzmiyamura/akinavi-hr-ai-aws"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ── グローバルモデル状態 ───────────────────────────────────────────────────────
llm = None          # llama-cpp-python の Llama インスタンス
_models_loading = False
_models_ready = False


def load_models() -> None:
    global llm, _models_ready
    logger.info("[models] ロード開始")

    # Qwen2.5-0.5B-Instruct Q4_K_M（CPU 推論・約400MB）
    try:
        from huggingface_hub import hf_hub_download
        from llama_cpp import Llama

        model_path = hf_hub_download(
            repo_id="Qwen/Qwen2.5-0.5B-Instruct-GGUF",
            filename="qwen2.5-0.5b-instruct-q4_k_m.gguf",
        )
        llm = Llama(
            model_path=model_path,
            n_ctx=8192,
            n_threads=2,   # CPU Basic は 2 vCPU
            n_gpu_layers=0,  # CPU only
            verbose=False,
        )
        logger.info("[models] Qwen2.5-0.5B ロード完了")
    except Exception as e:
        logger.warning(f"[models] LLM ロード失敗（ルールベースのみで続行）: {e}")

    _models_ready = True
    logger.info("[models] 準備完了")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _models_loading
    _models_loading = True
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, load_models)
    _models_loading = False
    yield


app = FastAPI(title="AkiNavi Quality Check", lifespan=lifespan)


# ── 認証 ─────────────────────────────────────────────────────────────────────
def verify_secret(x_api_secret: Optional[str]) -> None:
    if API_SECRET and x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── グリッド構造解析ユーティリティ ──────────────────────────────────────────────

def _normalize_cell(cell) -> str:
    """セル値を文字列に正規化（HTMLエンティティ除去・空白整理）"""
    s = str(cell or '')
    s = re.sub(r'&#x[0-9a-fA-F]+;', '\n', s)
    s = re.sub(r'&[a-z]+;', ' ', s)
    return s.strip()


def _parse_date_to_months(cell: str) -> int | None:
    """日付セルを 年*12+月 の整数に変換"""
    s = _normalize_cell(cell)
    # 現在進行中
    if re.search(r'現在|現職|在職|継続|present', s, re.IGNORECASE):
        now = datetime.datetime.now(datetime.timezone.utc)
        return now.year * 12 + now.month
    # YYYY年MM月 / YYYY/MM / YYYY-MM
    m = re.match(r'(\d{4})[年/\-](\d{1,2})', s)
    if m:
        return int(m.group(1)) * 12 + int(m.group(2))
    # YY.MM (e.g. "86.10", "16.04") — 50以上は1900年代、未満は2000年代
    m = re.match(r'^(\d{2})\.(\d{2})$', s)
    if m:
        yy, mm = int(m.group(1)), int(m.group(2))
        year = 1900 + yy if yy >= 50 else 2000 + yy
        if 1 <= mm <= 12:
            return year * 12 + mm
    return None


def _split_skills_in_cell(cell: str) -> list[str]:
    """セル内のスキル文字列を分割して候補リストを返す"""
    s = _normalize_cell(cell)
    parts = re.split(r'[\n\r・\u30fb,，、/・]+', s)
    return [p.strip() for p in parts if p.strip() and len(p.strip()) >= 2]


def _find_header_row(rows: list) -> tuple[int, list] | tuple[None, None]:
    """プロジェクト経歴ヘッダー行（期間+スキル列を持つ）を特定"""
    for i, row in enumerate(rows):
        flat = ' '.join(_normalize_cell(c) for c in row)
        has_period = re.search(r'期[\s　]*間|開始|期間', flat)
        has_skill  = re.search(r'言語|ＤＢ|DB|OS|スキル|ツール|ミドル|技術|環境', flat)
        if has_period and has_skill:
            return i, row
    return None, None


def _find_date_columns(header: list) -> tuple[int | None, int | None]:
    """ヘッダー行から開始・終了日付列のインデックスを推定"""
    start_col = end_col = None
    for i, cell in enumerate(header):
        s = _normalize_cell(cell)
        if re.search(r'開始|期[\s　]*間', s) and start_col is None:
            start_col = i
        elif re.search(r'終了', s) and end_col is None:
            end_col = i
    # 終了列未検出なら開始+2（"開始 ～ 終了" の3列構成が典型）
    if start_col is not None and end_col is None:
        end_col = start_col + 2
    return start_col, end_col


def _find_skill_columns(header: list) -> list[int]:
    """ヘッダー行からスキル関連列のインデックスを取得"""
    cols = []
    for i, cell in enumerate(header):
        if re.search(r'言語|ＤＢ|DB|OS|スキル|ツール|ミドル|技術|環境', _normalize_cell(cell)):
            cols.append(i)
    return cols


# ── グリッド構造ベース skillYears 抽出（メイン・LLM不要） ─────────────────────
def extract_skill_years_from_grid(rows: list, skill_master_entries: list) -> dict[str, int]:
    """
    parsedGrid の rows からプロジェクト期間 × スキル列を解析して skillYears を抽出。
    LLM 不要・完全ルールベース。skill_master と照合して既知スキルのみ返す。
    """
    if not rows:
        return {}

    header_idx, header = _find_header_row(rows)
    if header_idx is None:
        return {}

    start_col, end_col = _find_date_columns(header)
    skill_cols = _find_skill_columns(header)

    if start_col is None or not skill_cols:
        return {}

    # skill_master のルックアップセットを構築
    skill_lookup: dict[str, str] = {}  # normalized → original name
    for e in skill_master_entries:
        name = e.get('name', '')
        if name:
            skill_lookup[name.lower().replace(' ', '')] = name
        for alias in (e.get('aliases') or []):
            if alias:
                skill_lookup[alias.lower().replace(' ', '')] = name

    result: dict[str, int] = {}

    for row in rows[header_idx + 1:]:
        if not any(row):
            continue

        # (Nヶ月間) パターンを優先
        flat = ' '.join(_normalize_cell(c) for c in row)
        m_mo = re.search(r'[\(（](\d+)[ヶか]月間?[\)）]', flat)
        if m_mo:
            months = int(m_mo.group(1))
        else:
            s_val = _parse_date_to_months(_normalize_cell(row[start_col]) if start_col < len(row) else '')
            e_val = _parse_date_to_months(_normalize_cell(row[end_col]) if end_col is not None and end_col < len(row) else '')
            if s_val and e_val and e_val > s_val:
                months = e_val - s_val
            else:
                continue

        if months <= 0 or months > 600:
            continue

        for col in skill_cols:
            if col >= len(row):
                continue
            for part in _split_skills_in_cell(_normalize_cell(row[col])):
                part_norm = part.lower().replace(' ', '')
                if len(part_norm) < 2:
                    continue
                # 完全一致 → 前方一致 → 部分一致の順で照合
                matched = skill_lookup.get(part_norm)
                if not matched:
                    for key, name in skill_lookup.items():
                        if len(key) >= 3 and (part_norm.startswith(key) or key in part_norm):
                            matched = name
                            break
                if matched and matched.lower() not in AUTO_ADD_BLOCKLIST:
                    result[matched] = result.get(matched, 0) + months

    logger.info(f"[grid] skillYears抽出: {len(result)}件 ({list(result.keys())[:5]}...)")
    return result


# ── テキストパターン fallback（「スキル名 X年」形式） ─────────────────────────
def extract_skill_years_rules(rows: list[list[str]]) -> dict[str, int]:
    """テキストパターンで 'スキル名 X年' を抽出する（グリッド解析失敗時のフォールバック）"""
    result: dict[str, int] = {}
    for row in rows:
        for cell in row:
            for seg in re.split(r"[,、，\n]", _normalize_cell(cell)):
                m = re.match(r"^(.+?)\s+(\d+(?:\.\d+)?)年(?:[^\d]|$)", seg.strip())
                if not m:
                    continue
                skill = m.group(1).strip()
                colon = max(skill.rfind(":"), skill.rfind("："))
                if colon >= 0:
                    skill = skill[colon + 1:].strip()
                years = float(m.group(2))
                if skill and not skill[0].isdigit() and len(skill) <= 50 and 0 < years <= 50:
                    result[skill] = int(years * 12)
    return result


# ── skill_master をキャッシュ ─────────────────────────────────────────────────
_skill_master_cache: list[dict] | None = None


def get_skill_master() -> list[dict]:
    global _skill_master_cache
    if _skill_master_cache is None:
        res = supabase.from_("skill_master").select("name, aliases, category").limit(2000).execute()
        _skill_master_cache = res.data or []
        logger.info(f"[skill_master] {len(_skill_master_cache)} 件ロード")
    return _skill_master_cache


# ── 自動追加しないスキルのブロックリスト ──────────────────────────────────────
# プロトコル・汎用語・誤検知しやすい用語を除外
AUTO_ADD_BLOCKLIST = {
    "http", "https", "ftp", "smtp", "tcp", "udp", "ssl", "tls", "dns", "ssh",
    "ada", "xml", "json", "yaml", "csv", "pdf", "api",
    "windows", "unix",  # 汎用すぎる（特定バージョンは許可）
}


def count_occurrences(text: str, keyword: str) -> int:
    """テキスト中でキーワードが何回出現するかカウント（スペースなし比較）"""
    kw = keyword.lower().replace(" ", "")
    t = text.lower().replace(" ", "")
    if len(kw) < 3:
        return 0
    count = 0
    pos = 0
    while True:
        idx = t.find(kw, pos)
        if idx == -1:
            break
        count += 1
        pos = idx + 1
    return count


# ── スキル漏れ検出 ────────────────────────────────────────────────────────────
def detect_missing_skills(
    rows: list[list[str]],
    existing_skills: list[str],
    full_text: str = "",
) -> list[dict]:
    """
    parsedGrid / full_text に出現するが candidates.skills に未登録のスキルを検出する。
    戻り値: [{"name": スキル名, "count": 出現回数}, ...]
    """
    skill_master = get_skill_master()
    if not skill_master:
        return []

    # グリッド全テキスト（rows がある場合）
    grid_text = " ".join(
        cell for row in rows for cell in row if cell and cell.strip()
    )
    # full_text も合わせて検索対象にする
    search_text = (grid_text + " " + full_text).strip()
    if not search_text:
        return []

    existing_lower = {s.lower() for s in (existing_skills or [])}
    missing = []

    for entry in skill_master:
        name: str = entry.get("name", "")
        aliases: list = entry.get("aliases") or []
        candidates_to_check = [name] + aliases

        # 既に登録済みならスキップ
        if any(c.lower() in existing_lower for c in candidates_to_check):
            continue

        # ブロックリストのスキルは自動追加しない
        if name.lower() in AUTO_ADD_BLOCKLIST:
            continue

        # 出現回数を確認（最も多い候補の回数を採用）
        max_count = 0
        for cand in candidates_to_check:
            if len(cand.replace(" ", "")) < 3:
                continue
            c = count_occurrences(search_text, cand)
            if c > max_count:
                max_count = c

        # 2回以上出現したスキルのみ対象
        if max_count >= 2:
            missing.append({"name": name, "count": max_count})

    # 出現回数降順でソート、最大20件
    missing.sort(key=lambda x: x["count"], reverse=True)
    return missing[:20]


# ── GitHub Issue 日次サマリー作成 ─────────────────────────────────────────────
async def create_summary_issue(stats: dict, problems: list[dict]) -> None:
    """品質チェック結果を GitHub Issue としてサマリー登録する"""
    if not GITHUB_TOKEN:
        logger.info("[issue] GITHUB_TOKEN 未設定のため Issue 作成スキップ")
        return

    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    title = f"[HF品質チェック] {today}"

    lines = [
        f"## HF Spaces 品質チェック結果 {today}",
        "",
        "| 項目 | 件数 |",
        "|---|---|",
        f"| 処理候補者数 | {stats.get('processed', 0)} |",
        f"| skillYears 補完 | {stats.get('skill_years_updated', 0)} |",
        f"| スキル自動追加（候補） | {stats.get('skills_auto_added', 0)} |",
        f"| 漏れスキル検出数 | {stats.get('missing_skills_found', 0)} |",
        f"| エラー | {stats.get('errors', 0)} |",
    ]

    if problems:
        lines += ["", "### 取得できなかった項目がある候補者", ""]
        for p in problems[:15]:
            tags = ", ".join(p["missing"])
            lines.append(f"- **{p['name']}**（id: `{p['id']}`）: {tags} が空")

    body = "\n".join(lines)

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"https://api.github.com/repos/{GITHUB_REPO}/issues",
                headers={
                    "Authorization": f"Bearer {GITHUB_TOKEN}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={"title": title, "body": body, "labels": ["quality-check"]},
            )
        if res.status_code == 201:
            data = res.json()
            logger.info(f"[issue] 作成完了: #{data['number']} {data['html_url']}")
        else:
            logger.warning(f"[issue] 作成失敗 HTTP {res.status_code}: {res.text[:200]}")
    except Exception as e:
        logger.error(f"[issue] 作成エラー: {e}")


# ── エンドポイント ────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"ok": True, "service": "akinavi-quality-check"}


@app.get("/health")
def health():
    return {
        "ok": True,
        "models_ready": _models_ready,
        "models_loading": _models_loading,
        "llm": llm is not None,
    }


@app.get("/debug")
async def debug(x_api_secret: Optional[str] = Header(None, alias="x-api-secret")):
    """候補者取得状況を診断する"""
    verify_secret(x_api_secret)
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
    res = (
        supabase.from_("candidates")
        .select("id, name, raw_profile->hfQualityCheckedAt, raw_profile->parsedGrid, raw_profile->text")
        .eq("data_env", "prod")
        .eq("duplicate_flag", False)
        .is_("merged_into", None)
        .gte("created_at", since)
        .limit(5)
        .execute()
    )
    rows = res.data or []
    summary = []
    for r in rows:
        rp_text = r.get("text") or ""
        summary.append({
            "id": r["id"],
            "name": r.get("name"),
            "has_parsed_grid": r.get("parsedGrid") is not None,
            "has_text": bool(rp_text),
            "text_len": len(rp_text) if rp_text else 0,
            "already_checked": r.get("hfQualityCheckedAt") is not None,
        })
    return {"total_fetched": len(rows), "since": since, "samples": summary}


@app.api_route("/run_quality_check", methods=["GET", "POST"])
async def run_quality_check(
    x_api_secret: Optional[str] = Header(None, alias="x-api-secret"),
):
    verify_secret(x_api_secret)

    logger.info("[quality] HF Spaces 起動確認 OK")
    return {"ok": True, "message": "HF Spaces 起動確認 OK"}

    if _models_loading:
        return {"ok": False, "reason": "models_loading", "retry_after": 60}

    stats = {"processed": 0, "skill_years_updated": 0, "missing_skills_found": 0, "errors": 0}
    problem_candidates: list[dict] = []  # 取得できなかった項目がある候補者

    try:
        # parsedGrid があり、まだ品質チェック未実施 or 7日以内の候補者を対象
        since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
        res = (
            supabase.from_("candidates")
            .select("id, raw_profile, skills, name")
            .eq("data_env", "prod")
            .eq("duplicate_flag", False)
            .is_("merged_into", None)
            .gte("created_at", since)
            .limit(30)
            .execute()
        )
        candidates = res.data or []

        for candidate in candidates:
            try:
                raw_profile: dict = candidate.get("raw_profile") or {}
                parsed_grid = raw_profile.get("parsedGrid")  # None でも続行（text フォールバックあり）

                # 既に品質チェック済みならスキップ（24時間以内）
                last_check = raw_profile.get("hfQualityCheckedAt", "")
                if last_check:
                    checked_at = datetime.datetime.fromisoformat(last_check.replace("Z", "+00:00"))
                    age = datetime.datetime.now(datetime.timezone.utc) - checked_at
                    if age.total_seconds() < 86400:
                        continue

                rows: list[list[str]] = parsed_grid.get("rows", []) if parsed_grid else []
                source: str = parsed_grid.get("source", "unknown") if parsed_grid else "text"

                # raw_profile.text から添付テキスト部分を取り出す（本文+添付を結合済み）
                full_text: str = raw_profile.get("text", "") or ""
                attach_text: str = ""
                if "\n\n--- 添付 ---\n" in full_text:
                    attach_text = full_text.split("\n\n--- 添付 ---\n", 1)[1]

                if not rows and not full_text:
                    continue

                stats["processed"] += 1
                updates: dict = {}

                # ── skillYears 再抽出 ──────────────────────────────────────
                existing_sy: dict = raw_profile.get("skillYears") or {}
                existing_count = len([k for k in existing_sy if not k.startswith("_")])

                if existing_count < 3:
                    new_sy: dict = {}
                    if rows:
                        # parsedGrid がある場合: グリッド構造解析（LLM不要）
                        new_sy = extract_skill_years_from_grid(rows, get_skill_master())
                        if not new_sy:
                            new_sy = extract_skill_years_rules(rows)
                    if not new_sy and full_text:
                        # parsedGrid がない場合: raw_profile.text からルールベース抽出
                        text_rows = [[line] for line in full_text.splitlines() if line.strip()]
                        new_sy = extract_skill_years_rules(text_rows)

                    if new_sy:
                        merged_sy = {**existing_sy, **new_sy}
                        updates["skillYears"] = merged_sy
                        stats["skill_years_updated"] += 1
                        logger.info(
                            f"[quality] id={candidate['id']} source={source} "
                            f"skillYears+{len(new_sy)}: {list(new_sy.keys())[:5]}"
                        )

                # ── スキル漏れ検出 → candidates.skills に自動マージ ──────
                existing_skills: list = candidate.get("skills") or []
                detect_rows = rows if rows else [[line] for line in (attach_text or full_text).splitlines() if line.strip()]
                missing_entries = detect_missing_skills(detect_rows, existing_skills, full_text=full_text)
                if missing_entries:
                    missing_names = [e["name"] for e in missing_entries]
                    updates["hfDetectedMissingSkills"] = missing_entries  # 出現回数付きで保存
                    stats["missing_skills_found"] += len(missing_names)
                    logger.info(f"[quality] id={candidate['id']} 漏れスキル候補: {missing_names}")

                    # candidates.skills に自動マージ（重複除去）
                    existing_lower = {s.lower() for s in existing_skills}
                    to_add = [n for n in missing_names if n.lower() not in existing_lower]
                    if to_add:
                        merged_skills = existing_skills + to_add
                        updates["_merged_skills"] = merged_skills  # DB 更新時に一括反映
                        stats["skills_auto_added"] = stats.get("skills_auto_added", 0) + len(to_add)
                        logger.info(f"[quality] id={candidate['id']} skills に自動追加: {to_add}")

                # ── 取得できなかった項目を記録（Issue サマリー用） ──────
                missing_fields: list[str] = []
                if not raw_profile.get("prefecture"):
                    missing_fields.append("prefecture")
                if not candidate.get("skills"):
                    missing_fields.append("skills")
                existing_sy_after = {**existing_sy, **(updates.get("skillYears") or {})}
                if len([k for k in existing_sy_after if not k.startswith("_")]) == 0:
                    missing_fields.append("skillYears")
                if missing_fields:
                    problem_candidates.append({
                        "id": candidate["id"],
                        "name": candidate.get("name") or "名前不明",
                        "missing": missing_fields,
                    })

                # ── DB に書き戻し（1回の update にまとめてアトミックに） ──
                updates["hfQualityCheckedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

                merged_skills_final = updates.pop("_merged_skills", None)
                updated_profile = {**raw_profile, **updates}
                db_update: dict = {"raw_profile": updated_profile}
                if merged_skills_final is not None:
                    db_update["skills"] = merged_skills_final
                supabase.from_("candidates").update(db_update).eq("id", candidate["id"]).execute()

            except Exception as e:
                logger.error(f"[quality] id={candidate.get('id')} エラー: {e}")
                stats["errors"] += 1

    except Exception as e:
        logger.error(f"[quality] 全体エラー: {e}")
        stats["fatal_error"] = str(e)

    logger.info(f"[quality] 完了: {stats}")

    # 処理結果を GitHub Issue にサマリー登録
    await create_summary_issue(stats, problem_candidates)

    return {"ok": True, **stats}
