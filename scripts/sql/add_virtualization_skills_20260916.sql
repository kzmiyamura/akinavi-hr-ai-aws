-- 仮想化のスキルが skill_master に1行も無かったので足す（2026-09-16）。
--
-- ■ どうやって見つけたか
--   世の中のIT職種一覧（ユーザー提示）に出てくる技術語が辞書にあるかを総当たりしたところ、
--   生成AI・LLM・RAG・Kubernetes・Unity・Solidity・Verilog 等はすでに登録済みだったのに、
--   **VMware / vSphere / Hyper-V / 仮想化 が1件も無かった**。
--   ローカル控え（D:\akinavi-archive\mail 7,342通）で仮想化関連の語は **569通** に出る。
--
-- ■ なぜ実害があるか
--   docs/ROLE_DEFINITION.md はインフラエンジニアの**必須裏付け**に `VMware` を挙げている。
--   つまり役割判定では使うのに、**スキルとしては一致判定に乗らない**状態だった。
--   案件が「VMware経験者」を必須スキルに挙げても、人材側の VMware がヒットしない。
--
-- ■ 新規行を作ってよい理由
--   skill_master は「既存行を編集する。新規行を作ると canon を奪って一致が壊れる」が原則だが、
--   `%vmware%` `%vsphere%` `%hyper%` `%仮想%` を部分一致で探して**該当0件**を確認済み。
--   奪う相手がいないので新規行が正しい。
--
-- ■ 反映に必要な手順（このSQLだけでは抽出が変わらない）
--   node scripts/export_skill_master.mjs
--   bash scripts/check-and-deploy-edge.sh inbound-email

INSERT INTO skill_master (name, category, aliases) VALUES
  ('VMware', 'infrastructures',
   '["vmware","VMWare","ヴイエムウェア","VMware vSphere","vSphere","ESXi","VMware ESXi","vCenter","VMware Horizon"]'::jsonb),
  ('Hyper-V', 'infrastructures',
   '["hyper-v","HyperV","hyper v","Microsoft Hyper-V"]'::jsonb),
  ('仮想化', 'infrastructures',
   '["仮想化技術","サーバ仮想化","サーバー仮想化","仮想基盤","仮想サーバ","仮想サーバー","virtualization"]'::jsonb)
ON CONFLICT (name) DO UPDATE
  SET category = EXCLUDED.category,
      aliases  = EXCLUDED.aliases;

-- 確認
SELECT name, category, match_count,
       jsonb_array_length(coalesce(aliases, '[]'::jsonb)) AS 別名数
FROM skill_master
WHERE name IN ('VMware', 'Hyper-V', '仮想化')
ORDER BY name;
