#!/usr/bin/env bash
# Edge Function を型チェックしてからデプロイする
# TS2304（未定義変数参照）等の致命的エラーのみを検知して早期失敗させる

FUNCTION=${1:-inbound-email}
TS_FILE="supabase/functions/${FUNCTION}/index.ts"

echo "=== deno check: ${TS_FILE} ==="

# deno が無い環境では「チェックしていない」ことを明示する。
# 2026-08-29 まで、deno 未インストールのマシンでも `|| true` でエラーを握りつぶし、
# 出力に TS2304 が無いという理由で必ず「✅」と表示してデプロイに進んでいた。
# 無検査であることに気づけないのが危険なので、代わりに esbuild で構文だけ確認する。
if ! command -v deno >/dev/null 2>&1; then
  echo "⚠ deno が見つかりません。型チェックは実行されません。"
  echo "   代わりに esbuild で構文チェックのみ行います（型エラーは検出できません）。"
  if npx --no-install esbuild "$TS_FILE" --loader:.ts=ts --outfile=/dev/null >/dev/null 2>&1; then
    echo "✅ 構文エラーなし（型チェックは未実施）"
  else
    echo "❌ 構文エラーがあります。デプロイを中止します。"
    npx --no-install esbuild "$TS_FILE" --loader:.ts=ts --outfile=/dev/null
    exit 1
  fi
  echo ""
  echo "=== supabase functions deploy: ${FUNCTION} ==="
  if command -v supabase >/dev/null 2>&1; then
    supabase functions deploy "$FUNCTION"
  else
    npx supabase functions deploy "$FUNCTION"
  fi
  exit $?
fi

# deno check を実行してエラー出力を取得（終了コードは無視）
CHECK_OUTPUT=$(deno check --no-npm "$TS_FILE" 2>&1 || true)

# TS2304: Cannot find name（未定義変数）を抽出
FATAL=$(echo "$CHECK_OUTPUT" | grep "TS2304" || true)

if [ -n "$FATAL" ]; then
  echo ""
  echo "❌ 致命的な型エラー（未定義変数）が見つかりました。デプロイを中止します。"
  echo "$FATAL"
  exit 1
fi

# 全エラー数を表示（情報として）
ERROR_COUNT=$(echo "$CHECK_OUTPUT" | grep -c "ERROR" || true)
echo "✅ 未定義変数エラーなし（既存の型互換エラーは無視: ${ERROR_COUNT}件）"
echo ""
echo "=== supabase functions deploy: ${FUNCTION} ==="
# supabase CLI がPATHに無い環境（ThinkCentre等）は npx 経由にフォールバック
if command -v supabase >/dev/null 2>&1; then
  supabase functions deploy "$FUNCTION"
else
  npx supabase functions deploy "$FUNCTION"
fi
