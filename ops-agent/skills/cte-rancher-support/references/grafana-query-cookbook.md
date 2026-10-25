# Grafana 只读查询模板

仅在 CTE 支持工单需要客户、组织、Bot、协作项目、用量、API Key 归因或结算信息时使用。从这里选择一个模板并填好参数，Agent 会用浏览器工具登录 Grafana Explore，在获批的只读 MySQL 数据源（如 `prod_mysql`）中直接执行，并解读返回的结果行。

## 安全规则

- 每次只运行一条聚焦的 `SELECT`；禁止写入、DDL、存储过程和拼接任意 SQL 片段。
- 手机号必须是 11 位数字。邮箱必须是单个常规地址；插入 SQL 前将单引号转义为两个单引号。
- 时间参数必须为 `YYYY-MM-DD HH:MM:SS`。模板中的 `utc_start`、`utc_end` 是左闭右开的 UTC 区间。
- 只返回工单需要的字段。不要使用 `SELECT *`，不要查询 API Key 值、Token、密码、Secret、服务 URL、SSH/SFTP URL 或完整环境配置。
- IP、手机号、邮箱、姓名、API Key 名称和账单信息均属敏感数据。只向有权限的支持人员展示，不粘贴到公共频道。
- 如果查询报未知列或 schema 不存在，停止并通过授权的 schema 视图确认字段；不要猜测其他表或扩大查询。

## 查询路由

| 用户需求 | 使用模板 |
|---|---|
| 手机号/邮箱对应的 OpenClaw Bot、Pool ID | A |
| 用户所属组织 | B |
| 协作版项目 | C |
| 按小时消纳、失败比例、模型重试 | D–F |
| IP 或 API Key 使用归因 | G–J |
| 内外部客户结算 | K–M |
| 充值记录或 endpoint host 核对 | N–O |

## A. 查询个人版 Bot 与 Pool ID

手机号：

```sql
SELECT
  s.moltbot_service_pool_id,
  s.org_id,
  s.subscription_status,
  s.biz_type,
  s.is_deleted,
  s.created_at,
  s.updated_at
FROM fastmodels.moltbot_subscription AS s
JOIN fastmodels.sys_user AS u ON s.user_id = u.id
WHERE u.phone_number = '<11-digit-phone>'
  AND (u.deleted IS NULL OR u.deleted = 0)
  AND s.biz_type = 'PERSONAL'
ORDER BY s.created_at DESC;
```

邮箱：

```sql
SELECT
  s.moltbot_service_pool_id,
  s.org_id,
  s.subscription_status,
  s.biz_type,
  s.is_deleted,
  s.created_at,
  s.updated_at
FROM fastmodels.moltbot_subscription AS s
JOIN fastmodels.sys_user AS u ON s.user_id = u.id
WHERE u.email = '<escaped-email>'
  AND (u.deleted IS NULL OR u.deleted = 0)
  AND s.biz_type = 'PERSONAL'
ORDER BY s.created_at DESC;
```

保留 active、suspended、deleted/history 和不同时间的行，不要静默丢弃。分别报告总行数和非空 Pool ID 去重数量，再将目标 Pool ID 映射为 `moltbot-<pool-id>-`。

`is_deleted` 是 BIT(1)，Grafana Explore 表格会把它渲染为控制字符：`\u0000` 表示 0（未删除），`\u0001` 表示 1（已删除）。这是正常的显示，不要误读为乱码或异常值。

如果同一 `biz_type` 出现多条 active 记录，不要自行挑选或修改；保留全部记录并升级给平台负责人核对。

## B. 查询用户所属组织

```sql
SELECT
  u.id AS user_id,
  u.name AS user_name,
  om.org_id,
  o.name AS org_name
FROM fastmodels.sys_user AS u
JOIN fastmodels.org_member AS om ON om.user_id = u.id
JOIN fastmodels.organization AS o ON o.id = om.org_id
WHERE u.phone_number = '<11-digit-phone>'
  AND (u.deleted IS NULL OR u.deleted = 0)
  AND (om.is_deleted IS NULL OR om.is_deleted = 0)
ORDER BY om.org_id;
```

