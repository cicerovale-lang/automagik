import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import fs, {
  chmodSync, closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import test from 'node:test'
import { recordLaunch } from '../entrypoint.mjs'
import { SelfHostedClaim } from '../gate-claim.mjs'
import { SessionStore } from '../gate-store.mjs'
import { DshCredentials } from '../gate-upstream.mjs'
import {
  createViewCheck, prepareGateView, readViewFile, viewProblem, writeProfileState,
} from '../gate-view.mjs'
import { createGate } from '../gate.mjs'
import { healthReport } from '../healthcheck.mjs'
import { GATE_VIEW, gateViewDir, profileDirOf } from '../lib.mjs'
import { markSeed, PLUGINS, profileState } from '../profile-state.mjs'

const version = '3.93.0'
const plugins = Object.fromEntries(PLUGINS.map(name => [name, version]))
const build = { automagik: version, plugins, revision: 'a'.repeat(40) }
const gateEnv = { AUTOMAGIK_GATE_ENABLED: '1' }
const tempId = '12345678-abcd-4abc-8abc-123456789abc'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-gate-view-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh')
  const viewDir = join(root, GATE_VIEW)
  const profile = profileDirOf(dshHome)
  prepareGateView(viewDir, root, { DSH_HOME: dshHome })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(root, 'versions.json'), JSON.stringify(build))
  writeFileSync(join(profile, 'package.json'), '{}\n')
  markSeed(profile, version)
  for (const name of PLUGINS) {
    const dir = join(profile, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  }
  return {
    root, dshHome, viewDir, profile, profileFile: join(viewDir, 'profile-state.json'),
    report: (env = {}) => healthReport({ root, dshHome, viewDir, env, probe: async () => 401 }),
    state: () => profileState({ profile, source: join(root, 'profile'), build, dshHome }),
  }
}

function entrypoint(t, extra = {}) {
  const { root, viewDir } = fixture(t)
  const harness = `
    import childProcess from 'node:child_process'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    // A host's own /data is never this test's: the view stays in the fixture's home.
    const exists = fs.existsSync
    fs.existsSync = (path) => path !== '/data' && exists(path)
    const lstat = fs.lstatSync
    fs.lstatSync = (path, options) => {
      const info = lstat(path, options)
      if (path === process.env.TEST_VIEW && info) info.uid = Number(process.env.TEST_UID)
      return info
    }
    childProcess.spawn = () => {
      console.error('unexpected child process')
      process.exit(97)
    }
    syncBuiltinESMExports()
    await import(${JSON.stringify(new URL('../entrypoint.mjs', import.meta.url).href)})
  `
  const env = {
    PATH: process.env.PATH, HOME: root, AUTOMAGIK_HOME: root, TEST_VIEW: viewDir, TEST_UID: String(process.getuid()),
    XDG_RUNTIME_DIR: join(root, 'run'), HC_SESSION: 'test-gate-view', ...extra,
  }
  const refuse = (reason, overrides = {}) => {
    const stdout = join(root, 'stdout')
    const stderr = join(root, 'stderr')
    const out = openSync(stdout, 'w')
    const err = openSync(stderr, 'w')
    let result
    try {
      result = spawnSync(process.execPath, ['--input-type=module', '--eval', harness], {
        env: { ...env, ...overrides }, stdio: ['ignore', out, err], timeout: 5_000,
      })
    } finally {
      closeSync(out)
      closeSync(err)
    }
    const message = readFileSync(stderr, 'utf8')
    assert.ifError(result.error)
    assert.equal(result.status, 1, message)
    assert.equal(readFileSync(stdout, 'utf8'), '')
    assert.match(message, /^automagik-web: [^\r\n]+\n$/)
    assert.match(message, reason)
  }
  return { root, viewDir, refuse }
}

test('startup refuses a view that is a file, a symlink or owned by another uid', async t => {
  const typeError = /gate-view must be a real directory owned by uid \d+/
  await t.test('file', t => {
    const { viewDir, refuse } = entrypoint(t)
    rmSync(viewDir, { recursive: true })
    writeFileSync(viewDir, '')
    refuse(typeError)
  })
  await t.test('symlink to a directory', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    rmSync(viewDir, { recursive: true })
    symlinkSync(join(root, 'dsh'), viewDir)
    refuse(typeError)
  })
  await t.test('wrong owner', t => {
    entrypoint(t).refuse(typeError, { TEST_UID: String(process.getuid() + 1) })
  })
})

