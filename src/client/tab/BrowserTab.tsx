/**
 * 会话级浏览器控制面板 (`conversation.view`).
 *
 * 不复刻 dsh-plugin-chrome 那套实时画面: 本插件驱动的是用户自己的 Chrome, 画面已经在
 * 那个窗口里. 这个 Tab 只做会话独占权的基础控制 —— 看清现在归谁, 把驱动权交给本会话,
 * 或从本会话释放. 点"获取"就是用户本人同意, 因此 Host 侧不再走审批弹窗.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { extensionLinkCounts, type StatusPayload } from '../../../shared/status.js'
import { acquireBrowser, fetchStatus, releaseBrowser } from '../api.js'
import type { BrowserTabKey } from './strings.js'

/** 槽位 inject 传入的面. */
export interface BrowserTabProps {
  /** 本 Tab 命名空间的文案函数. */
  t: (key: BrowserTabKey) => string
  /** 当前会话 id, 由会话作用域槽位的 inject 回调提供. */
  sessionId: string
}

/** 样式片段, 语义 token 与设置页同一套. */
const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: 16, height: '100%', boxSizing: 'border-box' } satisfies CSSProperties,
  headline: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 14, fontWeight: 500 } satisfies CSSProperties,
  rows: { display: 'flex', flexDirection: 'column' } satisfies CSSProperties,
  row: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr',
    alignItems: 'baseline',
    gap: 8,
    padding: '12px 0',
    borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    fontSize: 13,
  } satisfies CSSProperties,
  label: { fontWeight: 500 } satisfies CSSProperties,
  value: { color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' } satisfies CSSProperties,
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' } satisfies CSSProperties,
  hint: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } satisfies CSSProperties,
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.6 } satisfies CSSProperties,
} as const

/**
 * 持有状态对应的文案键.
 *
 * @param holderId 当前持有者.
 * @param sessionId 本会话.
 * @returns 文案键.
 */
function holderKey(holderId: string | null, sessionId: string): BrowserTabKey {
  if (holderId === null) return 'holderNone'
  if (holderId === sessionId) return 'holderSelf'
  return 'holderOther'
}

/**
 * 渲染会话浏览器 Tab.
 *
 * @param props 文案函数与会话 id.
 * @returns Tab 元素.
 */
export function BrowserTab(props: BrowserTabProps): ReactElement {
  const { sessionId, t } = props
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'acquire' | 'release' | null>(null)

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
    const timer = setInterval(() => { void load() }, 3_000)
    return () => { clearInterval(timer) }
  }, [load])

  const act = useCallback(async (kind: 'acquire' | 'release'): Promise<void> => {
    setBusy(kind)
    try {
      const next = kind === 'acquire' ? await acquireBrowser(sessionId) : await releaseBrowser(sessionId)
      setStatus(next)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }, [sessionId])

  const holderId = status?.holderId ?? null
  const holdsHere = holderId === sessionId
  const otherHolds = holderId !== null && holderId !== sessionId
  const linked = status !== null && extensionLinkCounts(status)
  const canAcquire = status !== null && status.ready && !holdsHere && busy === null
  const canRelease = holdsHere && busy === null

  return (
    <div style={styles.root}>
      {error !== null && <p style={styles.error} role="alert">{error}</p>}

      {status === null && error === null && (
        <p style={styles.hint}>{t('loading')}</p>
      )}

      {status !== null && (
        <>
          <p style={styles.headline}>
            <StateDot state={holdsHere ? 'done' : (status.ready ? 'warning' : 'idle')} />
            <span>{t(holderKey(holderId, sessionId))}</span>
          </p>

          <div style={styles.rows}>
            <div style={styles.row}>
              <span style={styles.label}>{t('session')}</span>
              <code style={styles.value}>{sessionId}</code>
            </div>
            {otherHolds && (
              <div style={styles.row}>
                <span style={styles.label}>{t('holderOther')}</span>
                <code style={styles.value}>{holderId}</code>
              </div>
            )}
            <div style={styles.row}>
              <span style={styles.label}>{t(linked ? 'connected' : 'disconnected')}</span>
              <span style={styles.value}>{linked ? (status.extensionVersion ?? '') : (status.launchStandaloneChromeProfile && status.launchArgs === null ? t('standalonePending') : '')}</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>{t(linked && status.boundTabId !== null ? 'bound' : 'unbound')}</span>
              <span style={styles.value}>{linked && status.boundTabId !== null ? String(status.boundTabId) : ''}</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>{t(status.ready ? 'ready' : 'notReady')}</span>
              <span style={styles.value}>{status.manualSteps[0] ?? ''}</span>
            </div>
          </div>

          <div style={styles.actions}>
            <Button
              variant="primary"
              disabled={!canAcquire}
              onClick={() => { void act('acquire') }}
            >
              {busy === 'acquire' ? t('acquiring') : t(otherHolds ? 'takeOver' : 'acquire')}
            </Button>
            <Button
              variant="outline"
              disabled={!canRelease}
              onClick={() => { void act('release') }}
            >
              {busy === 'release' ? t('releasing') : t('release')}
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => { void load() }}
            >
              {t('refresh')}
            </Button>
          </div>

          <p style={styles.hint}>{t('hint')}</p>
        </>
      )}
    </div>
  )
}
