#!/usr/bin/env bash
# Edge Function を型チェックしてからデプロイする
# TS2304（未定義変数参照）等の致命的エラーのみを検知して早期失敗させる

FUNCTION=${1:-inbound-email}
TS_FILE="supabase/functions/${FUNCTION}/index.ts"

echo "=== deno check: ${TS_FILE} ==="

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
supabase functions deploy "$FUNCTION"
