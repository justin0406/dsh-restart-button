// Mount test for the client half of @local/dsh-restart, using a tiny React-like
// renderer with hooks so the real component code runs unchanged.
import assert from 'node:assert'

const MODULE_ID = '@local/dsh-restart'
let loaded = null
const modules = {}

// ---- tiny React ----
let current = null
let dirty = false
let schedule = null

function createElement(type, props, ...children) {
  const flat = []
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child)
    else flat.push(child)
  }
  return { type, props: { ...(props ?? {}), children: flat } }
}

function depsChanged(a, b) {
  if (a === undefined || b === undefined) return true
  if (a.length !== b.length) return true
  return a.some((value, index) => !Object.is(value, b[index]))
}

const React = {
  createElement,
  useState(initial) {
    const inst = current
    const index = inst.cursor++
    if (!(index in inst.state)) {
      inst.state[index] = typeof initial === 'function' ? initial() : initial
    }
    const setState = (next) => {
      const value = typeof next === 'function' ? next(inst.state[index]) : next
      if (Object.is(value, inst.state[index])) return
      inst.state[index] = value
      dirty = true
      schedule?.()
    }
    return [inst.state[index], setState]
  },
  useRef(initial) {
    const inst = current
    const index = inst.cursor++
    if (!(index in inst.refs)) inst.refs[index] = { current: initial }
    return inst.refs[index]
  },
  useCallback(fn, deps) {
    const inst = current
    const index = inst.cursor++
    const prev = inst.callbacks[index]
    if (prev === undefined || depsChanged(prev.deps, deps)) {
      inst.callbacks[index] = { fn, deps }
    }
    return inst.callbacks[index].fn
  },
  useEffect(fn, deps) {
    const inst = current
    const index = inst.cursor++
    const prev = inst.effects[index]
    inst.effects[index] = { fn, deps }
    const changed = prev === undefined || depsChanged(prev.deps, deps)
    if (changed) {
      prev?.cleanup?.()
      inst.pendingEffects.push(index)
    }
  },
  useSyncExternalStore(subscribeFn, getSnapshot) {
    const inst = current
    const index = inst.cursor++
    const value = getSnapshot()
    inst.storeValues = inst.storeValues ?? {}
    inst.storeValues[index] = value
    React.useEffect(
      () =>
        subscribeFn(() => {
          // Real React re-renders only when getSnapshot() returns a new value;
          // a store that mutates one object in place would silently never
          // update the UI, so the fake has to behave the same way.
          const next = getSnapshot()
          if (Object.is(next, inst.storeValues[index])) return
          dirty = true
          schedule?.()
        }),
      [subscribeFn, getSnapshot],
    )
    return value
  },
}

function renderOnce(component, props, inst) {
  const previous = current
  inst.cursor = 0
  inst.pendingEffects = []
  current = inst
  try {
    return component(props)
  } finally {
    current = previous
  }
}

function flushEffects(inst) {
  for (const index of inst.pendingEffects) {
    const slot = inst.effects[index]
    slot.cleanup = slot.fn() ?? undefined
  }
  inst.pendingEffects = []
}

function treeText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join('')
  return (node.props?.children ?? []).map(treeText).join('')
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.props?.children ?? []) findAll(child, predicate, out)
  return out
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount(component, props) {
  const inst = { state: {}, refs: {}, callbacks: {}, effects: [], cursor: 0, pendingEffects: [], tree: null }
  let rerender = null
  const rerenderPromise = new Promise((resolve) => {
    rerender = resolve
  })
  void rerenderPromise
  schedule = () => {
    dirty = true
    rerender()
  }
  inst.tree = renderOnce(component, props, inst)
  flushEffects(inst)
  for (let round = 0; round < 16; round += 1) {
    await tick()
    await tick()
    if (!dirty) break
    dirty = false
    inst.tree = renderOnce(component, props, inst)
    flushEffects(inst)
  }
  return {
    inst,
    tree: inst.tree,
    rerender: async () => {
      dirty = false
      inst.tree = renderOnce(component, props, inst)
      flushEffects(inst)
      await tick()
      await tick()
      return inst.tree
    },
  }
}

