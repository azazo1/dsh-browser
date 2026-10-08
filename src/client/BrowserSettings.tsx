/**
 * 浏览器连接设置页: 展示就绪状态, 并在缺东西时提供一键安装.
 *
 * 界面按这个次序:
 *   1. 结论行   —— 现在能不能用.
 *   2. 检查清单 —— Chrome, 连接组件, 扩展连接, 浏览器启动方式, 配对令牌, 浏览器求值, 标签页绑定.
 *      每行的状态有四态 (正常 / 需处理 / 配置错误 / 尚不可知), 映射见 checks.ts.
 *   3. 操作按钮 —— 安装 / 卸载连接组件, 刷新状态.
 *   4. 手动步骤 —— 必须由用户做的事 (在 chrome://extensions 里加载扩展), 写明具体路径并提供复制按钮.
 *   5. 配置表单 —— 独立 profile 开关与配对令牌. 开关改变"用哪个 Chrome"; 令牌是手动步骤的
 *      最后一步, 放在同一张表单里保存.
 *   6. 细节     —— 路径, 扩展 id, 解释器, 启动参数, 排查时才需要.
 *
 * 除了表单里那两项, 页面上的信息都是"Host 观测到的运行时状态", 不是 profile 里的配置值,
 * 所以它们刻意不做成输入框 —— 那会让人以为可以改. 样式用内联样式加 dsh 的语义 token,
 * 不写死颜色.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  Button, Input, SettingsForm, SettingsValueField, StateDot, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StatusPayload } from '../../shared/status.js'
import { fetchStatus, installHost, uninstallHost } from './api.js'
import { checks } from './checks.js'
import type { PairingCardFace, PairingCardState } from './pairing-form.js'
import type { BrowserSettingsKey } from './strings.js'

/** 组件属性: 由渲染器按槽位契约绑定. */
export type BrowserSettingsProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.dsh-browser'>
  & InjectFace<PairingCardFace>

/**
 * 把词典拼成表单框架要的文案.
 *
 * @param t 文案查找函数.
 * @returns 框架文案.
 */
function formLabels(t: (key: BrowserSettingsKey) => string): SettingsFormLabels {
  return {
    unavailable: t('formUnavailable'),
    readOnly: t('formReadOnly'),
    saveFailed: t('formSaveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
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
  switchRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 0',
    borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  } satisfies CSSProperties,
  switchHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  } satisfies CSSProperties,
  switchLabel: { fontSize: 13, fontWeight: 500 } satisfies CSSProperties,
  switchMeta: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } satisfies CSSProperties,
  override: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } satisfies CSSProperties,
} as const

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
  const pairing = props.usePairingForm(snapshot => snapshot)

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
                <StateDot state={row.state} />
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

          {/*
            配对令牌的表单紧跟在"需要手动完成"那一节之后: 它本身就是那些手动步骤里的最后一步,
            放在这里读起来是连贯的 (先看该做什么, 再就地填进去). 而状态清单与按钮属于"看情况",
            放在前面会把这件必须做的事往后推.
          */}
          <SettingsForm
            labels={formLabels(props.t)}
            state={pairing}
            onSave={props.save}
            onDiscard={props.discard}
          >
            <div style={styles.switchRow}>
              <div style={styles.switchHead}>
                <span style={styles.switchLabel}>{props.t('launchLabel')}</span>
                <div style={styles.switchMeta}>
                  {pairing.launchStandaloneChromeProfile.overridden && (
                    <>
                      <span style={styles.override}>{props.t('overridden')}</span>
                      <Button
                        variant="ghost"
                        disabled={!pairing.writable}
                        onClick={() => { props.resetField('launchStandaloneChromeProfile') }}
                      >
                        {props.t('reset')}
                      </Button>
                    </>
                  )}
                  <Switch
                    checked={pairing.launchStandaloneChromeProfile.text === 'true'}
                    disabled={!pairing.writable}
                    label={props.t('launchLabel')}
                    onChange={(next) => { props.edit('launchStandaloneChromeProfile', next ? 'true' : 'false') }}
                  />
                </div>
              </div>
              <p style={styles.hint}>{props.t('launchHint')}</p>
            </div>
            <SettingsValueField
              id="plugin-config-dsh-browser-pairing-token"
              label={props.t('tokenLabel')}
              hint={props.t('tokenHint')}
              overriddenLabel={props.t('overridden')}
              resetLabel={props.t('reset')}
              invalidLabel={props.t('invalidToken')}
              placeholder={props.t('tokenPlaceholder')}
              disabled={!pairing.writable}
              {...pairing.pairingToken}
              onEdit={(text) => { props.edit('pairingToken', text) }}
              onReset={() => { props.resetField('pairingToken') }}
            />
          </SettingsForm>

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