test('startup refuses unexpected names and nonregular entries in the view', async t => {
  for (const [name, plant, reason] of [
    ['.credentials.yaml', file => writeFileSync(file, 'dummy'), /unexpected entry/],
    ['launch-url.' + 'a'.repeat(36) + '.tmp', file => writeFileSync(file, ''), /unexpected entry/],
    ['launch-url', file => mkdirSync(file), /must be a regular file/],
    ['profile-state.json.' + tempId + '.tmp', file => symlinkSync('missing', file),
      /must be a regular file/],
  ]) {
    await t.test(name, t => {
      const { viewDir, refuse } = entrypoint(t)
      plant(join(viewDir, name))
      refuse(reason)
    })
  }
})

test('startup refuses real path overlaps in either direction', async t => {
  for (const name of ['DSH_HOME', 'AUTOMAGIK_BOTS_HOME', 'AUTOMAGIK_WORKSPACE', 'HERDR_APP_HOME']) {
    await t.test(name, t => {
      const { root, viewDir, refuse } = entrypoint(t)
      const alias = join(root, 'alias')
      symlinkSync(viewDir, alias)
      refuse(new RegExp('gate-view overlaps ' + name), { [name]: join(alias, 'missing') })
      assert.deepEqual(readdirSync(viewDir), [])
    })
  }
  await t.test('private ancestor of the view', t => {
    const { root, refuse } = entrypoint(t)
    const alias = join(root, 'alias')
    symlinkSync(join(root, '..'), alias)
    refuse(/gate-view overlaps DSH_HOME/, { DSH_HOME: alias })
  })
  await t.test('secrets symlink to the view', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    symlinkSync(viewDir, join(root, 'secrets'))
    refuse(/gate-view overlaps secrets/)
  })
  await t.test('ACP store symlink to the view', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    symlinkSync(viewDir, join(root, 'acp'))
    refuse(/gate-view overlaps acp/)
  })
  await t.test('ACP sign-in homes symlink to the view', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    mkdirSync(join(root, 'acp'))
    symlinkSync(viewDir, join(root, 'acp', 'cli-homes'))
    refuse(/gate-view overlaps acp cli-homes/)
  })
})

test('the view DSH writes is the volume subpath Compose mounts, whatever AUTOMAGIK_HOME says', () => {
  assert.equal(gateViewDir('/elsewhere', { exists: path => path === '/data' }), '/data/gate-view')
  assert.equal(gateViewDir('/data', { exists: path => path === '/data' }), '/data/gate-view')
  assert.equal(gateViewDir('/tmp/home', { exists: () => false }), join('/tmp/home', GATE_VIEW))
})

test('preparing the view repairs its mode and removes only writer leftovers', t => {
  const { root, viewDir } = fixture(t)
  const dirs = { AUTOMAGIK_HOME: root, DSH_HOME: viewDir + '-sibling' }
  rmSync(viewDir, { recursive: true })
  prepareGateView(viewDir, root, dirs)
  assert.equal(statSync(viewDir).mode & 0o7777, 0o700)
  chmodSync(viewDir, 0o755)
  for (const file of ['launch-url', 'profile-state.json']) {
    writeFileSync(join(viewDir, file), 'published')
    writeFileSync(join(viewDir, file + '.' + tempId + '.tmp'), 'leftover')
  }
  prepareGateView(viewDir, root, dirs)
  assert.equal(statSync(viewDir).mode & 0o7777, 0o700)
  assert.deepEqual(readdirSync(viewDir).sort(), ['launch-url', 'profile-state.json'])
})

test('recordLaunch atomically replaces both private launch files with identical bytes', t => {
  const { dshHome, viewDir } = fixture(t)
  const operatorFile = join(dshHome, 'launch-url')
  const gateFile = join(viewDir, 'launch-url')
  const first = 'http://127.0.0.1:3081/?token=test-first'
  const second = 'http://127.0.0.1:3081/?token=test-second'
  assert.equal(recordLaunch(dshHome, viewDir, first), operatorFile)

  const previous = openSync(gateFile, 'r')
  try {
    recordLaunch(dshHome, viewDir, second)
    assert.equal(readFileSync(previous, 'utf8'), `${first}\n`)
    assert.equal(readFileSync(gateFile, 'utf8'), `${second}\n`)
    assert.deepEqual(readFileSync(operatorFile), readFileSync(gateFile))
    assert.equal(statSync(gateFile).mode & 0o777, 0o600)
    assert.equal(statSync(operatorFile).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(viewDir), ['launch-url'])
  } finally {
    closeSync(previous)
  }
})

