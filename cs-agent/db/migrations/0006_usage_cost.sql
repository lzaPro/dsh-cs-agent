-- 把"用了多少 token"升级成"花了多少钱"。
--
-- 成本要**在写入时算**，不能在读取时算：价格会变（换模型、谈折扣），
-- 读取时算会让历史账目跟着今天的价目表漂移。
--
-- 单位是 micro-USD 整数（见 cs-agent/pricing.js 的说明）：
-- 浮点累加一千次会漂出几分钱，对账时说不清。

alter table messages add column model text;
alter table messages add column provider text;
alter table messages add column cost_micros bigint;

alter table usage_daily add column cost_micros bigint not null default 0;
