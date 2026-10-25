
CTE 新人培训手册

# 🦞 CTE 新人培训手册

面向新入职 CTE 成员的入职培训文档

版本：v1.0 | 更新时间：2026-08-10 | 维护者：CTE 团队

## 📑 目录

- CTE 团队定位与职责

- 核心工具与平台

- 常见问题及解决方案

- 账户与余额类

- Sophclaw 服务不可用类

## 1. CTE 团队定位与职责

CTE是 Sophclaw 的客户技术支持团队，核心职责是为用户提供技术支持和问题排查。

#### 团队构成与排班

CTE 团队由正式员工和实习生组成，按周轮值排班：

| 角色 | 职责 | 时段 |

| CTE 正式员工 | 当日值班研发RP，处理非工作时段问题，指导实习生 | 00:00–09:00 + 18:00–24:00 |

| 实习生 1 | 人工座席值班 + 研发RP | 09:00–14:00 |

| 实习生 2 | 人工座席值班 + 研发RP | 13:00–18:00 |

当前排班表（2026-08-06 起生效）：

| 日期 | CTE 正式员工 | 实习生 1 | 实习生 2 |

| 周一 | 刘红娇 | 张益伟 | 曾庆鸿 |

| 周二 | 于洋 | 薛中锐 | 牛梦玥 |

| 周三 | 郝旭影 | 叶凯 | 尹晨旭 |

| 周四 | 吴浩文 | 雷腾 | 吕子昂 |

| 周五 | 黄金浩 | 钱泽 | 廖加文 |

| 周六 | 王举 | 肖荣亿 | 宋金源 |

| 周日 | 胡雪杨 | 杨祖康 | 韩冰 |

### 1.1 坐班（人工座席值班）

CTE 每日安排人员在人工座席后台值班，直接面向官网来访用户提供实时技术支持。

#### 值班时间与排班

| 时段 | 值班人员 | 说明 |

| 09:00 – 14:00 | 实习生 1 | — |

| 13:00 – 18:00 | 实习生 2 | 13:00–14:00 为交接时间 |

#### 登录人工座席后台

- 打开客服后台：https://openclaw-admin-web.sophnet.com/cs/agents

- 输入密钥：Zj/ejcOPc4xtHH8c0WLbMn8+Ziag7trak79abg/MxCI=

- 选择「客服01」或「客服02」

- 设置为【在线】状态

- 点击【进入工作台】开始值班

坐席管理界面：

[图片]

↑ 坐席管理界面：查看总坐席数、在线状态、会话数，点击「进入工作台」开始值班

工作台界面：

[图片]

↑ 工作台界面：左侧为会话列表（进行中/等待中/已关闭），点击会话进入聊天

⚠️ 注意
中间 13:00–14:00 为交接时间，请做好客户的交接，不要出现无人响应的空档。

### 1.2 微信 CTE 群（OpenClaw-CTE）

微信 CTE 群是团队内部沟通的主要渠道，用于：

- 日常问题讨论和经验分享

- 遇到无法处理的问题时 @相关同事求助

- 值班排班通知和调班沟通

- 上级传达的临时通知和流程变更

默认已加入，如未加入请联系导师或同事拉入。

### 1.3 Appia 内部 CTE 群

Appia 内部 CTE 群是 Bug 收集和处理的核心工作群，SPC BCB 机器人在此群自动运行。

#### 机器人的作用

SPC BCB（🦞）每 30 分钟自动执行一轮：

拉取群消息
→
识别 Bug
→
知识库匹配
→
自动回复 or 转人工
→
CTE群通知

- user 方案 → 机器人自动回复用户（你不需要操作）

- admin 方案 / 无匹配 → CTE 群通知（需要你介入处理）

#### 与机器人交互（5 种意图）

在群里 @机器人 进行对话：

| 意图 | 触发方式 | 示例 |

| ① 任务状态更新 | recordId + "已解决/修好了" | BKX 已解决，排查结论：PVC已满，告知用户：清理磁盘即可 |

| ② 知识库补充 | 某问题的解决方案是什么 | PVC已满的解决方案是什么 |

| ③ 任务状态查询 | "查询/查一下" + recordId | 查一下 BKX |

| ⑥ 直接提交需求/Bug | 直接描述需求或 Bug | 新增需求：支持导出PDF |

| ⑦ KB 草稿确认/拒绝 | "确认/拒绝 draft-xxx" | 确认 draft-20260710-001 |

#### 知识沉淀