如工单从邮箱开始，仅把筛选条件替换为 `u.email = '<escaped-email>'`。默认不回显手机号或邮箱本身。

## C. 查询协作版项目

```sql
SELECT
  c.id AS collab_project_id,
  c.owner_user_id,
  c.org_id,
  c.project_id,
  c.created_at,
  c.updated_at
FROM sophnet_app.collab_project AS c
JOIN fastmodels.sys_user AS u ON c.owner_user_id = u.id
WHERE u.phone_number = '<11-digit-phone>'
  AND (u.deleted IS NULL OR u.deleted = 0)
ORDER BY c.updated_at DESC
LIMIT 50;
```

如果实际 schema 没有模板中的某个列，按安全规则停止并确认 schema；不要退回 `c.*`。

## D. 按小时统计消纳

```sql
SELECT
  DATE_FORMAT(CONVERT_TZ(su.created_at, '+00:00', '+08:00'), '%Y-%m-%d %H:00') AS 北京时间_小时,
  COUNT(*) AS 调用次数,
  ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 2) AS 费用_元,
  ROUND(AVG(COALESCE(su.input_tokens, 0)), 0) AS 平均input_tokens,
  ROUND(AVG(COALESCE(su.output_tokens, 0)), 0) AS 平均output_tokens,
  MIN(COALESCE(su.input_tokens, 0)) AS 最小input,
  MAX(COALESCE(su.input_tokens, 0)) AS 最大input
FROM fastmodels.sys_usage AS su
WHERE su.org_id = <validated-org-id>
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY 北京时间_小时
ORDER BY 北京时间_小时;
```

## E. 按小时检查 output=0 的调用

```sql
SELECT
  DATE_FORMAT(CONVERT_TZ(su.created_at, '+00:00', '+08:00'), '%Y-%m-%d %H:00') AS 北京时间_小时,
  COUNT(*) AS 总调用,
  SUM(CASE WHEN COALESCE(su.output_tokens, 0) = 0 THEN 1 ELSE 0 END) AS output为0的调用,
  ROUND(100 * SUM(CASE WHEN COALESCE(su.output_tokens, 0) = 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS output为0占比,
  ROUND(AVG(COALESCE(su.input_tokens, 0)), 0) AS 平均input_tokens,
  ROUND(AVG(COALESCE(su.output_tokens, 0)), 0) AS 平均output_tokens
FROM fastmodels.sys_usage AS su
WHERE su.org_id = <validated-org-id>
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY 北京时间_小时
ORDER BY 北京时间_小时;
```

`output_tokens = 0` 是失败线索，不等同于请求失败；需要结合状态、错误日志和费用规则判断。

## F. 按小时和模型统计

```sql
SELECT
  DATE_FORMAT(CONVERT_TZ(su.created_at, '+00:00', '+08:00'), '%Y-%m-%d %H:00') AS 北京时间_小时,
  su.model AS 模型,
  COUNT(*) AS 调用次数,
  ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 2) AS 费用_元,
  ROUND(AVG(COALESCE(su.input_tokens, 0)), 0) AS 平均输入tokens
FROM fastmodels.sys_usage AS su
WHERE su.org_id = <validated-org-id>
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY 北京时间_小时, su.model
ORDER BY 北京时间_小时, 费用_元 DESC;
```

多模型出现不自动证明轮流重试；还需关联相邻调用时间、输出为零和应用日志。

## G. 按 IP 汇总调用

```sql
SELECT
  su.ip AS 调用IP,
  COUNT(*) AS 调用次数,
  SUM(COALESCE(su.input_tokens, 0)) AS 输入tokens,
  SUM(COALESCE(su.output_tokens, 0)) AS 输出tokens,
  ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 4) AS 费用_元
FROM fastmodels.sys_usage AS su
WHERE su.org_id = <validated-org-id>
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY su.ip
ORDER BY 费用_元 DESC;
```