test('a failed launch publication removes the old gate token and saves the operator copy', t => {
  const { dshHome, viewDir } = fixture(t)
  const gateFile = join(viewDir, 'launch-url')
  const operatorFile = join(dshHome, 'launch-url')
  const first = 'http://127.0.0.1:3081/?token=test-first'
  const second = 'http://127.0.0.1:3081/?token=test-second'
  recordLaunch(dshHome, viewDir, first)

  const rename = fs.renameSync
  const attempts = []
  t.mock.method(fs, 'renameSync', (from, to) => {
    attempts.push(to)
    if (to === gateFile) throw new Error('test view write failure')
    rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const warning = t.mock.method(process.stderr, 'write', () => true)
  assert.equal(recordLaunch(dshHome, viewDir, second), operatorFile)
  assert.deepEqual(attempts, [gateFile, operatorFile])
  assert.deepEqual(readdirSync(viewDir), [])
  assert.equal(readFileSync(operatorFile, 'utf8'), second + '\n')
  assert.equal(warning.mock.callCount(), 1)
  assert.match(warning.mock.calls[0].arguments[0], /could not publish the gate launch URL/)
  assert.match(warning.mock.calls[0].arguments[0], /test view write failure/)
})

test('the view writer publishes only the profile health fields in a private file', t => {
  const { dshHome, viewDir, profileFile, state } = fixture(t)
  writeProfileState(viewDir, {
    ...state(), plugins: { ...plugins, extra: dshHome }, path: dshHome, token: 'test-only',
  })
  const data = JSON.parse(readFileSync(profileFile, 'utf8'))
  assert.deepEqual(data, {
    schemaVersion: 1, at: new Date(data.at).toISOString(), plugins,
    followsImage: true, ownerManaged: false, reason: 'matching-image',
  })
  assert.equal(statSync(profileFile).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(viewDir), ['profile-state.json'])
})

test('DSH health refreshes the view and gate health uses it without the live profile', async t => {
  const { profile, report } = fixture(t)
  assert.equal((await report()).healthy, true)
  const old = join(profile, 'node_modules', PLUGINS[0], 'package.json')
  writeFileSync(old, JSON.stringify({ version: '3.90.1' }))
  assert.equal((await report(gateEnv)).plugins[PLUGINS[0]], version)
  assert.equal((await report()).reason, 'update-required')
  rmSync(profile, { recursive: true })
  const refreshed = await report(gateEnv)
  assert.equal(refreshed.healthy, false)
  assert.equal(refreshed.reason, 'update-required')
  assert.equal(refreshed.plugins[PLUGINS[0]], '3.90.1')
})

test('gate health fails closed with a missing or malformed view even with a healthy profile',
  async t => {
    const { profileFile, report, viewDir, state } = fixture(t)
    const assertMissing = async () => {
      const result = await report(gateEnv)
      assert.equal(result.healthy, false)
      assert.equal(result.fence.healthy, true)
      assert.equal(result.followsImage, false)
      assert.equal(result.ownerManaged, false)
      assert.equal(result.reason, 'no-profile-state')
      assert.deepEqual(result.plugins, Object.fromEntries(PLUGINS.map(name => [name, null])))
    }
    await assertMissing()
    writeProfileState(viewDir, state())
    const valid = JSON.parse(readFileSync(profileFile, 'utf8'))
    assert.equal((await report(gateEnv)).healthy, true)
    for (const malformed of [
      '{', JSON.stringify({ ...valid, path: '/home/ada' }),
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, at: '2026-02-30T00:00:00.000Z' }),
      JSON.stringify({ ...valid, plugins: { ...plugins, extra: version } }),
      JSON.stringify({ ...valid, plugins: { ...plugins, [PLUGINS[0]]: '/home/ada' } }),
      JSON.stringify({ ...valid, plugins: { [PLUGINS[0]]: version } }),
      JSON.stringify({ ...valid, followsImage: 'true' }),
      JSON.stringify({ ...valid, ownerManaged: true }),
      JSON.stringify({ ...valid, reason: 'missing-plugins' }),
      JSON.stringify({ ...valid, plugins: { ...plugins, [PLUGINS[0]]: null } }),
      JSON.stringify({ ...valid, reason: 'unknown' }),
      // Contradictions with the producer's rules or with this image's own plugin versions.
      JSON.stringify({ ...valid, followsImage: false, ownerManaged: true, reason: 'invalid-profile' }),
      JSON.stringify({ ...valid, plugins: { ...plugins, [PLUGINS[0]]: '3.90.0' } }),
    ]) {
      writeFileSync(profileFile, malformed)
      await assertMissing()
    }
  })

