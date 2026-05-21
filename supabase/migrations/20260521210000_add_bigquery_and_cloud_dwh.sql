-- BigQuery / Redshift / Athena / Azure Synapse 等 DWH/クラウドDBを追加
INSERT INTO skill_master (name, category, aliases, source) VALUES
('BigQuery', 'dwh', '["bigquery","google bigquery","bq","BQ","BigQuery ML","BQML"]'::jsonb, 'seed'),
('Redshift', 'dwh', '["redshift","amazon redshift","AWS Redshift","redshift serverless"]'::jsonb, 'seed'),
('Athena', 'dwh', '["athena","amazon athena","AWS Athena"]'::jsonb, 'seed'),
('Azure Synapse', 'dwh', '["synapse","Azure Synapse Analytics","synapse analytics"]'::jsonb, 'seed'),
('Databricks', 'dwh', '["databricks","databricks platform","spark databricks"]'::jsonb, 'seed'),
('Apache Spark', 'tools', '["spark","pyspark","PySpark","Apache Spark","spark streaming"]'::jsonb, 'seed'),
('Airflow', 'tools', '["airflow","apache airflow","cloud composer"]'::jsonb, 'seed'),
('Looker Studio', 'tools', '["looker studio","google data studio","data studio","GDS"]'::jsonb, 'seed'),
('Power BI', 'tools', '["power bi","powerbi","Power BI Desktop","Microsoft Power BI"]'::jsonb, 'seed'),
('Tableau', 'tools', '["tableau","tableau desktop","tableau server","tableau online"]'::jsonb, 'seed')
ON CONFLICT (name) DO UPDATE SET
  aliases = (
    SELECT to_jsonb(array_agg(DISTINCT v))
    FROM (
      SELECT jsonb_array_elements_text(skill_master.aliases) AS v
      UNION
      SELECT jsonb_array_elements_text(EXCLUDED.aliases) AS v
    ) merged
  );
