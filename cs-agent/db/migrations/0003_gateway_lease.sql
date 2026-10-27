-- 0003 网关租约：把"谁在写这份数据"从 PID 文件搬到数据库
--
-- 原来的独占靠 `<dataFile>.lock` 里的 pid：单机够用，但两个地方不对。
--   1. 多机部署时每台机器各有一份锁文件，A 机和 B 机都以为自己独占，
--      于是两个进程同时写同一份数据（数据在共享存储/数据库时就是真的坏）；
--   2. pid 只证明"进程存在"，不证明"它在干活"。进程卡在某个 await 上时
--      pid 照样活着，别的实例永远等不到接管。
--
-- 租约把这两件事都变成有时间的事实：谁持有、什么时候心跳、什么时候过期。
-- 过期就能接管，不需要人工删锁文件；心跳由持有者每 ttl/3 续一次，不再续就
-- 说明它要么死了、要么卡住了。
create table gateway_leases (
  -- 一个逻辑写入域一行；同一份数据的所有实例用同一个 scope。
  scope        text primary key,
  -- 持有者身份：host:pid:nonce。同一个进程重启后 nonce 变了，旧租约自然过期。
  holder       text not null,
  host         text,
  pid          int,
  heartbeat_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- 清理/接管时按过期时间扫。
create index gateway_leases_expires_idx on gateway_leases (expires_at);