test('gate health expires stale and future snapshots without affecting DSH', async t => {
  const { profileFile, report, viewDir, state } = fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T12:00:00.000Z') })
  writeProfileState(viewDir, state())
  const valid = JSON.parse(readFileSync(profileFile, 'utf8'))
  const snapshotAt = offset => {
    const at = new Date(Date.now() + offset).toISOString()
    writeFileSync(profileFile, JSON.stringify({ ...valid, at }))
  }
  for (const offset of [-300_000, 60_000]) {
    snapshotAt(offset)
    assert.equal((await report(gateEnv)).healthy, true)
  }
  for (const offset of [-300_001, 60_001]) {
    snapshotAt(offset)
    const gate = await report(gateEnv)
    assert.equal(gate.healthy, false)
    assert.equal(gate.fence.healthy, true)
    assert.equal(gate.followsImage, false)
    assert.equal(gate.ownerManaged, false)
    assert.equal(gate.reason, 'stale-profile-state')
    assert.equal((await report()).healthy, true)
    assert.equal((await report(gateEnv)).healthy, true)
  }
})

test('gate upstream defaults to the view and rereads its launch URL on refresh', async t => {
  assert.equal(new DshCredentials().launchFile, '/dsh-view/launch-url')
  const { dshHome, viewDir, state } = fixture(t)
  writeProfileState(viewDir, state())
  const credentials = new DshCredentials({
    launchFile: join(viewDir, 'launch-url'), viewReady: createViewCheck(viewDir, build),
  })
  const request = t.mock.method(credentials, 'request', async path => {
    const token = new URL(path, 'http://ignored.invalid').searchParams.get('token')
    return { statusCode: 303, headers: { 'set-cookie': [`dsh-session=${token}; HttpOnly`] } }
  })
  recordLaunch(dshHome, viewDir, 'https://ignored.invalid/?token=first')
  assert.equal(await credentials.cookie(), 'dsh-session=first')
  recordLaunch(dshHome, viewDir, 'https://ignored.invalid/?token=second')
  assert.equal(await credentials.cookie(), 'dsh-session=first')
  assert.equal(await credentials.cookie(true), 'dsh-session=second')
  assert.deepEqual(request.mock.calls.map(call => call.arguments), [
    ['/?token=first'], ['/?token=second'],
  ])
})