当你确认 Bug 已解决时（意图①），机器人会自动判断排查结论是否可沉淀为知识库文档：

- 有复用价值 → 自动生成 KB 草稿 → CTE 群通知 → 管理员确认后写入 kb/

- 无复用价值 → 跳过

#### 询问机器人

直接在群里 @机器人 与其进行对话，机器人会优先从知识库 kb/ 中查找匹配内容回答。知识库未覆盖的问题会标注为推测。

⚠️ 红线：排查结论 ≠ 告知用户
确认 Bug 已解决时，排查结论是内部技术信息（如"pod异常，redeploy后恢复"），绝不能直接发给用户。只有"告知用户"内容才是面向用户的。无告知用户 → 发送简化版："请重试确认，如仍有问题请再联系我们"。

## 2. 核心工具与平台

### 2.1 Grafana — 查询用户数据与定位容器

⚠️ 需找李超杰老师申请账号
新人入职后需联系李超杰老师开通 Grafana 账号权限，每人用自己的账号。

#### 访问信息

| 项目 | 值 |

| URL | http://grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com/ |

#### 核心用途

根据用户手机号或邮箱，查询用户的 Sophclaw 订阅信息，定位容器。

#### 用法 1：查询用户订阅信息（主要用法）

在 Grafana Explore 中，数据源选择 prod_mysql，执行以下 SQL：
- 如需查组织账号（非个人），将 AND s.biz_type = 'PERSONAL' 去掉即可

按手机号查询：

SELECT s.*
FROM fastmodels.moltbot_subscription s
JOIN fastmodels.sys_user u ON s.user_id = u.id
WHERE u.phone_number = '手机号'
AND s.biz_type = 'PERSONAL'

按邮箱查询：

SELECT s.*
FROM fastmodels.moltbot_subscription s
JOIN fastmodels.sys_user u ON s.user_id = u.id
WHERE u.email = 'example@sophgo.com'
AND s.biz_type = 'PERSONAL'

查询结果示例：

[图片]

↑ 查询结果示例，重点关注以下字段

#### 关键字段说明

| 字段 | 用途 |

| moltbot_service_pool_id | Rancher 中搜索用（定位容器 deployment） |

| moltbot_service_url | OPC 原生后台地址（含 gateway token，直接浏览器打开） |

| subscription_status | 订阅状态：active 正常 / suspended 欠费挂起，需要续订 |

| moltbot_service_ssh_url | 终端连接地址（SSH 进入容器） |

| moltbot_service_sftp_url | 文件管理后台地址 |

💡 subscription_status 含义

- active — 正常状态

- suspended — 欠费挂起（目前有 bug 可能仍能使用）

⚠️ 多条 active 记录
如果显示多条 active 记录且 biz_type 一致，请在 CTE 群联系李超杰老师。

#### 用法 2：查询用户每小时模型使用分布（偶尔用到）

当用户反馈"余额用得快、不知道去哪了"时，可用此 SQL 查各小时使用的模型分布：

SELECT
HOUR(CONVERT_TZ(su.created_at, '+00:00', '+08:00')) AS 北京时间_小时,
su.model AS 模型,
COUNT(*) AS 调用次数,
ROUND(SUM(COALESCE(su.cost_in_cny, 0)), 2) AS 费用_元,
ROUND(AVG(COALESCE(su.input_tokens, 0)), 0) AS 平均输入tokens
FROM fastmodels.sys_usage su
WHERE su.org_id IN (
SELECT om.org_id FROM fastmodels.sys_user u
JOIN fastmodels.org_member om ON om.user_id = u.id
WHERE u.phone_number = '手机号'
AND (u.deleted IS NULL OR u.deleted = 0)
AND (om.is_deleted IS NULL OR om.is_deleted = 0)
)
AND su.created_at >= '2026-08-07 16:00:00'
AND su.created_at < '2026-08-08 16:00:00'
GROUP BY 北京时间_小时, su.model
ORDER BY 北京时间_小时, 费用_元 DESC;

查询结果示例：

[图片]

↑ 按小时×模型聚合，可看出哪个模型在哪个时段消耗最多

💡 使用技巧

- 时间范围根据用户反馈的时段调整 created_at 条件

#### 用法 3：查询充值记录

当用户反馈余额不足、充值不到账时，先用用法1获取 org_id，再用以下 SQL 查询该组织的充值记录：

SELECT * FROM fastmodels.balance_details
WHERE change_type != 'deduction'
AND org_id = {org_id}
ORDER BY id DESC

查询结果示例：

[图片]

