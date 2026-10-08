/**
 * 插件配置与路径解析.
 *
 * 数据目录的约定与 dsh-plugin-chrome 保持一致: `<DSH_HOME>/data/<插件名>`.
 * 区别在于 profile 是**持久**的而不是每会话一个: 登录态和历史需要跨会话累积,
 * 这也是对反检测最有效的一点 (全新空白 profile 本身就是可疑信号).
 */

import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 插件在 profile 里的条目 id, 同时也是配置表单的命名空间. */
export const ENTRY_ID = 'dsh-browser'

/** 插件数据目录的默认名字. */
const DATA_DIR_NAME = 'dsh-browser'

/** 配置面. */
export interface Config {
  /** Chrome 可执行文件路径; 省略时按平台探测稳定版安装位置. */
  chromePath: Volatile<string | undefined>
  /** 持久 profile 目录; 省略时用 `<数据根>/profile`. */
  profileDir: Volatile<string | undefined>
  /** 插件数据根目录; 省略时用 `<DSH_HOME>/data/dsh-browser`. */
  dataDir: Volatile<string | undefined>
  /** 额外传给 Chrome 的命令行参数, 每项一个完整参数. */
  extraArgs: Volatile<string[]>
  /** 首次在会话中启动浏览器前是否征求用户同意. */
  confirmFirstLaunch: Volatile<boolean>
  /**
   * 插件加载时是否自动写入 native messaging 清单.
   *
   * 默认关闭: 写清单是一次用户级配置写入 (落在 Chrome 的 NativeMessagingHosts
   * 目录), 不应当在用户没点过任何东西的时候发生. 缺省路径是配置页里的
   * "安装连接组件"按钮, 那才是用户看得见的授权动作.
   */
  installHostAutomatically: Volatile<boolean>
}

/**
 * 会破坏本插件前提的命令行参数.
 *
 * 本插件的整个价值在于"没有调试协议、扩展可用、用指定 profile", 所以这三类参数
 * 不能由配置开出来: 加了调试端口等于把 CDP 平面请回来, 关掉扩展等于把控制通道
 * 拆掉, 改 user-data-dir 会让 native messaging 与扩展安装状态全部错位.
 */
const FORBIDDEN_ARG_PREFIXES = [
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-allow-origins',
  '--disable-extensions',
  '--headless',
  '--user-data-dir',
  '--profile-directory',
]

/**
 * 配置 schema; 默认值与约束只写在这里, 代码里不再维护第二份.
 *
 * 刻意不给它加 `Schema<Config>` 注解: schemastery 对 `Volatile<T | undefined>`
 * 这类字段的推断与显式注解不一致, 官方插件也都是让类型自行推断 (见 llm-deepseek
 * 与 agent-default-model)。
 */
export const Config = Schema.object({
  chromePath: Schema.string().volatile(),
  profileDir: Schema.string().volatile(),
  dataDir: Schema.string().volatile(),
  extraArgs: Schema.array(Schema.string()).default([]).volatile(),
  confirmFirstLaunch: Schema.boolean().default(true).volatile(),
  installHostAutomatically: Schema.boolean().default(false).volatile(),
})

/** 解析后的路径集合, 每次需要时重新计算, 保证配置改动立即生效. */
export interface ResolvedPaths {
  /** 插件数据根目录. */
  dataDir: string
  /** Chrome 的持久 profile 目录. */
  profileDir: string
  /** native messaging 清单与宿主脚本的落地目录. */
  hostDir: string
  /** 插件自带扩展产物的落地目录 (供用户在 chrome://extensions 里选中). */
  extensionDir: string
  /** 宿主与 native host 之间的会合文件. */
  rendezvousFile: string
}

/**
 * 展开路径里的 `~`, 并转成绝对路径.
 * @param value 配置里给的路径.
 * @returns 绝对路径.
 */
export function expandPath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return resolve(value)
}

/**
 * 取 dsh 的用户目录.
 *
 * 子实例通过 `DSH_HOME` 隔离, 所以这里必须读环境变量而不是写死 `~/.dsh`,
 * 否则子实例的插件会跑到主实例的数据目录里去.
 *
 * @returns `<DSH_HOME>` 的绝对路径.
 */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return expandPath(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * 按当前配置解析出全部路径.
 * @param config 插件配置.
 * @returns 路径集合.
 */
export function resolvePaths(config: Config): ResolvedPaths {
  const configuredData = config.dataDir.get()
  const dataDir = configuredData === undefined || configuredData.trim() === ''
    ? join(dshHome(), 'data', DATA_DIR_NAME)
    : expandPath(configuredData)
  const configuredProfile = config.profileDir.get()
  const profileDir = configuredProfile === undefined || configuredProfile.trim() === ''
    ? join(dataDir, 'profile')
    : expandPath(configuredProfile)
  return {
    dataDir,
    profileDir,
    hostDir: join(dataDir, 'native-host'),
    extensionDir: join(dataDir, 'extension'),
    rendezvousFile: join(dataDir, 'bridge.json'),
  }
}

/**
 * 校验额外参数, 拒绝会破坏插件前提的项.
 *
 * @param args 配置里的额外参数.
 * @throws 当某个参数命中禁用前缀时抛出, 错误信息说明该参数为什么被拒.
 */
export function assertUsableExtraArgs(args: readonly string[]): void {
  for (const arg of args) {
    const hit = FORBIDDEN_ARG_PREFIXES.find(prefix => arg === prefix || arg.startsWith(`${prefix}=`))
    if (hit !== undefined) {
      throw new Error(
        `extraArgs 里的 "${arg}" 与本插件的前提冲突 (命中禁用项 ${hit}). `
        + '本插件刻意不使用 Chrome 调试协议并需要扩展通道, 这些参数会破坏该前提, 因此拒绝启动.',
      )
    }
  }
}
