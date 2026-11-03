import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BUNDLE_ID, GRACE_MS, NO_FOCUS, NOT_OPENED, OVERRIDE, findHerdr, herdrStatus, launchOf, openHerdr, supportedHost, waitOpen } from '../src/herdr.js'

// A fake file system: the files that exist, and the links that resolve elsewhere.
const fakeFs = (files, links = {}) => ({
  isFile: file => files.includes(file),
  resolve: file => links[file] ?? file,
})

const MAC_HOME = '/Users/ana'
const MAC_APP = '/Applications/Herdr.app/Contents/MacOS/Herdr'
const MAC_USER_APP = `${MAC_HOME}/Applications/Herdr.app/Contents/MacOS/Herdr`

test('macOS: the installer\'s ~/Applications first, then /Applications, as the bundle LaunchServices opens', () => {
  const both = fakeFs([MAC_APP, MAC_USER_APP])
  assert.deepEqual(findHerdr({ platform: 'darwin', home: MAC_HOME, env: {}, ...both }), { bin: MAC_USER_APP, app: `${MAC_HOME}/Applications/Herdr.app`, source: 'install' })
  const dragged = fakeFs([MAC_APP])
  assert.deepEqual(findHerdr({ platform: 'darwin', home: MAC_HOME, env: {}, ...dragged }), { bin: MAC_APP, app: '/Applications/Herdr.app', source: 'install' })
})

test('macOS: the herdr-app link in ~/.local/bin leads back to its bundle; a bare binary on PATH has none', () => {
  const link = `${MAC_HOME}/.local/bin/herdr-app`
  const linked = fakeFs([link], { [link]: '/Volumes/X/Herdr.app/Contents/MacOS/Herdr' })
  assert.deepEqual(findHerdr({ platform: 'darwin', home: MAC_HOME, env: {}, ...linked }), { bin: link, app: '/Volumes/X/Herdr.app', source: 'install' })
  const bare = fakeFs(['/opt/herdr/bin/herdr-app'])
  assert.deepEqual(findHerdr({ platform: 'darwin', home: MAC_HOME, env: { PATH: '/usr/bin:/opt/herdr/bin' }, ...bare }), { bin: '/opt/herdr/bin/herdr-app', app: null, source: 'path' })
})

test('Linux: ~/.local/share/herdr-app (or XDG_DATA_HOME\'s), then ~/.local/bin, then PATH', () => {
  const home = '/home/ana'
  const fs = fakeFs([`${home}/.local/share/herdr-app/herdr-app`, `${home}/.local/bin/herdr-app`, '/usr/bin/herdr-app'])
  assert.deepEqual(findHerdr({ platform: 'linux', home, env: { PATH: '/usr/bin' }, ...fs }), { bin: `${home}/.local/share/herdr-app/herdr-app`, app: null, source: 'install' })
  const xdg = fakeFs(['/data/herdr-app/herdr-app'])
  assert.equal(findHerdr({ platform: 'linux', home, env: { XDG_DATA_HOME: '/data' }, ...xdg }).bin, '/data/herdr-app/herdr-app')
  assert.equal(findHerdr({ platform: 'linux', home, env: { XDG_DATA_HOME: 'relative' }, ...xdg }), null)
  const bin = fakeFs([`${home}/.local/bin/herdr-app`])
  assert.equal(findHerdr({ platform: 'linux', home, env: {}, ...bin }).bin, `${home}/.local/bin/herdr-app`)
  const path = fakeFs(['/usr/bin/herdr-app'])
  assert.deepEqual(findHerdr({ platform: 'linux', home, env: { PATH: 'relative:/usr/bin' }, ...path }), { bin: '/usr/bin/herdr-app', app: null, source: 'path' })
  assert.equal(findHerdr({ platform: 'linux', home, env: { PATH: '/usr/bin' }, ...fakeFs([]) }), null)
})

