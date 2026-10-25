# OpenClaw 排障线索

以下模式只能作为线索，不能单独证明根因。

| 模式 | 可观察事实 | 需要关联的证据 |
|---|---|---|
| `file lock timeout` / `SessionWriteLockTimeoutError` | 指定时间内未取得写锁 | 锁龄、当前持锁进程、并发请求、Pod 重启时间；删除锁前确认陈旧 |
| `EmbeddedAttemptSessionTakeoverError` | 释放锁期间会话状态变化 | 前一持锁者、并发运行和相邻请求 |
| `compaction-diag` 且 `outcome=failed` | 压缩尝试失败 | 失败原因、提供方延迟、请求取消及后续重试 |
| `Request was aborted` | 请求被取消 | 客户端取消、超时、进程关闭或上游取消 |
| `memory pressure: level=critical` | 进程内存超过阈值 | RSS、JS heap、CPU、OOM 事件和重启 |
| `liveness warning: event_loop_delay` | Node 事件循环响应下降 | CPU 限流、同步任务、GC 与内存压力 |
| `stuck session` / `stalled session` | 进度监控发现停滞 | 活跃 run ID、队列等待、事件循环和锁状态 |
| `Unknown system error -122` | Linux 常对应配额超限 `EDQUOT` | PVC 容量、目录占用、inode、写入失败及探针重启 |
| `disk I/O error` | 存储读写失败 | 配额、NAS/PVC 事件、容器重启和文件系统错误 |
| `connection refused` 探针失败 | 目标端口未监听 | 应用启动日志、前置存储/配置错误及端口启动时间 |
| `401 Unauthorized` | 上游或 Gateway 拒绝认证 | API Key 所属组织、余额、base URL 和配置来源；不要打印 Key 值 |
| `403 Forbidden` / token 验证失败 | Token 无权访问或已变化 | Gateway 配置版本、用户中心状态及最近变更；不要读取或回显完整 Token |
| `400 Bad Request` | 请求格式或参数被拒绝 | JSON 语法、模型名称、请求体大小和上游错误正文 |
| `Maximum call stack size exceeded`（文件夹上传） | 前端递归栈异常 | 文件是否实际上传成功及浏览器端复现；不要仅凭该提示判断文件丢失 |

形成根因判断时尽量引用时间戳和至少两个关联信号，并说明其他解释及区分它们所需的证据。

## 存储与锁文件

- PVC 为 `Bound` 只证明卷已绑定，不证明配额、inode 或 I/O 正常。
- `df` 在共享 NAS 上可能显示整个后端容量，不能代替目标目录的 `du` 或平台侧配额数据。
- 删除缓存前统计目录和大文件；优先建议可重建缓存，不要把客户文件、配置或运行库当缓存。
- 仅凭 `.lock` 存在不能删除。需确认时间早于当前 Pod/进程、没有活动持锁者，并获得明确授权；只删除已确认的锁文件，不删除被保护的配置或备份。
