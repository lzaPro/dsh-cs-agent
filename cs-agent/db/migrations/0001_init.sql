-- 0001 初始 schema
--
-- 设计原则：
--   1. conversations / messages 是会话与聊天记录，7 天滚动清理。
--   2. tickets / ticket_events 是工单与流水，长期保留（事故复盘要用）。
--   3. audit_log 是"谁查了谁"的证据，长期保留且不可篡改。
--   4. outbox 是回复投递队列，保证进程崩溃后不丢消息。
--   5. 所有表都预留 tenant_id，但当前恒为 'default'——多租户将来才做。
--      真正现在就生效的隔离边界是 account_id（客户作用域）。

-- ── 会话 ────────────────────────────────────────────────────────────────────
create table conversations (
  id               bigserial primary key,
  tenant_id        text not null default 'default',
  -- 客户作用域：一次事故属于哪个客户。现在运维侧靠 handoff 参数传递，没有强制。
  account_id       text,
  -- 网关内部的会话键（QQ 里是 "private:<id>" 或 "group:<id>" 这类字符串）。
  external_key     text not null,
  channel          text not null,
  group_id         text,
  group_name       text,
  sender_id        text,
  sender_name      text,
  label            text,
  title            text,
  -- 面板/接口用的访问令牌，沿用现有语义。
  access_token     text,
  -- 指向 DSH 自己的 session store。不要试图替代那张表，只存关联键。
  dsh_session_id   text,
  mode             text not null default 'ai' check (mode in ('ai', 'human')),
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  mode_changed_at  timestamptz,
  constraint conversations_external_key_uniq unique (external_key)
);

-- 从一个 DSH session 反查会话，是面板跳转和故障定位的主要路径。
create unique index conversations_dsh_session_uniq
  on conversations (dsh_session_id)
  where dsh_session_id is not null;

-- 面板按活跃时间倒序列出会话。
create index conversations_last_seen_idx on conversations (last_seen_at desc);

-- ── 消息 ────────────────────────────────────────────────────────────────────
create table messages (
  id               bigserial primary key,
  conversation_id  bigint not null references conversations (id) on delete cascade,
  dsh_session_id   text,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null,
  -- 平台侧的消息 id，用来做入站幂等。
  platform_msg_id  text,
  -- 贯穿一次请求的追踪 id：网关日志、模型调用、投递共用它。
  trace_id         text,
  input_tokens     int,
  output_tokens    int,
  created_at       timestamptz not null default now()
);

create index messages_conv_time_idx on messages (conversation_id, created_at desc);
-- 保留策略按时间删，需要独立索引。
create index messages_created_at_idx on messages (created_at);

create unique index messages_platform_msg_uniq
  on messages (platform_msg_id)
  where platform_msg_id is not null;

-- ── 工单 ────────────────────────────────────────────────────────────────────
create table tickets (
  id               bigserial primary key,
  tenant_id        text not null default 'default',
  account_id       text,
  conversation_id  bigint references conversations (id) on delete set null,
  dsh_session_id   text,
  -- 客服侧交接生成的工单号，重复投递时靠它去重。
  incident_id      text,
  ops_session_id   text,
  state            text not null default 'open' check (state in (
                     'open', 'dispatched', 'running', 'resolved',
                     'needs_human', 'need_info', 'not_found', 'disabled', 'closed'
                   )),
  symptom          text,
  error_signatures jsonb not null default '[]'::jsonb,
  evidence         jsonb not null default '[]'::jsonb,
  success_criteria text,
  result           text,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  updated_at       timestamptz not null default now()
);

create index tickets_state_idx on tickets (state, updated_at desc);
create index tickets_account_idx on tickets (account_id);
create unique index tickets_incident_uniq
  on tickets (incident_id)
  where incident_id is not null;

-- 工单流水：append-only，只能追加，不能改。
create table ticket_events (
  id         bigserial primary key,
  ticket_id  bigint not null references tickets (id) on delete cascade,
  seq        int not null,
  kind       text not null,
  actor      text,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ticket_events_seq_uniq unique (ticket_id, seq)
);

-- ── 回复投递 ────────────────────────────────────────────────────────────────
-- 现在的 outbox.jsonl 只"记账"不重投。这张表把记账升级成真正的投递队列：
-- 先落库、再发送、失败退避重试、发成功才置 sent。
create table outbox (
  id              bigserial primary key,
  conversation_id bigint references conversations (id) on delete set null,
  external_key    text not null,
  channel         text not null,
  payload         jsonb not null,
  -- 同一条回复重复入队时不会发两遍。
  idempotency_key text not null,
  state           text not null default 'pending'
                    check (state in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts        int not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint outbox_idempotency_uniq unique (idempotency_key)
);

-- 取"现在该发的那些行"，部分索引足够。
create index outbox_due_idx on outbox (next_attempt_at)
  where state in ('pending', 'failed');
create index outbox_pending_idx on outbox (conversation_id)
  where state in ('pending', 'sending', 'failed');

-- ── 入站去重 ────────────────────────────────────────────────────────────────
-- 替代 seen.json：那个是进程内存里的 2000 条窗口，全量重写，且重启即失忆。
create table inbound_dedupe (
  platform_msg_id text not null,
  channel         text not null,
  seen_at         timestamptz not null default now(),
  primary key (platform_msg_id, channel)
);

create index inbound_dedupe_seen_idx on inbound_dedupe (seen_at);

-- ── 审计 ────────────────────────────────────────────────────────────────────
-- 谁在什么时候查了哪个客户的什么数据。这张表是合规证据，不能改、不能提前删。
create table audit_log (
  id             bigserial primary key,
  actor          text not null,
  role           text,
  action         text not null,
  target_type    text,
  target_id      text,
  target_account text,
  detail         jsonb not null default '{}'::jsonb,
  trace_id       text,
  created_at     timestamptz not null default now()
);

create index audit_log_created_idx on audit_log (created_at desc);
create index audit_log_target_idx on audit_log (target_type, target_id);

-- ── 用量 ────────────────────────────────────────────────────────────────────
-- 按天按会话累计 token，用来算成本和设预算闸门。
create table usage_daily (
  day              date not null,
  conversation_id  bigint not null references conversations (id) on delete cascade,
  channel          text,
  turns            int not null default 0,
  input_tokens     bigint not null default 0,
  output_tokens    bigint not null default 0,
  primary key (day, conversation_id)
);

-- ── append-only 保护 ────────────────────────────────────────────────────────
-- 流水表禁止 update；delete 只在保留策略显式打开开关时放行：
--   set local app.allow_purge = 'on';
create or replace function reject_row_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.allow_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'append-only: % on % refused', tg_op, tg_table_name;
end $$;

create trigger ticket_events_immutable
  before update or delete on ticket_events
  for each row execute function reject_row_mutation();

create trigger audit_log_immutable
  before update or delete on audit_log
  for each row execute function reject_row_mutation();