test('Windows: %LOCALAPPDATA%\\Programs\\herdr-app, then herdr-app.exe on Path', () => {
  const home = 'C:\\Users\\ana'
  const local = 'C:\\Users\\ana\\AppData\\Local'
  const installed = `${local}\\Programs\\herdr-app\\herdr-app.exe`
  assert.deepEqual(findHerdr({ platform: 'win32', home, env: { LOCALAPPDATA: local, Path: 'D:\\tools' }, ...fakeFs([installed, 'D:\\tools\\herdr-app.exe']) }), { bin: installed, app: null, source: 'install' })
  assert.deepEqual(findHerdr({ platform: 'win32', home, env: { LOCALAPPDATA: local, Path: 'C:\\Windows;D:\\tools' }, ...fakeFs(['D:\\tools\\herdr-app.exe']) }), { bin: 'D:\\tools\\herdr-app.exe', app: null, source: 'path' })
  assert.equal(findHerdr({ platform: 'win32', home, env: { LOCALAPPDATA: local, Path: 'D:\\tools' }, ...fakeFs(['D:\\tools\\herdr-app']) }), null)
})

test(`${OVERRIDE} wins, and one that names nothing means not set up, never an installed copy`, () => {
  const fs = fakeFs([MAC_APP, '/tmp/fake/herdr-app'])
  assert.deepEqual(findHerdr({ platform: 'darwin', home: MAC_HOME, env: { [OVERRIDE]: '/tmp/fake/herdr-app' }, ...fs }), { bin: '/tmp/fake/herdr-app', app: null, source: 'override' })
  assert.deepEqual(findHerdr({ platform: 'darwin', home: MAC_HOME, env: { [OVERRIDE]: '/Applications/Herdr.app' }, ...fs }), { bin: MAC_APP, app: '/Applications/Herdr.app', source: 'override' })
  assert.equal(findHerdr({ platform: 'darwin', home: MAC_HOME, env: { [OVERRIDE]: '/nowhere/herdr-app' }, ...fs }), null)
  assert.equal(findHerdr({ platform: 'darwin', home: MAC_HOME, env: { [OVERRIDE]: 'herdr-app' }, ...fs }), null)
  assert.equal(findHerdr({ platform: 'darwin', home: MAC_HOME, env: { [OVERRIDE]: '' }, ...fs }).source, 'install')
})

test('only the hosts herdrdev builds for: macOS arm64, Linux x64 and arm64, Windows x64', () => {
  assert.equal(supportedHost({ platform: 'darwin', arch: 'arm64' }), true)
  assert.equal(supportedHost({ platform: 'darwin', arch: 'x64' }), false)
  assert.equal(supportedHost({ platform: 'linux', arch: 'x64' }), true)
  assert.equal(supportedHost({ platform: 'linux', arch: 'arm64' }), true)
  assert.equal(supportedHost({ platform: 'win32', arch: 'x64' }), true)
  assert.equal(supportedHost({ platform: 'win32', arch: 'arm64' }), false)
})

test('macOS starts or raises through LaunchServices; Linux and Windows run the bare binary, detached', () => {
  const mac = { bin: MAC_APP, app: '/Applications/Herdr.app', source: 'install' }
  assert.deepEqual(launchOf({ platform: 'darwin', found: mac, env: {} }), { file: '/usr/bin/open', args: ['-a', '/Applications/Herdr.app'], detached: false })
  assert.deepEqual(launchOf({ platform: 'darwin', found: mac, env: { HERDR_APP_HOME: '/tmp/h' } }).args, ['--env', 'HERDR_APP_HOME=/tmp/h', '-a', '/Applications/Herdr.app'])
  assert.deepEqual(launchOf({ platform: 'linux', found: { bin: '/x/herdr-app', app: null }, env: {} }), { file: '/x/herdr-app', args: [], detached: true })
  assert.deepEqual(launchOf({ platform: 'win32', found: { bin: 'C:\\x\\herdr-app.exe', app: null }, env: {} }), { file: 'C:\\x\\herdr-app.exe', args: [], detached: true })
})

// A fake herdr-app on PATH: it records its argv, one JSON line a call, and answers `status`
// with the exit codes it is given, in turn (the last one repeats).
function fakeHerdr(statusCodes) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-fake-'))
  const calls = join(dir, 'calls.jsonl')
  writeFileSync(join(dir, 'codes.json'), JSON.stringify(statusCodes))
  const bin = join(dir, 'bin')
  writeFileSync(join(dir, 'count'), '0')
  const script = join(dir, 'herdr-app.cjs')
  writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path')