// ---- module loader + ctx fakes ----
let reloads = 0
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
  location: {
    reload: () => {
      reloads += 1
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
}
modules.react = React

const dictionaries = {}
const localeSnapshot = { active: 'zh', locales: ['en', 'zh'], revision: 0 }
const localeSubscribers = new Set()
const locale = {
  bind: (ns) => (key) => dictionaries[ns]?.[localeSnapshot.active]?.[key] ?? key,
  register: (ns, lang, dict) => {
    dictionaries[ns] = dictionaries[ns] ?? {}
    dictionaries[ns][lang] = dict
    return () => {
      delete dictionaries[ns]?.[lang]
    }
  },
  subscribe: (fn) => {
    localeSubscribers.add(fn)
    return () => localeSubscribers.delete(fn)
  },
  getSnapshot: () => localeSnapshot,
}

const injections = []
const registrations = []
const effects = []
const ctx = {
  locale,
  slots: {
    inject: (owner, register) => {
      injections.push(owner)
      const dispose = register()
      effects.push(dispose)
      return dispose
    },
    register: (descriptor, component) => {
      registrations.push({ descriptor, component })
      return () => {}
    },
  },
  effect: (fn) => {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
}

const requests = []
let statusValue = {
  supported: true,
  mode: 'desktop',
  platform: 'darwin',
  hostPid: 4242,
  mainPid: 4000,
  appPath: '/Applications/DeepSeek Harness.app',
  appId: 'com.deepseek.dsh',
}
let statusStatus = 200
let restartStatus = 202
let restartBody = { ok: true, value: { accepted: true, mode: 'desktop', helperPid: 99, logPath: '/tmp/x.log' } }

globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options })
  if (url === '/api/dsh-restart/status') {
    return {
      ok: statusStatus < 300,
      status: statusStatus,
      json: async () => ({
        ok: statusStatus < 300,
        value: statusStatus < 300 ? statusValue : undefined,
        error: statusStatus < 300 ? undefined : { code: 'bridge/forbidden', message: 'nope' },
      }),
    }
  }
  if (url === '/api/dsh-restart/restart') {
    return { ok: restartStatus < 300, status: restartStatus, json: async () => restartBody }
  }
  throw new Error(`unexpected fetch ${url}`)
}

await import(new URL('../client.js', import.meta.url).href)
assert.ok(loaded, 'client module must call window.__ModuleLoader__.load')
assert.equal(loaded.id, MODULE_ID, `client module id must be the package name, got ${loaded.id}`)

const clientModule = loaded.factory((name) => {
  if (!(name in modules)) throw new Error(`unexpected require(${name})`)
  return modules[name]
})
assert.ok(clientModule, 'factory must return the client module')
assert.deepEqual(clientModule.inject, ['slots', 'locale'])
assert.equal(typeof clientModule.apply, 'function')
clientModule.apply(ctx)

assert.deepEqual(injections, ['sidebar.footer.action', 'shell.overlay'])
assert.equal(registrations.length, 2)
const footer = registrations.find((entry) => entry.descriptor.name === 'sidebar.footer.action')
const overlay = registrations.find((entry) => entry.descriptor.name === 'shell.overlay')
assert.ok(footer && overlay, 'both slots must be registered')
assert.equal(footer.descriptor.id, 'dsh-restart')
assert.equal(footer.descriptor.order, 900)
assert.equal(overlay.descriptor.id, 'dsh-restart-dialog')
console.log('ok: slot registrations', JSON.stringify([footer.descriptor, overlay.descriptor]))

const registered = dictionaries['dsh-restart']
assert.ok(registered?.zh?.['footer.label'] && registered.zh['dialog.title'])
assert.ok(registered?.en?.['footer.label'] && registered.en['dialog.confirm'])
console.log('ok: locale dictionaries registered (zh/en)')

const FooterAction = footer.component
const Dialog = overlay.component

// 1. Footer action renders with the localized label and tooltip.
let footerInstance = await mount(FooterAction, { wide: true })
let buttons = findAll(footerInstance.tree, (node) => node.type === 'button')
assert.equal(buttons.length, 1, 'button should render')
assert.match(treeText(footerInstance.tree), /重启 DSH/u)
assert.match(buttons[0].props['aria-label'], /重启 DeepSeek Harness/u)
console.log('ok: button renders in zh with localized label')

