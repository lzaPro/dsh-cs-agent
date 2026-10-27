-- 入站受理队列：平台 POST 进来先落这一行，再去建会话、下载附件、唤醒模型。
--
-- 起因：重构前 inbound() 一个函数串了归一化、去重、限流、附件下载、建会话、落盘、投递。
-- 附件下载失败或建会话超时，整条客户消息就丢了 —— 而平台不一定重投。
--
-- 这一行是"我收下了"的凭据：写进来就回 202，之后由后台按退避重试处理，
-- 重试用尽才标 dead。形状与 outbox 一致，共用同一份队列实现（outbox-pg.js）。
create table if not exists inbox (
  id               bigserial primary key,
  conversation_id  bigint references conversations(id) on delete set null,
  external_key     text not null,
  channel          text not null,
  payload          jsonb not null,
  idempotency_key  text not null,
  state            text not null default 'pending'
                   check (state in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts         integer not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  -- 复用 outbox 的列名：对入站消息它表示"处理完成时间"。
  sent_at          timestamptz
);

create unique index if not exists inbox_idempotency_uniq on inbox (idempotency_key);
create index if not exists inbox_due_idx on inbox (next_attempt_at)
  where state in ('pending', 'failed');
create index if not exists inbox_pending_idx on inbox (created_at) where state = 'pending';
