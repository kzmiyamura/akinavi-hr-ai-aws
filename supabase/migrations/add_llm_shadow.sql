create table if not exists llm_shadow (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete cascade,
  source text not null,              -- 'attachment' | 'body'
  model text,                        -- haiku | sonnet
  status text,                       -- ok | needs_review | error
  reasons text[],
  projects jsonb,
  skill_years jsonb,
  body_fields jsonb,
  cost_usd numeric,
  ms integer,
  created_at timestamptz default now(),
  unique (candidate_id, source)
);
alter table llm_shadow enable row level security;
select 'llm_shadow created' as ok;
