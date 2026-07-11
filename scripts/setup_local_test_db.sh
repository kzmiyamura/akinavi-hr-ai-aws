#!/usr/bin/env bash
# ローカルSupabaseテストDB構築スクリプト
# 前提: supabase start 済み（db port 54332 / config.toml のローカル設定）
# 使い方: bash scripts/setup_local_test_db.sh
#
# 本番はダッシュボードでテーブルが作られたため migrations だけでは0から構築できない。
# schema.sql（コアテーブル）→ ALTER系 → skill/station マスタ → ローカルシードの順に適用する。

set -u
DB_URL="postgresql://postgres:postgres@127.0.0.1:54332/postgres"
MIG="supabase/migrations_prod_bak"

run() {
  local file="$1"
  echo "── applying: $file"
  psql "$DB_URL" -v ON_ERROR_STOP=0 -q -f "$file" 2>&1 | grep -E "ERROR|NOTICE" | head -5 || true
}

echo "=== 1. コアテーブル（schema.sql） ==="
run supabase/schema.sql

echo "=== 2. ALTER系（後から追加されたカラム） ==="
run "$MIG/add_data_env.sql"
run "$MIG/add_box_columns.sql"
run "$MIG/add_resume_url.sql"
run "$MIG/add_updated_by.sql"

echo "=== 3. skill_master（作成+シード 約1,660件+RPC） ==="
run "$MIG/20260519062753_add_skill_master.sql"
run "$MIG/20260519062805_seed_skill_master.sql"
run "$MIG/20260519075000_seed_skill_master_extended.sql"
run "$MIG/20260520121447_fix_skill_master_quality.sql"
run "$MIG/20260521210000_add_bigquery_and_cloud_dwh.sql"
run "$MIG/20260529_add_csharp_net_skill.sql"
run "$MIG/20260529_add_performance_tuning_skill.sql"
run "$MIG/20260707_fix_pmo_category.sql"

echo "=== 4. station_master（全国駅マスタ） ==="
run "$MIG/20260527_add_station_master.sql"
run "$MIG/20260529_add_missing_stations.sql"
run "$MIG/20260603_fix_stations_and_skills.sql"
run "$MIG/20260606_upsert_all_stations.sql"

echo "=== 5. ローカルシード（Storageバケット+app_config） ==="
run scripts/local_test_seed.sql

echo "=== 6. 検証 ==="
psql "$DB_URL" -t -c "
SELECT 'candidates: ' || count(*) FROM candidates
UNION ALL SELECT 'skill_master: ' || count(*) FROM skill_master
UNION ALL SELECT 'station_master: ' || count(*) FROM station_master
UNION ALL SELECT 'app_config: ' || count(*) FROM app_config
UNION ALL SELECT 'buckets: ' || count(*) FROM storage.buckets WHERE id = 'attachments';
"
echo "=== 完了 ==="
