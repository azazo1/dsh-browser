/**
 * 会合文件: 宿主把自己的 WebSocket 地址与握手令牌写给 native host.
 *
 * 这是"扩展不需要知道端口"的关键一环. 数据流是:
 *
 *   dsh 宿主 (知道端口)  ->  写字 ->  会合文件  ->  读字 ->  native host (Chrome 拉起)
 *
 * 会合文件权限 0600, 放在 0700 的目录里. 网页拿不到它的内容, 所以即使某个页面猜到
 * 了端口并尝试连我们的桥, 也过不了令牌校验.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { BRIDGE_PATH } from '../../shared/protocol.js'

/** 会合文件内容. */
export interface Rendezvous {
  /** 宿主 WebSocket 地址. */
  wsUrl: string
  /** 握手令牌, native host 在请求头里带上它. */
  token: string
  /** 写入方的进程 id, 便于排查"旧实例残留". */
  pid: number
  /** 写入时间 (ISO 8601), 便于判断是否过期. */
  startedAt: string
}

/**
 * 生成一个握手令牌.
 * @returns 256 位随机令牌的 base64url 表示.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 写入会合文件.
 *
 * @param file 会合文件绝对路径.
 * @param port 宿主 HTTP 服务的监听端口.
 * @param token 本次运行的握手令牌.
 * @returns 写入的内容.
 */
export async function writeRendezvous(file: string, port: number, token: string): Promise<Rendezvous> {
  const payload: Rendezvous = {
    // 固定用回环地址: 桥只服务本机的 native host, 不应该出现在别的网卡上.
    wsUrl: `ws://127.0.0.1:${String(port)}${BRIDGE_PATH}`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  // 目录 0700, 文件 0600: 只有本用户读得到令牌.
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return payload
}

/**
 * 读会合文件; 不存在或损坏时返回 null.
 * @param file 会合文件绝对路径.
 * @returns 解析出的内容, 或 null.
 */
export async function readRendezvous(file: string): Promise<Rendezvous | null> {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text) as Partial<Rendezvous>
    if (typeof parsed.wsUrl !== 'string' || typeof parsed.token !== 'string') return null
    return {
      wsUrl: parsed.wsUrl,
      token: parsed.token,
      pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return null
  }
}

/**
 * 删除会合文件 (插件卸载时).
 *
 * @param file 会合文件绝对路径.
 */
export async function removeRendezvous(file: string): Promise<void> {
  await rm(file, { force: true })
}