## H. API Key × IP × 模型聚合

```sql
SELECT
  su.apikey_id,
  a.name AS apikey_name,
  su.ip AS 调用IP,
  su.model,
  COUNT(*) AS 调用次数,
  SUM(COALESCE(su.input_tokens, 0)) AS 输入tokens,
  SUM(COALESCE(su.output_tokens, 0)) AS 输出tokens,
  ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 6) AS 费用_元
FROM fastmodels.sys_usage AS su
LEFT JOIN fastmodels.authorization AS a ON a.id = su.apikey_id
WHERE su.org_id = <validated-org-id>
  AND su.auth_type = 'apikey'
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY su.apikey_id, a.name, su.ip, su.model
ORDER BY 费用_元 DESC;
```

只查询 Key ID 和名称，不查询或展示 Key 值。

## I. API Key × 项目 × 模型聚合

```sql
SELECT
  su.apikey_id,
  a.name AS apikey_name,
  a.project_id,
  p.name AS project_name,
  su.model,
  COUNT(*) AS 调用次数,
  SUM(COALESCE(su.input_tokens, 0)) AS 输入tokens,
  SUM(COALESCE(su.output_tokens, 0)) AS 输出tokens,
  ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 6) AS 费用_元
FROM fastmodels.sys_usage AS su
LEFT JOIN fastmodels.authorization AS a ON a.id = su.apikey_id
LEFT JOIN fastmodels.project AS p ON p.id = a.project_id
WHERE su.org_id = <validated-org-id>
  AND su.auth_type = 'apikey'
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY su.apikey_id, a.name, a.project_id, p.name, su.model
ORDER BY 费用_元 DESC;
```

## J. 按来源或 Key 类型统计费用

按来源：

```sql
SELECT
  CASE
    WHEN su.auth_type = 'openClawApikey' THEN 'OpenClaw调用'
    WHEN su.auth_type = 'apikey' THEN 'APIKey直调'
    WHEN su.auth_type = 'session' THEN '网页端会话'
    ELSE IFNULL(su.auth_type, '未知')
  END AS 调用来源,
  COUNT(*) AS 调用次数,
  SUM(COALESCE(su.input_tokens, 0)) AS 总输入tokens,
  SUM(COALESCE(su.output_tokens, 0)) AS 总输出tokens,
  ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 4) AS 总费用_元
FROM fastmodels.sys_usage AS su
WHERE su.org_id = <validated-org-id>
  AND su.created_at >= '<utc-start>'
  AND su.created_at < '<utc-end>'
GROUP BY 调用来源
ORDER BY 总费用_元 DESC;
```

列出组织下 API Key 元数据：

```sql
SELECT
  a.id AS apikey_id,
  a.name AS apikey_name,
  p.name AS project_name,
  CASE WHEN a.service_pool_id IS NOT NULL THEN 'OpenClaw专用' ELSE '普通云API' END AS key_type,
  a.last_used_time
FROM fastmodels.authorization AS a
JOIN fastmodels.project AS p ON p.id = a.project_id
WHERE a.org_id = <validated-org-id>
ORDER BY a.last_used_time DESC;
```

## K. 外部客户结算金额

```sql
SELECT ROUND(SUM(t.deducted_amount), 2) AS settlement_amount
FROM fastmodels.ticket_order AS t
JOIN fastmodels.sys_user AS u ON t.user_id = u.id
WHERE (u.internal_user = FALSE OR u.internal_user IS NULL)
  AND t.status = 'ISSUED'
  AND t.deducted_amount IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM fastmodels.ticket_order_event AS e
    WHERE e.ticket_order_id = t.id
      AND e.to_status = 'ISSUED'
      AND e.created_at >= '<utc-start>'
      AND e.created_at < '<utc-end>'
  );
```

