#!/usr/bin/env bash
# Edge Function を型チェックしてからデプロイする
#
# 実行時に必ず壊れるエラー（TS2304 未定義 / TS2448・TS2454 宣言前に使用 / TS2552 綴り）
# だけを致命として止める。型の互換エラーは既存コードに大量にあるので止めない。
# **見る範囲をここに書いておくこと。** 2026-10-03 まで TS2304 だけを見ていて、
# TDZ が素通りして本番で例外になっていた（詳細は下のコメント）。

FUNCTION=${1:-inbound-email}
TS_FILE="supabase/functions/${FUNCTION}/index.ts"

echo "=== deno check: ${TS_FILE} ==="

# deno が無い環境では「チェックしていない」ことを明示する。
# 2026-08-29 まで、deno 未インストールのマシンでも `|| true` でエラーを握りつぶし、
# 出力に TS2304 が無いという理由で必ず「✅」と表示してデプロイに進んでいた。
# 無検査であることに気づけないのが危険なので、代わりに esbuild で構文だけ確認する。
if ! command -v deno >/dev/null 2>&1; then
  echo "⚠ deno が見つかりません。代わりに tsc で参照エラーだけ検査します。"
  #
  # ⚠ **2026-10-03 まで、この分岐は esbuild の構文チェックだけだった。**
  #    TDZ（宣言より前に使う）は構文としては正しいので必ず素通りし、
  #    deno 未インストールのマシンからのデプロイは**無検査と同じ**だった。
  #    tsc は Deno 固有のエラーを出すが、それを除けば参照エラーは正しく拾える
  #    （実測: attachments の TS2448/TS2454 を両方検出。残るのは Deno 9件だけ）。
  #
  TSC_OUT=$(npx --no-install tsc --noEmit --ignoreConfig --skipLibCheck \
    --target es2022 --module esnext --moduleResolution bundler "$TS_FILE" 2>&1 || true)
  FATAL=$(echo "$TSC_OUT" \
    | grep -E 'TS2304|TS2448|TS2454|TS2552' \
    | grep -v "Cannot find name 'Deno'" || true)
  if [ -n "$FATAL" ]; then
    echo "❌ 実行時に壊れる参照エラーがあります。デプロイを中止します。"
    echo "$FATAL"
    exit 1
  fi
  if npx --no-install esbuild "$TS_FILE" --loader:.ts=ts --outfile=/dev/null >/dev/null 2>&1; then
    echo "✅ 参照エラー・構文エラーなし（型互換は未検査）"
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

# 実行時に必ず壊れるエラーだけを致命とみなす。
#
# ⚠ **2026-10-03 まで TS2304 しか見ていなかった。**
#    そのため TS2448「宣言より前に使っている」が素通りし、
#    MAILER_DAEMON と OWN_DOMAIN のスキップ経路が
#    `Cannot access 'attachments' before initialization` で例外になっていた
#    （ai_logs に36件。夜間健診が検出するまで誰も気付かなかった）。
#    「通った確認が何も見ていない」の3度目。見る範囲を書いておくこと。
#
#   TS2304 … Cannot find name（未定義変数）
#   TS2448 … Block-scoped variable used before its declaration（TDZ）
#   TS2454 … Variable is used before being assigned
#   TS2552 … Cannot find name / did you mean（綴り間違い）
#
# 型の互換（TS2322 等）は既存コードに大量にあるので今は致命にしない。
# 増やすなら一度に1種類ずつ、既存の出力を見てから。
FATAL_CODES='TS2304|TS2448|TS2454|TS2552'
FATAL=$(echo "$CHECK_OUTPUT" | grep -E "$FATAL_CODES" || true)

if [ -n "$FATAL" ]; then
  echo ""
  echo "❌ 実行時に壊れる型エラーが見つかりました。デプロイを中止します。"
  echo "$FATAL"
  exit 1
fi

# 全エラー数を表示（情報として）
ERROR_COUNT=$(echo "$CHECK_OUTPUT" | grep -c "ERROR" || true)
echo "✅ 実行時に壊れるエラーなし（${FATAL_CODES} を検査。型互換エラーは無視: ${ERROR_COUNT}件）"
echo ""
echo "=== supabase functions deploy: ${FUNCTION} ==="
# supabase CLI がPATHに無い環境（ThinkCentre等）は npx 経由にフォールバック
if command -v supabase >/dev/null 2>&1; then
  supabase functions deploy "$FUNCTION"
else
  npx supabase functions deploy "$FUNCTION"
fi