test('a custom home that does not exist yet does not stop the view from being prepared', t => {
  const root = mkdtempSync(join(tmpdir(), 'automagik-gate-view-home-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'not-yet', 'home')
  const view = join(home, GATE_VIEW)
  prepareGateView(view, home, { AUTOMAGIK_HOME: home, DSH_HOME: join(home, 'dsh'), secrets: join(home, 'secrets') })
  assert.equal(statSync(view).mode & 0o7777, 0o700)
  assert.deepEqual(readdirSync(view), [])
})

test('view validation allows only private publications', async t => {
  const { viewDir, dshHome, state, profileFile } = fixture(t)
  recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  writeProfileState(viewDir, state())
  assert.equal(viewProblem(viewDir), null)

  for (const [name, plant, reason] of [
    ['extra', file => writeFileSync(file, 'test-only', { mode: 0o600 }), /unexpected entry/],
    ['link', file => symlinkSync(profileFile, file), /unexpected entry/],
    [`launch-url.${tempId}.tmp`, file => mkdirSync(file), /unexpected entry/],
    [`profile-state.json.${tempId}.tmp`, file => symlinkSync(profileFile, file),
      /unexpected entry/],
    [`launch-url.${tempId}.tmp`, file => writeFileSync(file, '', { mode: 0o600 }),
      /unexpected entry/],
    ['launch-url.12345678-abcd-5abc-8abc-123456789abc.tmp', file => writeFileSync(file, ''),
      /unexpected entry/],
  ]) {
    await t.test(name, () => {
      const file = join(viewDir, name)
      plant(file)
      const problem = viewProblem(viewDir)
      assert.match(problem, reason)
      assert.ok(problem.includes(JSON.stringify(name)))
      assert.ok(!problem.includes('test-only'))
      rmSync(file, { recursive: true })
    })
  }

  chmodSync(profileFile, 0o640)
  assert.match(viewProblem(viewDir), /mode 0600: "profile-state.json"$/)
  chmodSync(profileFile, 0o600)
  assert.equal(viewProblem(viewDir), null)
})

test('DSH health withdraws only the publications and does not write a snapshot', async t => {
  const { viewDir, dshHome, profileFile, report } = fixture(t)
  const launch = 'http://ignored.invalid/?token=test'
  const operatorFile = recordLaunch(dshHome, viewDir, launch)
  assert.equal((await report()).healthy, true)

  const extra = join(viewDir, 'extra-ada')
  writeFileSync(extra, 'test-only', { mode: 0o600 })
  const rename = t.mock.method(fs, 'renameSync')
  const stderr = t.mock.method(process.stderr, 'write', () => true)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const blocked = await report()
  assert.equal(blocked.healthy, false)
  assert.equal(blocked.reason, 'gate-view-tampered')
  assert.deepEqual(blocked.fence, { healthy: true, status: 401 })
  assert.equal(rename.mock.callCount(), 0)
  assert.equal(stderr.mock.callCount(), 1)
  assert.equal(stderr.mock.calls[0].arguments[0],
    'automagik-web: unexpected entry in gate-view: "extra-ada"\n')
  assert.deepEqual(readdirSync(viewDir), ['extra-ada'])
  assert.equal(readFileSync(extra, 'utf8'), 'test-only')
  assert.equal(readFileSync(operatorFile, 'utf8'), launch + '\n')

  rmSync(extra)
  assert.equal((await report()).healthy, true)
  assert.deepEqual(readdirSync(viewDir), ['profile-state.json'])
  assert.equal(rename.mock.calls[0].arguments[1], profileFile)
})

test('gate health checks every time and recovers when the extra entry is removed', async t => {
  const { viewDir, report } = fixture(t)
  assert.equal((await report()).healthy, true)
  assert.equal((await report(gateEnv)).healthy, true)
  const extra = join(viewDir, 'extra')
  writeFileSync(extra, 'test-only')
  const blocked = await report(gateEnv)
  assert.equal(blocked.healthy, false)
  assert.equal(blocked.reason, 'gate-view-tampered')
  assert.equal(blocked.fence.healthy, true)
  assert.ok(!JSON.stringify(blocked).includes(viewDir))
  assert.ok(!JSON.stringify(blocked).includes('test-only'))
  rmSync(extra)
  assert.equal((await report(gateEnv)).healthy, true)
})

test('view reads refuse a symlink substituted after validation', t => {
  const { viewDir, dshHome } = fixture(t)
  const operatorFile = recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  assert.equal(viewProblem(viewDir), null)
  const published = join(viewDir, 'launch-url')
  rmSync(published)
  symlinkSync(operatorFile, published)
  assert.throws(() => readViewFile(published), { code: 'ELOOP' })
})

test('gate listeners share a one-second verdict for requests and upgrades', async t => {
  const { viewDir, dshHome, state } = fixture(t)
  const launch = 'http://ignored.invalid/?token=test'
  recordLaunch(dshHome, viewDir, launch)
  writeProfileState(viewDir, state())
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const sessions = new EventEmitter()
  sessions.authenticate = t.mock.fn()
  const options = {
    origin: 'https://space.invalid', sessions, viewReady: createViewCheck(viewDir, build),
  }
  const gate = createGate(options)
  const bootstrap = createGate({ ...options, bootstrap: true })
  t.after(() => Promise.all([gate.closeGate(), bootstrap.closeGate()]))
  const req = { method: 'GET', url: '/', headers: { host: 'space.invalid' } }
  const request = (listener, url = '/') => new Promise(resolve => {
    let status
    listener.emit('request', { ...req, url }, {
      writeHead: value => { status = value },
      end: body => resolve({ status, body }),
    })
  })
  const socketRequest = (listener, event) => new Promise(resolve => {
    const socket = new EventEmitter()
    socket.destroy = () => socket.emit('close')
    socket.end = (wire, done) => { done(); resolve(wire) }
    listener.emit(event, { ...req, headers: { ...req.headers, origin: options.origin } }, socket)
  })
  const unavailable = { status: 503, body: '{"error":"Gate unavailable"}' }

  assert.equal((await request(gate)).status, 401)
  const extra = join(viewDir, 'extra')
  writeFileSync(extra, 'test-only')
  now = 999
  assert.equal((await request(bootstrap)).status, 401)
  now = 1000
  assert.deepEqual(await request(gate, '/api/omni-mcp'), unavailable)
  assert.equal((await request(bootstrap, '/_gate/claim')).status, 401)
  assert.equal(sessions.authenticate.mock.callCount(), 3)
  for (const event of ['upgrade', 'connect']) {
    const raw = await socketRequest(gate, event)
    assert.match(raw, /^HTTP\/1.1 503 /)
    assert.equal(raw.split('\r\n\r\n')[1], unavailable.body)
  }

  rmSync(extra)
  now = 1999
  assert.deepEqual(await request(gate), unavailable)
  now = 2000
  assert.equal((await request(bootstrap)).status, 401)
  assert.match(await socketRequest(gate, 'upgrade'), /^HTTP\/1.1 401 /)

  rmSync(join(viewDir, 'launch-url'))
  now = 3000
  assert.deepEqual(await request(gate), unavailable)
  recordLaunch(dshHome, viewDir, launch)
  now = 4000
  assert.equal((await request(gate)).status, 401)
})

test('missing view refuses proxy traffic and cached cookies but serves the claim page', async t => {
  const { root, viewDir, dshHome, state } = fixture(t)
  const launchFile = join(viewDir, 'launch-url')
  recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  writeProfileState(viewDir, state())
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const viewReady = createViewCheck(viewDir, build)
  const credentials = new DshCredentials({ launchFile, viewReady })
  const exchange = t.mock.method(credentials, 'request', async () => ({
    statusCode: 303, headers: { 'set-cookie': ['dsh-session=test; HttpOnly'] },
  }))
  assert.equal(await credentials.cookie(), 'dsh-session=test')

  renameSync(viewDir, join(root, 'unmounted'))
  now = 1000
  await assert.rejects(credentials.cookie(), /Gate view unavailable/)
  assert.equal(exchange.mock.callCount(), 1)

  const origin = 'https://space.invalid'
  const sessions = new SessionStore(root)
  const selfHosted = new SelfHostedClaim({ dir: root, origin, sessions })
  await selfHosted.start({ interactive: false })
  const gate = createGate({ origin, sessions, credentials, selfHosted, bootstrap: true, viewReady })
  t.after(() => gate.closeGate())

  const request = url => new Promise(resolve => {
    let status
    const req = { method: 'GET', url, headers: { host: 'space.invalid' } }
    gate.emit('request', req, {
      writeHead: value => { status = value },
      end: body => resolve({ status, body }),
    })
  })
  const page = await request('/_gate/claim')
  assert.equal(page.status, 200)
  assert.match(page.body, /Claim with a passkey/)
  for (const path of ['/', '/api/omni-mcp', '/assets/client.js']) {
    assert.deepEqual(await request(path), { status: 503, body: '{"error":"Gate unavailable"}' })
  }
  for (const event of ['upgrade', 'connect']) {
    const socket = new EventEmitter()
    socket.destroy = () => socket.emit('close')
    const wire = await new Promise(resolve => {
      socket.end = (wire, done) => { done(); resolve(wire) }
      gate.emit(event, { url: '/' }, socket)
    })
    assert.match(wire, /^HTTP\/1.1 503 /)
  }
})

test('a private hard link and a wrong-mode descriptor are refused after validation', t => {
  const { dshHome, viewDir, profileFile, state } = fixture(t)
  const target = recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  const launch = join(viewDir, 'launch-url')
  writeProfileState(viewDir, state())
  assert.equal(viewProblem(viewDir), null)

  rmSync(launch)
  linkSync(target, launch)
  assert.match(viewProblem(viewDir), /must have one link: "launch-url"$/)
  assert.throws(() => readViewFile(launch), /Gate view file unavailable/)
  chmodSync(profileFile, 0o640)
  assert.throws(() => readViewFile(profileFile), /Gate view file unavailable/)
})

test('DSH removes a wrong-mode publication and a symlink without touching its target', async t => {
  const { root, dshHome, viewDir, profileFile, report } = fixture(t)
  const launch = join(viewDir, 'launch-url')
  const target = recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  const bytes = readFileSync(target)
  assert.equal((await report()).healthy, true)
  chmodSync(profileFile, 0o644)
  rmSync(launch)
  symlinkSync(target, launch)
  const extra = join(viewDir, 'extra')
  symlinkSync(root, extra)
  t.mock.method(process.stderr, 'write', () => true)

  assert.equal((await report()).reason, 'gate-view-tampered')
  assert.deepEqual(readdirSync(viewDir), ['extra'])
  assert.deepEqual(readFileSync(target), bytes)
  unlinkSync(extra)
  assert.equal((await report()).healthy, true)
  assert.deepEqual(readdirSync(viewDir), ['profile-state.json'])
})

test('DSH health refuses a replacement directory and stops updating the original', async t => {
  const { root, dshHome, viewDir, report } = fixture(t)
  const mounted = join(root, 'mounted')
  recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  assert.equal((await report()).healthy, true)
  renameSync(viewDir, mounted)
  mkdirSync(viewDir, { mode: 0o700 })
  const stderr = t.mock.method(process.stderr, 'write', () => true)
  const snapshot = join(mounted, 'profile-state.json')
  const original = readFileSync(snapshot)

  const result = await report()
  assert.equal(result.reason, 'gate-view-tampered')
  assert.equal(result.healthy, false)
  assert.equal(result.fence.healthy, true)
  assert.deepEqual(readdirSync(viewDir), [])
  assert.deepEqual(readFileSync(snapshot), original)
  assert.deepEqual(readdirSync(mounted).sort(), ['launch-url', 'profile-state.json'])
  assert.equal(stderr.mock.callCount(), 1)
  assert.match(stderr.mock.calls[0].arguments[0], /gate-view directory identity/)
})

test('private writes stage outside the mount and publish at mode 0600 under any umask', t => {
  const { root, dshHome, viewDir, profileFile, state } = fixture(t)
  const stage = join(root, 'gate-view-staging')
  const identity = join(root, 'gate-view-identity.json')
  assert.equal(statSync(stage).mode & 0o7777, 0o700)
  assert.equal(statSync(identity).mode & 0o7777, 0o600)
  const rename = fs.renameSync
  const stages = []
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.startsWith(viewDir + '/')) {
      assert.equal(statSync(from).mode & 0o7777, 0o600)
      assert.equal(viewProblem(viewDir), null)
      stages.push(from)
    }
    rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const mask = process.umask(0o777)
  try {
    recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
    writeProfileState(viewDir, state())
  } finally {
    process.umask(mask)
  }
  assert.equal(stages.length, 2)
  assert.ok(stages.every(path => path.startsWith(stage + '/')))
  for (const file of [join(dshHome, 'launch-url'), join(viewDir, 'launch-url'), profileFile]) {
    assert.equal(statSync(file).mode & 0o7777, 0o600)
  }
  assert.deepEqual(readdirSync(stage), [])
  assert.deepEqual(readdirSync(viewDir).sort(), ['launch-url', 'profile-state.json'])
})

test('a launch file alone cannot admit traffic and a cached snapshot expires on time', async t => {
  const { dshHome, viewDir, profileFile, state } = fixture(t)
  recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T12:00:00.000Z') })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const sessions = new EventEmitter()
  sessions.authenticate = () => undefined
  const gate = createGate({
    origin: 'https://space.invalid', sessions, viewReady: createViewCheck(viewDir, build),
  })
  t.after(() => gate.closeGate())
  const status = () => new Promise(resolve => {
    let code
    const req = { method: 'GET', url: '/', headers: { host: 'space.invalid' } }
    gate.emit('request', req, { writeHead: value => { code = value }, end: () => resolve(code) })
  })
  assert.equal(await status(), 503)
  writeProfileState(viewDir, state())
  const profile = JSON.parse(readFileSync(profileFile, 'utf8'))
  writeFileSync(profileFile, JSON.stringify({ ...profile, plugins: {} }))
  now = 1000
  assert.equal(await status(), 503)
  writeProfileState(viewDir, state())
  now = 2000
  assert.equal(await status(), 401)
  t.mock.timers.tick(300_001)
  assert.equal(await status(), 503)
  now = 3000
  assert.equal(await status(), 503)
})

const origin = 'https://space.invalid'
const headers = { host: 'space.invalid', origin }
const upgradeHeaders = { ...headers, connection: 'Upgrade', upgrade: 'websocket' }

test('the sweep closes live HTTP streams and WebSockets when the view fails',
  { timeout: 5000 }, async t => {
    const { dshHome, viewDir, state } = fixture(t)
    recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
    writeProfileState(viewDir, state())
    t.mock.timers.enable({ apis: ['setInterval'] })
    let now = 0
    t.mock.method(performance, 'now', () => now)

    // Use real streams for both ends of the proxy, with no network listeners.
    const wire = () => new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        this.emit('sent', chunk.toString())
        done()
      },
    })
    const downstream = wire()
    const upstream = wire()
    const requests = []
    const responses = []
    t.mock.method(http, 'request', (_options, callback) => {
      const proxy = new PassThrough({ autoDestroy: false })
      requests.push(proxy)
      proxy.setTimeout = () => {}
      proxy.once('finish', () => {
        if (callback) {
          const body = new PassThrough()
          body.statusCode = 200
          body.headers = {}
          responses.push(body)
          proxy.once('close', () => body.destroy())
          callback(body)
          body.write('streaming')
        } else {
          proxy.emit('upgrade', { headers: {} }, upstream, Buffer.alloc(0))
        }
      })
      return proxy
    })
    const family = { principal: {} }
    const sessions = new EventEmitter()
    sessions.authenticate = () => family
    sessions.active = sessions.touch = () => true
    const credentials = { port: 3081, authority: '127.0.0.1:3081', cookie: async () => 'dsh=test' }
    const gate = createGate({
      origin, sessions, credentials, viewReady: createViewCheck(viewDir, build),
    })
    t.after(() => gate.closeGate())

    const clients = await Promise.all(['/', '/api/omni-mcp'].map(async url => {
      const req = new PassThrough()
      Object.assign(req, { url, headers, method: 'GET' })
      const res = new PassThrough()
      res.writeHead = code => assert.equal(code, 200)
      const data = once(res, 'data')
      gate.emit('request', req, res)
      req.end()
      assert.equal(String((await data)[0]), 'streaming')
      return res
    }))
    const handshake = once(downstream, 'sent')
    gate.emit('upgrade', { url: '/', headers: upgradeHeaders }, downstream, Buffer.alloc(0))
    assert.match((await handshake)[0], /^HTTP\/1.1 101 /)
    const toDsh = once(upstream, 'sent')
    downstream.push('client frame')
    assert.equal((await toDsh)[0], 'client frame')
    const toClient = once(downstream, 'sent')
    upstream.push('upstream frame')
    assert.equal((await toClient)[0], 'upstream frame')

    const streams = [...requests, ...responses, ...clients, upstream, downstream]
    assert.ok(streams.every(stream => !stream.destroyed))
    const closed = streams.map(stream => once(stream, 'close'))
    writeFileSync(join(viewDir, 'extra'), 'test')
    now = 1000
    t.mock.timers.tick(1000)
    await Promise.all(closed)
    assert.ok(streams.every(stream => stream.destroyed))
  })