const dir = ${JSON.stringify(dir)}
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')
if (args[0] !== 'status') process.exit(0)
const codes = JSON.parse(fs.readFileSync(path.join(dir, 'codes.json'), 'utf8'))
const n = Number(fs.readFileSync(path.join(dir, 'count'), 'utf8'))
fs.writeFileSync(path.join(dir, 'count'), String(n + 1))
const code = codes[Math.min(n, codes.length - 1)]
if (code === 2) process.stderr.write('herdr-app: no Herdr window at ' + dir + '/herdr-app.sock\\n')
if (code === 1) process.stderr.write('herdr-app: something broke\\n')
if (code === 0) process.stdout.write('{"spaces":1}\\n')
process.exit(code)
`)
  mkdirSync(bin)
  const exe = join(bin, 'herdr-app')
  writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(exe, 0o755)
  const read = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { dir, bin, exe, calls: () => { try { return read() } catch { return [] } } }
}

const posixOnly = { skip: process.platform === 'win32' ? 'the fake herdr-app is a sh script' : false }
const LINUX = { platform: 'linux', arch: 'x64', home: '/nonexistent-home' }
const instant = () => Promise.resolve()

test('status: missing, closed (exit 2), open (exit 0), or herdr-app\'s own error', posixOnly, async () => {
  assert.deepEqual(await herdrStatus({ ...LINUX, env: { PATH: '/nonexistent' } }), { state: 'missing' })
  assert.deepEqual(await herdrStatus({ platform: 'darwin', arch: 'x64', home: '/x', env: {} }), { state: 'unsupported' })
  const closed = fakeHerdr([2])
  assert.deepEqual(await herdrStatus({ ...LINUX, env: { PATH: closed.bin } }), { state: 'closed', source: 'path' })
  const open = fakeHerdr([0])
  assert.deepEqual(await herdrStatus({ ...LINUX, env: { PATH: open.bin } }), { state: 'open', source: 'path' })
  assert.deepEqual(open.calls(), [['status']])
  const broken = fakeHerdr([1])
  assert.deepEqual(await herdrStatus({ ...LINUX, env: { [OVERRIDE]: broken.exe } }), { state: 'error', source: 'override', message: 'herdr-app: something broke' })
})

test('open starts the bare binary, waits through exit 2 until status answers 0, and says when focus is unknown', posixOnly, async () => {
  const fake = fakeHerdr([2, 2, 0])
  const marks = []
  const result = await openHerdr({ ...LINUX, env: { PATH: fake.bin }, sleep: instant, mark: step => marks.push(step) })
  assert.deepEqual(result, { ok: true, raised: null, message: NO_FOCUS, detail: 'no DISPLAY' })
  assert.deepEqual(marks, ['found', 'started', 'ready'])
  const calls = fake.calls()
  assert.equal(calls.filter(args => args.length === 0).length, 1, 'one start, with no arguments')
  assert.deepEqual(calls.filter(args => args.length > 0), [['status'], ['status'], ['status']])
})

test('open gives up after 10 s of exit 2 with herdr-app\'s last line, and reports a missing herdr-app', posixOnly, async () => {
  const fake = fakeHerdr([2])
  let clock = 0
  const now = () => (clock += 1500)
  const logged = []
  const result = await openHerdr({ ...LINUX, env: { PATH: fake.bin }, sleep: instant, now, log: line => logged.push(line) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.message, NOT_OPENED)
  assert.match(result.detail, /^herdr-app: no Herdr window at /)
  assert.match(logged.at(-1), /^timeout herdr-app: no Herdr window/)
  assert.ok(fake.calls().filter(args => args[0] === 'status').length <= 8)
  assert.deepEqual(await openHerdr({ ...LINUX, env: { [OVERRIDE]: '/nowhere' } }), { ok: false, reason: 'missing', message: 'Herdr is not set up' })
})

// Virtual time: sleeps return at once and move the clock.
function clock() {
  let offset = 0
  return { now: () => Date.now() + offset, sleep: async ms => { offset += ms } }
}

test('a brief exit 1 right after a start is borne for the grace; then status answering 0 opens', posixOnly, async () => {
  const fake = fakeHerdr([2, 1, 1, 0])
  const waited = await waitOpen(fake.exe, { env: {}, ...clock() })
  assert.equal(waited.ready, true)
  assert.deepEqual(fake.calls(), [['status'], ['status'], ['status'], ['status']])
})

test('an exit 1 that lasts past the grace stops the wait with herdr-app\'s own error', posixOnly, async () => {
  const fake = fakeHerdr([2, 1])
  const waited = await waitOpen(fake.exe, { env: {}, ...clock() })
  assert.equal(waited.ready, false)
  assert.equal(waited.failed, true)
  assert.equal(waited.code, 1)
  assert.equal(waited.stderr, 'herdr-app: something broke')
  assert.ok(waited.ms >= GRACE_MS && waited.ms < GRACE_MS + 500, `stopped at ${waited.ms} ms`)
  const again = fakeHerdr([1])
  const logged = []
  const result = await openHerdr({ ...LINUX, env: { PATH: again.bin }, ...clock(), log: line => logged.push(line) })
  assert.deepEqual(result, { ok: false, reason: 'error', message: 'herdr-app: something broke', detail: 'herdr-app: something broke' })
  assert.deepEqual(logged, ['status-error herdr-app: something broke'])
  const asked = again.calls().filter(args => args[0] === 'status').length
  assert.ok(asked > 1 && asked <= GRACE_MS / 250 + 2, `${asked} status calls`)
})

test('waitOpen stops as soon as status answers 0', posixOnly, async () => {
  const fake = fakeHerdr([0])
  const waited = await waitOpen(fake.exe, { env: {}, sleep: instant })
  assert.equal(waited.ready, true)
  assert.deepEqual(fake.calls(), [['status']])
})

// macOS without a Mac: execFile is faked, so the argv the app would run is what is checked.
test('macOS: open -a the bundle, wait, then ask LaunchServices which app is in front', async () => {
  const ran = []
  let statuses = [2, 0]
  let front = 'com.apple.finder'
  const execFile = (file, args, _options, done) => {
    ran.push([file, ...args])
    if (file === '/usr/bin/open') return done(null, '', '')
    if (file === MAC_APP && args[0] === 'status') {
      const code = statuses.shift() ?? 0
      return done(code ? Object.assign(new Error('exit'), { code }) : null, '', code ? 'no Herdr window' : '')
    }
    if (args[0] === 'front') return done(null, 'ASN:0x0-0x1d01d:\n', '')
    if (args[0] === 'info') {
      const answer = `"CFBundleIdentifier"="${front}"\n`
      front = BUNDLE_ID
      return done(null, answer, '')
    }
    done(Object.assign(new Error('unexpected'), { code: 127 }), '', 'unexpected')
  }
  const mac = { platform: 'darwin', arch: 'arm64', home: MAC_HOME, env: { HERDR_APP_HOME: '/tmp/h' }, ...fakeFs([MAC_APP]), execFile, sleep: instant }
  assert.deepEqual(await openHerdr(mac), { ok: true, raised: true })
  assert.deepEqual(ran[0], ['/usr/bin/open', '--env', 'HERDR_APP_HOME=/tmp/h', '-a', '/Applications/Herdr.app'])
  assert.deepEqual(ran.slice(1, 3), [[MAC_APP, 'status'], [MAC_APP, 'status']])
  assert.deepEqual(ran.slice(3).map(call => call[1]), ['front', 'info', 'front', 'info'])
  // Something else stays in front: Herdr is open, with the no-focus message.
  statuses = [0]
  front = 'com.apple.finder'
  const stuck = (file, args, options, done) => (args[0] === 'info' ? done(null, '"CFBundleIdentifier"="com.apple.finder"\n', '') : execFile(file, args, options, done))
  assert.deepEqual(await openHerdr({ ...mac, execFile: stuck }), { ok: true, raised: false, message: NO_FOCUS, detail: 'com.apple.finder' })
})
