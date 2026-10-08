/**
 * 浏览器连接设置页: 展示就绪状态, 并在缺东西时提供一键安装.
 *
 * 界面分四段:
 *   1. 结论行   —— 现在能不能用.
 *   2. 检查清单 —— Chrome 是否找到, 连接组件是否装好, 扩展是否连上, 是否绑定了标签页.
 *   3. 手动步骤 —— 只有一步必须由用户做 (在 chrome://extensions 里加载扩展),
 *      写明具体路径并提供复制按钮.
 *   4. 细节     —— 路径, 扩展 id, 解释器, 启动参数, 排查时才需要.
 *
 * 这里不做成配置表单: 页面上的信息绝大部分是"Host 观测到的运行时状态", 不是 profile
 * 里的配置值, 塞进表单会让人以为可以改. 样式用内联样式加 dsh 的语义 token, 不引入
 * 组件库也不写死颜色.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StatusPayload } from '../../shared/status.js'
import { fetchStatus, installHost, uninstallHost } from './api.js'
import type { BrowserSettingsKey } from './strings.js'

/** 组件属性: 由 slot 注册时注入. */
export interface BrowserSettingsProps {
  /** 文案查找函数. */
  t: (key: BrowserSettingsKey) => string
}

/** 一行检查项的渲染数据. */
interface CheckRow {
  key: BrowserSettingsKey
  ok: boolean
  detail: string
}

/** 样式片段. */
const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 0' } satisfies CSSProperties,
  headline: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 14, fontWeight: 500 } satisfies CSSProperties,
  checks: { display: 'flex', flexDirection: 'column' } satisfies CSSProperties,
  check: {
    display: 'grid',
    gridTemplateColumns: 'auto 140px 1fr',
    alignItems: 'center',
    gap: 8,
    padding: '12px 0',
    borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  } satisfies CSSProperties,
  checkName: { fontSize: 13, fontWeight: 500 } satisfies CSSProperties,
  checkDetail: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' } satisfies CSSProperties,
  manual: { display: 'flex', flexDirection: 'column', gap: 8 } satisfies CSSProperties,
  sectionTitle: { margin: 0, fontSize: 13, fontWeight: 500 } satisfies CSSProperties,
  path: { display: 'flex', gap: 8, alignItems: 'center' } satisfies CSSProperties,
  steps: {
    margin: 0,
    paddingInlineStart: 18,
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    lineHeight: 1.7,
  } satisfies CSSProperties,
  hint: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } satisfies CSSProperties,
  error: {
    margin: 0,
    fontSize: 12,
    color: 'var(--dsw-alias-state-error-primary)',
    lineHeight: 1.6,
  } satisfies CSSProperties,
  details: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' } satisfies CSSProperties,
  detailList: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' } satisfies CSSProperties,
  detailRow: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr',
    gap: 8,
    fontSize: 12,
    alignItems: 'baseline',
  } satisfies CSSProperties,
  detailLabel: { color: 'var(--dsw-alias-label-tertiary)' } satisfies CSSProperties,
  detailValue: { overflowWrap: 'anywhere', fontFamily: 'var(--dsw-font-mono, monospace)' } satisfies CSSProperties,
} as const

/** 状态渲染成检查清单. */
function checks(status: StatusPayload): CheckRow[] {
  return [
    {
      key: 'checkChrome',
      ok: status.chromePath !== null,
      detail: status.chromePath ?? status.chromeError ?? '',
    },
    {
      key: 'checkHost',
      ok: status.manifestReady,
      // manifestStale 说明装过但内容与当前配置不符 (换了数据目录或换了密钥), 需要重装.
      detail: status.manifestStale ? '清单内容与当前配置不一致' : (status.manifestPath ?? ''),
    },
    {
      key: 'checkExtension',
      ok: status.bridgeConnected,
      detail: status.extensionVersion === null ? '扩展尚未连上' : `扩展版本 ${status.extensionVersion}`,
    },
    {
      key: 'checkPairing',
      // 没配置配对令牌时整条链路都用不了, 所以这一项没通过就是真问题.
      ok: status.pairingConfigured && status.pairingError === null,
      detail: status.pairingError !== null
        ? status.pairingError
        : (status.pairingConfigured
          ? '已配置; 扩展握手时会核对'
          : '尚未配置: 打开浏览器扩展的弹出面板, 复制其中的配对令牌填到本插件的 pairingToken 配置项'),
    },
    {
      key: 'checkEvaluate',
      // 求值不是必须的: 没开这个开关, 其余 16 个工具照常可用, 所以它不该让整行变红,
      // 只在未开启时说明怎么开.
      ok: status.userScriptsAvailable !== false,
      detail: status.userScriptsAvailable === null
        ? '扩展未连上, 状态未知'
        : (status.userScriptsAvailable
          ? 'browser_evaluate 可用'
          : '未启用; 在扩展详情页打开 Allow User Scripts 后 browser_evaluate 可用'),
    },
    {
      key: 'checkBinding',
      ok: status.boundTabId !== null,
      detail: status.boundTabId === null
        ? '尚未绑定标签页 (在会话里调用 browser_tabs 后选择)'
        : `id=${String(status.boundTabId)}`,
    },
  ]
}