// 2. Click -> opens the dialog, which probes status and offers a confirm step.
await buttons[0].props.onClick()
await tick()
const dialogView = await mount(Dialog, {})
await tick()
assert.equal(findAll(dialogView.tree, (node) => node.type === 'button').length > 0, true, 'dialog buttons must render')
assert.match(treeText(dialogView.tree), /重启 DeepSeek Harness/u)
const confirmButton = findAll(dialogView.tree, (node) => node.props?.['data-dsh-restart-confirm'] === '')[0]
assert.ok(confirmButton, 'confirm button must be present')
const statusCalls = requests.filter((entry) => entry.url === '/api/dsh-restart/status').length
assert.equal(statusCalls, 1, 'opening the dialog must probe status once')
console.log('ok: dialog opens with a confirm step')

// 3. Confirm -> POST restart, then wait for the host pid to change and reload.
await confirmButton.props.onClick()
await tick()
const restartPost = requests.find((entry) => entry.url === '/api/dsh-restart/restart')
assert.ok(restartPost, 'restart POST must be issued')
assert.equal(restartPost.options.method, 'POST')
assert.equal(restartPost.options.headers['content-type'], 'application/json')
assert.equal(restartPost.options.body, '{}')

// Host still reports the old pid: no reload.
let confirmView = await mount(Dialog, {})
await tick()
assert.equal(reloads, 0, 'must not reload while the old host still answers')

// New host pid answers: reload.
statusValue = { ...statusValue, hostPid: 5252 }
await new Promise((resolve) => setTimeout(resolve, 1400))
for (let round = 0; round < 30 && reloads === 0; round += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200))
}
assert.ok(reloads > 0, 'page must reload once the new host answers')
console.log('ok: confirm restarts and reloads when the host pid changes')

// 4. Rejected restart -> the dialog shows the error and stays retryable.
const callsBefore = requests.length
restartStatus = 409
restartBody = { ok: false, error: { code: 'restart/unsupported', message: 'cannot restart here' } }
statusValue = { ...statusValue, supported: true, hostPid: 4242 }
statusStatus = 200
// Reopen through the footer action so the dialog is back in its confirm step.
let footerForRejected = await mount(FooterAction, { wide: true })
const rejectedOpenButton = findAll(footerForRejected.tree, (node) => node.type === 'button')[0]
await rejectedOpenButton.props.onClick()
await tick()
let rejectedView = await mount(Dialog, {})
await tick()
let rejectedConfirm = findAll(rejectedView.tree, (node) => node.props?.['data-dsh-restart-confirm'] === '')[0]
assert.ok(rejectedConfirm, 'dialog must be open for the rejected case')
await rejectedConfirm.props.onClick()
await tick()
rejectedView = await mount(Dialog, {})
const rejectedText = treeText(rejectedView.tree)
assert.match(rejectedText, /无法自行重启/u)
console.log('ok: rejected restart shows the unsupported hint')

// 5. Unsupported target -> dialog explains it and the confirm is disabled.
statusValue = { ...statusValue, supported: false, mode: null }
statusStatus = 200
let footerForUnsupported = await mount(FooterAction, { wide: true })
let unsupportedButton = findAll(footerForUnsupported.tree, (node) => node.type === 'button')[0]
await unsupportedButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 120))
let unsupportedView = await mount(Dialog, {})
await tick()
let unsupportedConfirm = findAll(unsupportedView.tree, (node) => node.props?.['data-dsh-restart-confirm'] === '')[0]
assert.equal(unsupportedConfirm, undefined, 'confirm must not be offered when the host cannot restart')
assert.match(treeText(unsupportedView.tree), /无法自行重启/u)
// The dialog must always stay dismissable, even in this state.
const unsupportedCancel = findAll(unsupportedView.tree, (node) => node.props?.['data-dsh-restart-cancel'] === '')[0]
assert.ok(unsupportedCancel, 'cancel must exist when the host cannot restart')
unsupportedCancel.props.onClick()
unsupportedView = await mount(Dialog, {})
assert.equal(findAll(unsupportedView.tree, (node) => node.props?.['data-dsh-restart-dialog'] === '').length, 0, 'cancel must close the dialog')
console.log('ok: confirm disabled and explained when the host reports unsupported')

// 6. English locale.
localeSnapshot.active = 'en'
localeSnapshot.revision += 1
for (const fn of localeSubscribers) fn()
await tick()
footerInstance = await mount(FooterAction, { wide: false })
buttons = findAll(footerInstance.tree, (node) => node.type === 'button')
assert.equal(buttons.length, 1)
assert.match(buttons[0].props['aria-label'], /Restart DeepSeek Harness/u)
console.log('ok: en locale renders "Restart DSH"')

assert.ok(requests.length > callsBefore)
console.log('\nALL CLIENT TESTS PASSED')
