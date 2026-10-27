-- 0002 补上会话的 lastSenderId
--
-- 原来 sessions.json 里的记录有一个动态字段 lastSenderId（群聊自动 @ 本轮提问的人
-- 时用），0001 建表时漏了。这里补一列，不修改 0001 —— 迁移一旦应用就不可改，
-- 迁移器会用 sha256 校验并拒绝改动历史。
alter table conversations add column last_sender_id text;
