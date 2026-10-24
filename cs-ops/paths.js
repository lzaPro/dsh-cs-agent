/**
 * 运行目录的默认值：所有配置项都可以不写，装完就能跑。
 * 需要换位置时只设一个环境变量 DSH_CS_ROOT。
 */
import { homedir } from 'node:os'
import path from 'node:path'

/** DSH 主目录。 */
export function dshHome() {
  return process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
}

/** 客服插件的运行根目录。 */
export function runtimeRoot() {
  return process.env.DSH_CS_ROOT ?? path.join(dshHome(), 'cs-runtime')
}

/** 一份完整的默认路径表。 */
export function defaultPaths() {
  const root = runtimeRoot()
  return {
    root,
    customer: path.join(root, 'customer'),
    eval: path.join(root, 'eval'),
    ops: path.join(root, 'ops'),
    data: path.join(root, 'data'),
    kb: path.join(root, 'kb'),
    adapter: path.join(root, 'adapter'),
    sessions: path.join(dshHome(), 'sessions'),
  }
}
