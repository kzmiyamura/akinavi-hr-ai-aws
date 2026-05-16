#!/bin/bash
# ============================================================
# AkiNavi Lambda デプロイスクリプト
# 前提条件:
#   1. AWS CLI がインストール済み・設定済み (aws configure)
#   2. 環境変数 LAMBDA_ROLE_ARN が設定済み
#      例: export LAMBDA_ROLE_ARN="arn:aws:iam::123456789012:role/akinavi-lambda-role"
#   3. 環境変数 LAMBDA_API_KEY が設定済み（任意の秘密文字列）
#      例: export LAMBDA_API_KEY="your-secret-key-here"
# ============================================================
set -euo pipefail

REGION="${AWS_BEDROCK_REGION:-us-east-1}"
ROLE_ARN="${LAMBDA_ROLE_ARN:?環境変数 LAMBDA_ROLE_ARN を設定してください}"
API_KEY="${LAMBDA_API_KEY:-}"
FUNCTIONS=("gate-filter" "pdf-processor")

# メモリ・タイムアウト設定
declare -A MEMORY=( ["gate-filter"]="256" ["pdf-processor"]="512" )
declare -A TIMEOUT=( ["gate-filter"]="15" ["pdf-processor"]="60" )

cd "$(dirname "$0")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " AkiNavi Lambda ビルド & デプロイ"
echo " リージョン: ${REGION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ① npm install & ビルド
echo ""
echo "📦 依存パッケージをインストール中..."
npm ci

echo "🔨 TypeScript をビルド中..."
npm run build

# ② 各 Lambda 関数をデプロイ
for FN in "${FUNCTIONS[@]}"; do
  FUNC_NAME="akinavi-${FN}"
  ZIP_PATH="dist/${FN}.zip"
  MEM="${MEMORY[$FN]}"
  TOUT="${TIMEOUT[$FN]}"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 🚀 ${FUNC_NAME}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ZIP 作成
  echo "🗜️  ZIP を作成中: ${ZIP_PATH}"
  rm -f "${ZIP_PATH}"
  (cd "dist/${FN}" && zip -qr "../../${ZIP_PATH}" .)
  echo "   サイズ: $(du -sh "${ZIP_PATH}" | cut -f1)"

  # 環境変数マップ
  ENV_VARS="Variables={AWS_REGION=${REGION}"
  if [[ -n "${API_KEY}" ]]; then
    ENV_VARS="${ENV_VARS},LAMBDA_API_KEY=${API_KEY}"
  fi
  ENV_VARS="${ENV_VARS}}"

  # 既存の Lambda があれば更新、なければ新規作成
  if aws lambda get-function \
      --function-name "${FUNC_NAME}" \
      --region "${REGION}" \
      --query 'Configuration.FunctionArn' \
      --output text 2>/dev/null; then

    echo "🔄 コードを更新中..."
    aws lambda update-function-code \
      --function-name "${FUNC_NAME}" \
      --zip-file "fileb://${ZIP_PATH}" \
      --region "${REGION}" \
      --query 'FunctionArn' \
      --output text

    echo "⚙️  設定を更新中..."
    aws lambda update-function-configuration \
      --function-name "${FUNC_NAME}" \
      --timeout "${TOUT}" \
      --memory-size "${MEM}" \
      --environment "${ENV_VARS}" \
      --region "${REGION}" \
      --query 'FunctionArn' \
      --output text

  else
    echo "🆕 新規作成中..."
    FUNC_ARN=$(aws lambda create-function \
      --function-name "${FUNC_NAME}" \
      --runtime nodejs22.x \
      --role "${ROLE_ARN}" \
      --handler index.handler \
      --zip-file "fileb://${ZIP_PATH}" \
      --timeout "${TOUT}" \
      --memory-size "${MEM}" \
      --environment "${ENV_VARS}" \
      --region "${REGION}" \
      --query 'FunctionArn' \
      --output text)
    echo "   ARN: ${FUNC_ARN}"

    # Function URL の作成（API Gateway 不要）
    echo "🔗 Function URL を作成中..."
    FUNC_URL=$(aws lambda create-function-url-config \
      --function-name "${FUNC_NAME}" \
      --auth-type NONE \
      --region "${REGION}" \
      --query 'FunctionUrl' \
      --output text)

    # パブリックアクセス許可
    aws lambda add-permission \
      --function-name "${FUNC_NAME}" \
      --statement-id "FunctionURLAllowPublicAccess" \
      --action "lambda:InvokeFunctionUrl" \
      --principal "*" \
      --function-url-auth-type NONE \
      --region "${REGION}" \
      --output text > /dev/null

    echo ""
    echo "   ✅ Function URL:"
    echo "   ${FUNC_URL}"
    echo ""
    echo "   ⚠️  この URL を Supabase Secrets に登録してください:"
    if [[ "${FN}" == "gate-filter" ]]; then
      echo "   LAMBDA_GATE_FILTER_URL = ${FUNC_URL}"
    else
      echo "   LAMBDA_PDF_PROCESSOR_URL = ${FUNC_URL}"
    fi
  fi

  echo "✅ ${FUNC_NAME} デプロイ完了"
done

# ③ 既存関数の Function URL を取得して表示
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 📋 現在の Function URL 一覧"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for FN in "${FUNCTIONS[@]}"; do
  FUNC_NAME="akinavi-${FN}"
  URL=$(aws lambda get-function-url-config \
    --function-name "${FUNC_NAME}" \
    --region "${REGION}" \
    --query 'FunctionUrl' \
    --output text 2>/dev/null || echo "未設定")
  echo " ${FUNC_NAME}: ${URL}"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ デプロイ完了！"
echo ""
echo " 次のステップ: Supabase Secrets に以下を追加"
echo "   LAMBDA_GATE_FILTER_URL  = (gate-filter の Function URL)"
echo "   LAMBDA_PDF_PROCESSOR_URL = (pdf-processor の Function URL)"
echo "   LAMBDA_API_KEY          = ${API_KEY:-'(LAMBDA_API_KEY を設定してください)'}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
