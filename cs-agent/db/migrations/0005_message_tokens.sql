-- 消息与用量落库：缓存命中/写入的 token 也要能单独记。
--
-- 拆开记而不是只存一个总数：缓存读通常便宜一到两个数量级，混在 input_tokens 里
-- 算出来的成本会偏得离谱。total_tokens 是模型网关报的全量口径，只在给定时才填。

alter table messages add column total_tokens integer;
alter table messages add column cache_read_tokens integer;
alter table messages add column cache_write_tokens integer;

alter table usage_daily add column cache_read_tokens bigint not null default 0;
alter table usage_daily add column cache_write_tokens bigint not null default 0;