↑ 结果中 change_amount 为充值金额，current_balance 为充值后余额，des 为充值描述

如果充值记录存在但显示余额不足 → 可能是没有切换到充值所在的组织，引导用户切换组织。切换后仍无法使用 → 让用户在有余额的组织下创建新的 API Key。

### 2.2 Rancher — 容器管理与日志查看

⚠️ 需找李超杰老师申请账号
生产环境有多个 cluster，权限可能只覆盖部分 cluster。找不到容器时联系李超杰老师开放对应集群权限，或联系导师。

#### 访问信息

| 项目 | 值 |

| URL | https://rancher-sophgo-prod.appia.cn/dashboard/home |

#### 核心用途

- 查找用户容器：用 Grafana 拿到的 moltbot_service_pool_id 在 filter 中搜索找到对应 deployment

- 查看日志：pod → ⋮ 菜单 → View Logs

- Execute Shell：pod → ⋮ 菜单 → Execute Shell

- Redeploy：容器网络异常时重新部署

- 替换镜像：PVC 满时替换 debug 镜像清理文件

#### 查找容器步骤

- 用 Grafana 获取的 moltbot_service_pool_id，在 Rancher Deployments 页面的 filter 中搜索

- 找到对应 deployment，点击进入详情

- 确认 ingress URL 与 moltbot_service_url 一致

- 在一个 cluster 找不到 → 尝试其他 cluster

#### 界面说明

Deployments 列表（在 filter 中搜索 moltbot_service_pool_id）：

[图片]

↑ 左侧导航：Cluster → Workloads → Deployments；顶部 filter 框输入moltbot_service_pool_id 搜索

Deployment 详情（Pod 列表、操作菜单）：

[图片]

↑ Pod 行右侧 ⋮ 菜单：Execute Shell（进入容器终端）、View Logs（查看日志）

Ingress 配置（SSH/SFTP 连接地址）：

[图片]

↑ Ingresses 标签页：可看到 SSH（-ssh 后缀）和 SFTP（-sftp 后缀）连接地址

Pod 日志：

[图片]

↑ View Logs 打开日志查看器，可下载日志文件，也可在 filter 中输入关键字搜索

💡 容器状态判断

- Ready 显示 0/0 → 容器未运行（挂掉或降级）

- service / pod / ingress 均为空 → 容器已删除，需迁移集群，联系李超杰老师

- scale = 0 → 容器被降级，需改回 1（见常见问题章节）

## 3. 常见问题及解决方案

### 3.1 账户与余额类

#### 余额莫名扣减 9.9 / 19.9 元

原因：Sophclaw 首月订阅收费 9.9 元，次月起 19.9 元/月。

回复：告知用户这是 Sophclaw 订阅费用即可。

#### 余额不足、充值不到账、无法使用

使用 Grafana 用法1 查询用户订阅信息获取 org_id，再用用法3 查询充值记录，详见 第 2.1 节。

#### 账号注销 / 龙虾注销

处理：在 CTE 群中 @梦想（王举老师），实习生暂无权限处理。

#### 退款

回复：无法退款。

#### 账号余额迁移（企业→个人等）

处理：在 CTE 群中 @梦想（王举老师），实习生暂无权限。

#### API Key 未绑定 / 需绑定

- 引导用户前往 Sophnet 用户中心 → API Key 管理获取个人 Key

- 编辑 openclaw.json，在 apiKey 字段填入

- 保存后刷新页面或重启服务

💡 消纳统计延迟
消纳统计有约 1 小时延迟，刚使用后不会立即显示。

#### 海外模型

- 少量使用的客户 → 不提供

- 内部用户 → 让其在 Appia 中联系周璟老师

- 有一定使用量的外部用户 → 让其加周璟老师微信（18200997764）

#### 购买 OpenClaw 大龙虾一体机

处理：Appia联系史伟。

#### 注册及邀请奖励

- 注册：因存在恶意注册现象，注册和实名认证不再发放信控额度或赠送金额

- 邀请：邀请好友充值赠送活动已结束，不再有邀请奖励

#### 用户咨询龙虾磁盘/CPU 使用情况

引导用户进入用户中心，PVC 即为磁盘使用情况。如果无法加载数据，点击右边刷新按钮。

### 3.2 Sophclaw 服务不可用类

#### 定位用户容器完整流程（核心技能）