test('the gate checks again after authorization or credential acquisition', async t => {
  for (const [phase, path, upgrade] of [
    ['sign-in', '/', false],
    ['cookie', '/', false],
    ['cookie', '/api/omni-mcp', false],
    ['cookie', '/', true],
  ]) {
    await t.test(`${phase} ${upgrade ? 'upgrade' : path}`, async t => {
      const { viewDir, dshHome, state } = fixture(t)
      recordLaunch(dshHome, viewDir, 'http://ignored.invalid/?token=test')
      writeProfileState(viewDir, state())
      const blocked = Promise.withResolvers()
      const started = Promise.withResolvers()
      const wait = () => { started.resolve(); return blocked.promise }
      const family = { principal: {} }
      const sessions = new EventEmitter()
      sessions.active = () => true
      sessions.authenticate = () => phase === 'sign-in' ? undefined : family
      sessions.issue = () => ({ family, secret: 'test' })

      let now = 0
      t.mock.method(performance, 'now', () => now)
      const upstream = t.mock.method(http, 'request', () => { throw new Error('unexpected proxy') })
      const cookie = t.mock.fn(phase === 'cookie' ? wait : async () => 'dsh=test')
      const gate = createGate({
        origin, sessions, credentials: { cookie }, access: { signIn: wait },
        viewReady: createViewCheck(viewDir, build),
      })
      t.after(() => gate.closeGate())
      const req = { method: 'GET', url: path, headers: upgrade ? upgradeHeaders : headers }
      const response = new Promise(resolve => {
        if (upgrade) {
          const socket = new EventEmitter()
          socket.destroy = () => socket.emit('close')
          socket.end = (wire, done) => { done(); resolve(Number(wire.split(' ')[1])) }
          gate.emit('upgrade', req, socket, Buffer.alloc(0))
        } else {
          let status
          gate.emit('request', req, {
            setHeader() {},
            writeHead: value => { status = value },
            end: () => resolve(status),
          })
        }
      })
      await started.promise
      writeFileSync(join(viewDir, 'extra'), 'test')
      now = 1000
      blocked.resolve(phase === 'cookie' ? 'dsh=test' : family.principal)
      assert.equal(await response, 503)
      assert.equal(upstream.mock.callCount(), 0)
      assert.equal(cookie.mock.callCount(), phase === 'cookie' ? 1 : 0)
    })
  }
})