## L. 内部用户结算金额

```sql
SELECT ROUND(SUM(t.deducted_amount), 2) AS settlement_amount
FROM fastmodels.ticket_order AS t
JOIN fastmodels.sys_user AS u ON t.user_id = u.id
WHERE u.internal_user = TRUE
  AND t.status = 'ISSUED'
  AND t.deducted_amount IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM fastmodels.ticket_order_event AS e
    WHERE e.ticket_order_id = t.id
      AND e.to_status = 'ISSUED'
      AND e.created_at >= '<utc-start>'
      AND e.created_at < '<utc-end>'
  );
```

## M. 外部客户结算明细

只在明确需要客户级明细时使用；默认不返回 UUID、电话或邮箱。

```sql
SELECT
  u.id AS user_id,
  u.name AS user_name,
  COUNT(*) AS order_count,
  ROUND(SUM(t.deducted_amount), 2) AS total_amount,
  MIN(x.first_time) AS order_start,
  MAX(x.last_time) AS order_end
FROM fastmodels.ticket_order AS t
JOIN fastmodels.sys_user AS u ON t.user_id = u.id
JOIN (
  SELECT
    ticket_order_id,
    MIN(created_at) AS first_time,
    MAX(created_at) AS last_time
  FROM fastmodels.ticket_order_event
  WHERE to_status = 'ISSUED'
    AND created_at >= '<utc-start>'
    AND created_at < '<utc-end>'
  GROUP BY ticket_order_id
) AS x ON x.ticket_order_id = t.id
WHERE (u.internal_user = FALSE OR u.internal_user IS NULL)
  AND t.status = 'ISSUED'
  AND t.deducted_amount IS NOT NULL
GROUP BY u.id, u.name
ORDER BY total_amount DESC;
```

## N. 查询充值和非扣费余额变更

先使用模板 B 确认目标组织，再查询最小必要字段：

```sql
SELECT
  id,
  org_id,
  change_type,
  change_amount,
  current_balance,
  des,
  created_at
FROM fastmodels.balance_details
WHERE change_type <> 'deduction'
  AND org_id = <validated-org-id>
ORDER BY id DESC
LIMIT 100;
```

充值记录存在但用户仍提示余额不足时，先核对用户当前选择的组织以及数据更新时间；不要自动创建、迁移或修改 API Key。

## O. 查询用于入口核对的 endpoint host

仅当页面、SSH 或文件服务入口需要核对时使用。返回 host，不返回可能带 Token 的完整 URL：

```sql
SELECT
  s.moltbot_service_pool_id,
  SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(s.moltbot_service_url, 'https://', ''), '/', 1), '?', 1) AS service_host,
  SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(s.moltbot_service_ssh_url, 'https://', ''), '/', 1), '?', 1) AS ssh_host,
  SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(s.moltbot_service_sftp_url, 'https://', ''), '/', 1), '?', 1) AS sftp_host,
  s.subscription_status,
  s.updated_at
FROM fastmodels.moltbot_subscription AS s
JOIN fastmodels.sys_user AS u ON s.user_id = u.id
WHERE u.phone_number = '<11-digit-phone>'
  AND (u.deleted IS NULL OR u.deleted = 0)
ORDER BY s.created_at DESC;
```

如确需完整原生页面 URL，由获批人员在 Grafana UI 中查看并直接使用。完整 URL 可能包含 Gateway Token，不要复制到对话、报告、日志或 skill 文件。

## Reporting

记录所用模板、数据源名称、查询条件、UTC 区间及展示时区，以及查询是由 Agent 通过 `CTE_GRAFANA_USERNAME` 配置的只读账号在 Grafana Explore 中直接执行的。报告聚合结果时说明零值和缺失值的处理。不要在普通报告中重复完整手机号、邮箱、IP 或其他个人标识；必要时只显示掩码或内部 ID。