/** 一行键值展示. */
function DetailRow(props: { label: string, value: string }): ReactElement {
  return (
    <div style={styles.detailRow}>
      <span style={styles.detailLabel}>{props.label}</span>
      <code style={styles.detailValue}>{props.value === '' ? '-' : props.value}</code>
    </div>
  )
}

/**
 * 渲染设置页.
 *
 * @param props 文案函数.
 * @returns 设置页元素.
 */
export function BrowserSettings(props: BrowserSettingsProps): ReactElement {
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'install' | 'uninstall' | 'refresh' | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchStatus()
      setStatus(next)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => {
    void load()
    // 扩展连接是异步的: 用户在另一个标签页装完扩展后回到这里, 应当自己变绿而不必点刷新.
    const timer = setInterval(() => { void load() }, 3_000)
    return () => { clearInterval(timer) }
  }, [load])

  const act = useCallback(async (kind: 'install' | 'uninstall'): Promise<void> => {
    setBusy(kind)
    try {
      const next = kind === 'install' ? await installHost() : await uninstallHost()
      setStatus(next)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }, [])

  const rows = useMemo(() => (status === null ? [] : checks(status)), [status])

  return (
    <div style={styles.root}>
      {error !== null && <p style={styles.error} role="alert">{error}</p>}

      {status === null && error === null && (
        <p style={styles.hint}>{props.t('loading')}</p>
      )}

      {status !== null && (
        <>
          <p style={styles.headline}>
            <StateDot state={status.ready ? 'done' : 'warning'} />
            <span>{props.t(status.ready ? 'ready' : 'notReady')}</span>
          </p>

          <div style={styles.checks}>
            {rows.map(row => (
              <div style={styles.check} key={row.key}>
                <StateDot state={row.ok ? 'done' : 'warning'} />
                <span style={styles.checkName}>{props.t(row.key)}</span>
                <span style={styles.checkDetail}>{row.detail}</span>
              </div>
            ))}
          </div>

          <div style={styles.actions}>
            <Button variant="primary" disabled={busy !== null} onClick={() => { void act('install') }}>
              {busy === 'install' ? props.t('installing') : props.t('install')}
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null || !status.manifestReady}
              onClick={() => { void act('uninstall') }}
            >
              {props.t('uninstall')}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void load() }}>
              {props.t('refresh')}
            </Button>
          </div>

          {status.manifestStale && <p style={styles.hint}>{props.t('stale')}</p>}

          <section style={styles.manual}>
            <h4 style={styles.sectionTitle}>{props.t('manualTitle')}</h4>
            <p style={styles.hint}>{props.t('manualLoad')}</p>
            <div style={styles.path}>
              <Input readOnly value={status.extensionDir} />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(status.extensionDir).then(() => {
                    setCopied(true)
                    setTimeout(() => { setCopied(false) }, 1_500)
                  }, () => {
                    // 剪贴板可能被浏览器策略拒绝; 路径本身就显示在输入框里, 可手动选中.
                  })
                }}
              >
                {copied ? props.t('copied') : props.t('copy')}
              </Button>
            </div>
            {status.manualSteps.length > 0 && (
              <ul style={styles.steps}>
                {status.manualSteps.map(step => <li key={step}>{step}</li>)}
              </ul>
            )}
          </section>

          <section style={styles.details}>
            <Button variant="outline" onClick={() => { setShowDetails(value => !value) }}>
              {props.t('details')}
            </Button>
            {showDetails && (
              <div style={styles.detailList}>
                <DetailRow label={props.t('chromePath')} value={status.chromePath ?? ''} />
                <DetailRow label={props.t('profileDir')} value={status.profileDir} />
                <DetailRow label={props.t('extensionDir')} value={status.extensionDir} />
                <DetailRow label={props.t('manifestPath')} value={status.manifestPath ?? ''} />
                <DetailRow label={props.t('extensionId')} value={status.extensionId ?? ''} />
                <DetailRow label={props.t('interpreter')} value={status.interpreter} />
                <DetailRow label={props.t('launchArgs')} value={status.launchArgs?.join(' ') ?? ''} />
                <DetailRow
                  label={props.t('boundTab')}
                  value={status.boundTabId === null ? props.t('none') : String(status.boundTabId)}
                />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
