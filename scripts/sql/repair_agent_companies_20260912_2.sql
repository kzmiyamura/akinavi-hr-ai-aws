-- agent_companies の掃除・2回目（2026-09-12）
--
-- 1回目の掃除後に最終確認で拾った取りこぼし。
-- 1回目の削除条件が「サブドメイン（ドットが2つ以上）」だったため、
-- apex ドメインを使うなりすまし（lavesasy.me / amazon.co.jp / esdii.org）が残っていた。
-- ドメインの形で機械的に決めず、社名とドメインの食い違いを1件ずつ見て判断している。

begin;

-- ① 機械的に直せる会社名
update agent_companies set company_name = 'ぐっどぴーす株式会社'
 where domain = 'goodpeace.jp' and company_name = '弊社HP：ぐっどぴーす株式会社';

-- ② 派遣会社ではない送信元（なりすまし・サービスの通知メール）
delete from agent_companies
 where domain in (
   'lavesasy.me',                     -- 株式会社クレディセゾン｜Credit Saison Co.
   'amazon.co.jp',                    -- 最終通知
   'esdii.org',                       -- 重要
   'mail.toshiba',                    -- 08_27までにご返信下さい
   'microsoft.com',                   -- Microsoft Corporation（通知メール）
   'athlete-development-edge.com'     -- WADAX GMO, Inc.（サーバの通知メール）
 )
 and (memo is null or btrim(memo) = '');

-- ③ 社名が復元できず、人材も1人も生んでいない行
delete from agent_companies
 where domain in (
   'g-seed.co.jp',   -- React（スキル名が社名になっていた）
   'upsta-j.com',    -- 普段より株式会社
   'acro-net.com'    -- いしだより
 )
 and haken_number is null and shokai_number is null
 and (memo is null or btrim(memo) = '');

commit;
