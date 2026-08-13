-- candidates_lite の現行定義（本番で何が生きているかを確認する）
select pg_get_viewdef('candidates_lite'::regclass, true) as viewdef;
