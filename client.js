window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useSyncExternalStore } = React

    const NS = 'dsh-restart'
    const API = '/api/dsh-restart'
    const POLL_MS = 1_200
    const FETCH_TIMEOUT_MS = 8_000
    const RELOAD_TIMEOUT_MS = 120_000
    const SLOW_HINT_MS = 25_000

    /* ------------------------------------------------------------------ i18n */

    const zh = {
      'footer.label': '重启 DSH',
      'footer.tooltip': '重启 DeepSeek Harness（退出后自动重新打开）',
      'dialog.title': '重启 DeepSeek Harness',
      'dialog.body': '应用会先完全退出，然后自动重新打开。未保存的输入会丢失。',
      'dialog.mode.desktop': '当前形态：桌面应用（整应用重启）',
      'dialog.mode.cli': '当前形态：dsh web（替换服务端进程）',
      'dialog.checking': '正在检查运行环境…',
      'dialog.busy': '正在退出，请稍候…',
      'dialog.waiting': '已请求重启，正在等待新的进程接管…',
      'dialog.slow': '还没有回来；若出现「退出 DeepSeek Harness？」确认框，请选择「退出」。',
      'dialog.confirm': '重启',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.unsupported': '当前运行环境无法自行重启，请手动退出后重新打开。',
      'error.forbidden': '请求被拒绝：只允许本机页面调用。',
      'error.spawn': '助手启动失败，未能执行重启。',
      'error.reloadTimeout': '等待超时，请手动刷新页面或重新打开应用。',
      'error.generic': '重启失败。',
    }

    const en = {
      'footer.label': 'Restart DSH',
      'footer.tooltip': 'Restart DeepSeek Harness (it quits and reopens itself)',
      'dialog.title': 'Restart DeepSeek Harness',
      'dialog.body': 'The app will quit completely and reopen itself. Unsaved input is lost.',
      'dialog.mode.desktop': 'Current mode: desktop app (full restart)',
      'dialog.mode.cli': 'Current mode: dsh web (server process replaced)',
      'dialog.checking': 'Checking the runtime…',
      'dialog.busy': 'Quitting, please wait…',
      'dialog.waiting': 'Restart requested; waiting for the new process…',
      'dialog.slow': 'Still not back. If a "Quit DeepSeek Harness?" dialog is open, choose Quit.',
      'dialog.confirm': 'Restart',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.unsupported': 'This runtime cannot restart itself; quit and reopen the app manually.',
      'error.forbidden': 'Request refused: only local pages may call this.',
      'error.spawn': 'The helper could not be started, so nothing was restarted.',
      'error.reloadTimeout': 'Timed out. Reload the page or reopen the app manually.',
      'error.generic': 'Restart failed.',
    }

    /* ----------------------------------------------------------------- store */

    // Every update replaces the snapshot object: React only re-renders when the
    // value returned by getSnapshot is a new reference, so mutating one object
    // in place would leave the dialog permanently stale (it opens late and then
    // never closes).
    const initial = Object.freeze({ open: false, phase: 'idle', status: null, error: null, errorDetail: null, slow: false })
    let store = initial
    const listeners = new Set()

    const emit = () => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {}
      }
    }
    const patch = (next) => {
      store = Object.freeze({ ...store, ...next })
      emit()
    }
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const snapshot = () => store

    const reset = () => patch({ open: false, phase: 'idle', status: null, error: null, errorDetail: null, slow: false })

    /* ---------------------------------------------------------------- bridge */

    const callBridge = async (verb, payload) => {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer =
        controller === undefined ? undefined : setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(`${API}/${verb}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          ...(controller === undefined ? {} : { signal: controller.signal }),
        })
        let body
        try {
          body = await response.json()
        } catch {
          body = undefined
        }
        return { status: response.status, body }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    const describeFailure = (t, result) => {
      const code = result?.body?.error?.code
      if (code === 'bridge/forbidden' || code === 'restart/forbidden') return t('error.forbidden')
      if (code === 'restart/spawn-failed') return t('error.spawn')
      if (code === 'restart/unsupported') return t('dialog.unsupported')
      const message = result?.body?.error?.message
      return typeof message === 'string' && message !== '' ? message : t('error.generic')
    }

    const watchForReplacement = (t, previousHostPid) => {
      const startedAt = Date.now()
      const tick = async () => {
        if (Date.now() - startedAt > RELOAD_TIMEOUT_MS) {
          patch({ phase: 'error', error: t('error.reloadTimeout'), errorDetail: 'restart/reload-timeout', slow: false })
          return
        }
        try {
          const result = await callBridge('status', {})
          const value = result.body?.value
          if (result.status === 200 && value !== undefined && value.hostPid !== previousHostPid) {
            window.location.reload()
            return
          }
        } catch {}
        setTimeout(tick, POLL_MS)
      }
      setTimeout(tick, POLL_MS)
    }

    const requestRestart = async (t) => {
      const previousHostPid = store.status?.hostPid ?? null
      patch({ phase: 'starting', error: null, errorDetail: null, slow: false })
      let result
      try {
        result = await callBridge('restart', {})
      } catch {
        patch({ phase: 'error', error: t('error.generic'), errorDetail: 'network', slow: false })
        return
      }
      if (result.status !== 202 && result.status !== 200) {
        patch({ phase: 'error', error: describeFailure(t, result), errorDetail: result.body?.error?.code ?? null, slow: false })
        return
      }
      patch({ phase: 'waiting' })
      setTimeout(() => {
        if (store.phase === 'waiting') patch({ slow: true })
      }, SLOW_HINT_MS)
      watchForReplacement(t, previousHostPid)
    }

    const openDialog = async (t) => {
      patch({ open: true, phase: 'checking', status: null, error: null, errorDetail: null, slow: false })
      try {
        const result = await callBridge('status', {})
        const value = result.body?.value
        if (result.status !== 200 || value === undefined) {
          patch({ phase: 'error', error: describeFailure(t, result), errorDetail: result.body?.error?.code ?? null })
          return
        }
        patch({ status: value, phase: 'confirm' })
      } catch {
        patch({ phase: 'error', error: t('error.generic'), errorDetail: 'network' })
      }
    }

    /* -------------------------------------------------------------------- ui */

    const icon = (size) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4v5h-5' }),
      )

    const noticeStyle = (tone) => ({
      margin: '10px 0 0',
      fontSize: 12,
      lineHeight: '18px',
      color: tone === 'error' ? 'var(--dsw-alias-state-error-primary, #dc2626)' : 'var(--dsw-alias-label-secondary, #6b7280)',
    })

    const Notice = ({ tone = 'muted', children }) => h('p', { style: noticeStyle(tone) }, children)

    const plainButton = {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      display: 'flex',
      alignItems: 'center',
      cursor: 'pointer',
      borderRadius: 8,
    }

    const FooterAction = (props) => {
      useSyncExternalStore(
        (listener) => ctxLocale.subscribe(listener),
        () => ctxLocale.getSnapshot().active,
        () => ctxLocale.getSnapshot().active,
      )
      const state = useSyncExternalStore(subscribe, snapshot, snapshot)
      const t = ctxLocale.bind(NS)
      const compact = props?.wide === false
      const busy = state.phase === 'starting' || state.phase === 'waiting'
      return h(
        'button',
        {
          type: 'button',
          'data-dsh-restart-button': '',
          'aria-label': t('footer.tooltip'),
          title: t('footer.tooltip'),
          'aria-busy': busy ? 'true' : 'false',
          onClick: () => {
            openDialog(ctxLocale.bind(NS))
          },
          style: {
            ...plainButton,
            justifyContent: compact ? 'center' : 'flex-start',
            gap: compact ? 0 : 8,
            width: compact ? 36 : 'calc(100% + 4px)',
            height: compact ? 36 : 42,
            margin: compact ? '3px 0' : '4px -2px',
            padding: compact ? 0 : '0 10px 0 8px',
            opacity: busy ? 0.7 : 1,
          },
        },
        h('span', { style: { display: 'inline-flex', flex: 'none', width: compact ? 18 : 16 } }, icon(compact ? 18 : 16)),
        compact
          ? null
          : h(
              'span',
              {
                style: {
                  fontSize: 13,
                  lineHeight: '18px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              t('footer.label'),
            ),
      )
    }

    /* ------------------------------------------------------------------ slot */

    const closeButton = (t, onClose) =>
      h(
        'button',
        {
          type: 'button',
          'data-dsh-restart-close': '',
          'aria-label': t('dialog.close'),
          title: t('dialog.close'),
          onClick: onClose,
          style: {
            ...plainButton,
            width: 24,
            height: 24,
            justifyContent: 'center',
            fontSize: 16,
            lineHeight: '16px',
            opacity: 0.7,
            flex: 'none',
          },
        },
        '×',
      )

    const Dialog = () => {
      useSyncExternalStore(
        (listener) => ctxLocale.subscribe(listener),
        () => ctxLocale.getSnapshot().active,
        () => ctxLocale.getSnapshot().active,
      )
      const state = useSyncExternalStore(subscribe, snapshot, snapshot)
      const t = ctxLocale.bind(NS)
      const open = state.open === true
      const supported = state.status?.supported === true
      const busy = state.phase === 'starting' || state.phase === 'waiting'
      const canConfirm = state.phase === 'confirm' && supported

      const onConfirm = useCallback(() => {
        requestRestart(ctxLocale.bind(NS))
      }, [])
      const onClose = useCallback(() => {
        reset()
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            reset()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open])

      if (!open) return null

      const panel = h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'data-dsh-restart-dialog': '',
          onMouseDown: (event) => event.stopPropagation(),
          style: {
            pointerEvents: 'auto',
            width: 'min(420px, 92vw)',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            color: 'var(--dsw-alias-label-primary, #1f2328)',
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
            borderRadius: 14,
            padding: 18,
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.18)',
            fontFamily: 'inherit',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
          h('h2', { style: { margin: 0, flex: 1, fontSize: 16, fontWeight: 600 } }, t('dialog.title')),
          closeButton(t, onClose),
        ),
        h('p', { style: { margin: '8px 0 0', fontSize: 13, lineHeight: '20px' } }, t('dialog.body')),
        state.phase === 'checking' ? h(Notice, null, t('dialog.checking')) : null,
        state.status?.mode === 'desktop' || state.status?.mode === 'cli'
          ? h('p', { style: { margin: '6px 0 0', fontSize: 12, lineHeight: '18px', opacity: 0.8 } }, t(`dialog.mode.${state.status.mode}`))
          : null,
        state.phase === 'starting' ? h(Notice, null, t('dialog.busy')) : null,
        state.phase === 'waiting' ? h(Notice, null, t('dialog.waiting')) : null,
        state.slow ? h(Notice, null, t('dialog.slow')) : null,
        state.phase === 'error' && typeof state.error === 'string' ? h(Notice, { tone: 'error' }, state.error) : null,
        state.phase === 'confirm' && supported === false ? h(Notice, { tone: 'error' }, t('dialog.unsupported')) : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
          h(
            'button',
            {
              type: 'button',
              'data-dsh-restart-cancel': '',
              onClick: onClose,
              style: {
                ...plainButton,
                border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.16))',
                padding: '0 12px',
                height: 32,
                fontSize: 13,
                justifyContent: 'center',
              },
            },
            t('dialog.cancel'),
          ),
          canConfirm
            ? h(
                'button',
                {
                  type: 'button',
                  'data-dsh-restart-confirm': '',
                  onClick: onConfirm,
                  style: {
                    ...plainButton,
                    background: 'var(--dsw-alias-button-primary-fill, #1f2328)',
                    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
                    border: '1px solid transparent',
                    padding: '0 14px',
                    height: 32,
                    fontSize: 13,
                    fontWeight: 600,
                    justifyContent: 'center',
                  },
                },
                t('dialog.confirm'),
              )
            : null,
        ),
      )

      return h(
        'div',
        {
          'data-dsh-restart-backdrop': '',
          onMouseDown: () => reset(),
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2_147_483_000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.34)',
            // shell.overlay is click-through by default; without this the panel
            // is visible but unreachable and the backdrop swallows every click.
            pointerEvents: 'auto',
          },
        },
        panel,
      )
    }

    /* ----------------------------------------------------------------- apply */

    let ctxLocale

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctxLocale = ctx.locale

        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', zh)
          const offEn = ctx.locale.register(NS, 'en', en)
          return () => {
            offZh()
            offEn()
          }
        }, 'dsh-restart: dictionaries')

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-restart',
              order: 900,
              label: () => ctx.locale.bind(NS)('footer.label'),
            },
            FooterAction,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-restart-dialog' }, Dialog),
        )
      },
    }
  },
})
