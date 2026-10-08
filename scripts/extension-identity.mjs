/**
 * 扩展身份工具: 派生扩展 ID, 生成固定密钥对.
 *
 * 为什么需要它:
 * 未打包扩展的 ID 默认由目录路径哈希得出, 路径一变 ID 就变. 而 native messaging
 * 清单里的 allowed_origins 必须写死扩展 ID, 一旦 ID 漂移, 清单立刻失配.
 * 解决办法是把公钥写进 manifest.json 的 key 字段, ID 从此只由密钥决定.
 *
 * 子命令:
 *   id <manifest.json 路径>   只读: 从 manifest 的 key 字段算出扩展 ID
 *   gen                       生成新密钥对并打印 key 字段与 ID
 *   crx-key                   打印保管中的私钥路径 (供打包用)
 *
 * 扩展 ID 的算法 (Chrome 官方定义):
 *   1. 取公钥的 DER 编码 (SubjectPublicKeyInfo).
 *   2. 对其做 SHA-256.
 *   3. 取前 16 字节, 每个 nibble 映射到 a-p.
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 私钥保管位置: 不入库, 仅本机用于打包 crx. */
export const KEY_PATH = join(REPO_ROOT, '.tmp', 'extension-key.pem')

/**
 * 计算扩展 ID.
 * @param {Buffer} der 公钥 DER 编码.
 * @returns {string} 32 字符的扩展 ID.
 */
export function extensionIdFromDer(der) {
  const digest = createHash('sha256').update(der).digest()
  let id = ''
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(97 + (digest[i] >> 4))
    id += String.fromCharCode(97 + (digest[i] & 0x0f))
  }
  return id
}

/**
 * 从 manifest.json 的 key 字段算扩展 ID.
 * @param {string} manifestPath manifest.json 路径.
 * @returns {string} 扩展 ID.
 */
export function extensionIdFromManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.key !== 'string' || manifest.key === '') {
    throw new Error(`${manifestPath} 缺少 key 字段: 没有它扩展 ID 会随目录路径漂移`)
  }
  return extensionIdFromDer(Buffer.from(manifest.key, 'base64'))
}

/** 生成密钥对, 把公钥写入 manifest 的 key 字段, 私钥另存. */
function generate() {
  const manifestPath = join(REPO_ROOT, 'extension', 'manifest.json')
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const key = publicKey.toString('base64')
  const id = extensionIdFromDer(publicKey)

  mkdirSync(dirname(KEY_PATH), { recursive: true })
  writeFileSync(KEY_PATH, privateKey, { mode: 0o600 })

  console.log('公钥已生成, 把下面这一行填入 extension/manifest.json 的 key 字段:')
  console.log(JSON.stringify(key))
  console.log()
  console.log(`扩展 ID: ${id}`)
  console.log(`私钥已写入: ${KEY_PATH} (已 gitignore, 打包 crx 时需要)`)
  if (existsSync(manifestPath)) {
    console.log()
    console.log(`提示: ${manifestPath} 需要手动更新 key 字段.`)
  }
}

const [command, argument] = process.argv.slice(2)
if (command === 'id') {
  if (argument === undefined) throw new Error('用法: extension-identity.mjs id <manifest.json 路径>')
  console.log(extensionIdFromManifest(resolve(argument)))
} else if (command === 'gen') {
  generate()
} else if (command === 'crx-key') {
  console.log(KEY_PATH)
} else {
  console.log('用法: extension-identity.mjs <id <manifest> | gen | crx-key>')
  process.exitCode = 1
}