####
这是 CTE 最核心的操作，几乎所有 Sophclaw 服务问题都需要先定位用户容器。
用户提供手机号/邮箱→Grafana 查 service_url→浏览器打开验证→Rancher 找 deployment→查看日志/进入shell
- 获取用户信息：手机号或邮箱
- Grafana 定位：Moltbot 仪表盘输入 → 获取 service_url + service_id + subscription_status
- 浏览器验证：复制 service_url 到浏览器
- 能打开 → pod 正常，进入下一步
- no healthy upstream → 容器挂掉，去 Rancher 排查
- Rancher 查找：用 service_id 找 deployment，确认 URL 与 ingress 一致
- 排查问题：查看 pod 日志 / execute shell / redeploy

#### 对话没反应 / 无响应

- 获取用户 moltbot_service_url，复制粘贴到浏览器打开 OPC 原生页面，尝试发送消息

- 情况 1：LLM request failed: network connection error

- 确认：容器网络异常

- 处理：在 Rancher 找到对应容器 → redeploy，不行多试几次

- 情况 2：401 Unauthorized

- 确认：API Key 配置问题

- 处理：通过 sftp/ssh 访问容器，查看 openclaw.json

- 如果 apiKey 是占位符 {your_sophnet_apikey} → 让用户自行重新配置

- 确保 API Key 使用的是有余额的组织创建的

- 检查 base_url 和 API 是否正确

💡 注意
通过 OPC 原生页面的配置 raw 查询不会显示 apiKey、gateway token 等隐私信息，必须通过 sftp/ssh 进入容器查看。

#### PVC 已满（-122 报错 / disk quota exceed）

常见现象：前端发送消息显示 -122 报错，容器日志显示 disk quota exceed。

容器已挂掉：

- 将 moltbot 容器镜像版本替换为 openclaw:dev-e3a68e5c（debug 镜像，无服务功能但能恢复 execute shell）

- Execute Shell → cd ~ 进入 /home/node 目录（PVC 挂载目录）

- 在用户允许的前提下用 rm 删除文件释放空间

- 用户要求全删：rm -rf /home/node

- 清理完成后记得将镜像替换回原版本！

⚠️ 删除 openclaw.json 时必须保存 API Key
删除 openclaw.json 后重新 deploy 通过模板恢复的文件不会包含用户自己的 API Key。如果没有保存，让用户自行提供或创建新 Key。

容器没挂掉：

提醒用户进入文件管理，手动删除文件。

#### Gateway Token 变更导致服务不可用

常见现象：对话返回 401 或 403，日志中显示 token 验证失败。

- 通过 sftp/ssh 进入容器，查看 openclaw.json 中的 gatewayToken 字段

- 确认 token 是否与 Sophnet 用户中心一致

- 如 token 已变更，更新 openclaw.json 中的对应字段

- 保存后 redeploy 容器

💡 注意
Gateway Token 变更后旧 token 立即失效，需尽快更新否则用户无法使用服务。

#### 容器降级（scale=0，无 pod）

过去 14 天 0 消耗的用户会被降级处理。

- 通过 Grafana 找到容器的 pool id

- 进入 Rancher 找到对应容器

- 将 scale 从 0 改为 1

💡 提醒用户
API Key 要用自己账号的，不要乱用别人的，也不要给别人使用。

#### 400 Bad Request 报错

常见现象：对话发送消息后返回 400 Bad Request。

- 查看容器日志，定位具体 400 报错信息

- 常见原因：

- openclaw.json 配置格式错误（JSON 语法问题）

- 模型名称拼写错误或使用了不存在的模型

- 请求体超过大小限制

- 根据日志提示修复配置后 redeploy

#### 对话记录消失 / 文件丢失

- 引导用户打开文件管理，workspace 下储存所有运行时文件

- 对话历史存储在 agents/<agent名称>/sessions 的 .jsonl 文件中，不会全额显示在前端

- 文件丢失 → Sophclaw 文件挂载在 PVC 上，除非手动命令行删除不会丢失。告知用户数据持久化存储不会丢失，请自行检查是否让龙虾做了删除/重置操作

#### 上传文件夹报错：Maximum call stack size exceeded

可让客户忽略，不影响文件上传（此为已知 bug，需前端修复）。

#### 奇怪的 openclaw.json 配置或插件导致容器挂掉

- 通过日志大致定位具体是哪个配置或插件导致报错

- 无法找到原因时 → 手动替换为 debug 镜像，保证容器启动成功

- Execute Shell → cat 查看 openclaw.json，vim 修改，rm 删除不必要的插件

🦞 CTE 新人培训手册 | v1.0 | 2026-08-10 | 有更新需求请联系 CTE 团队
