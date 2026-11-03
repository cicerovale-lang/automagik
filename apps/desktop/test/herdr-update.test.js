import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as nodeFs from 'node:fs'
import { Writable } from 'node:stream'
import { NO_FOCUS } from '../src/herdr.js'
import {
  APP_UPDATE_MS, FEED, OFFLINE, compareVersions, downloadVerified, installFromFeed, installOf, onReleases, openLatest, readFeed,
  targetOf, updateHerdr, versionIn,
} from '../src/herdr-update.js'

const posixOnly = { skip: process.platform === 'win32' ? 'the fake herdr-app is a sh script' : false }
const OLD = '0.1.11'
const NEW = '0.1.12'
const TAR_URL = `https://releases.herdr.dev/app/${NEW}/herdr-app-linux-x86_64.tar.gz`

test('versions: herdr-app\'s --version answer, and semver order', () => {
  assert.equal(versionIn('herdr-app 0.1.12\n'), '0.1.12')
  assert.equal(versionIn('herdr-app v1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(versionIn('herdr-app (dev)'), null)
  assert.ok(compareVersions('0.1.12', '0.1.11') > 0)
  assert.ok(compareVersions('0.1.9', '0.1.10') < 0)
  assert.equal(compareVersions('0.1.12', '0.1.12'), 0)
  assert.ok(compareVersions('0.2.0-rc.1', '0.2.0') < 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0)
  assert.equal(targetOf({ platform: 'darwin', arch: 'arm64' }), 'macos-aarch64')
  assert.equal(targetOf({ platform: 'win32', arch: 'x64' }), 'windows-x86_64')
  assert.equal(targetOf({ platform: 'freebsd', arch: 'x64' }), null)
})

const feedOf = (version, sha256 = 'a'.repeat(64), url = TAR_URL) => ({
  version, core_min: '0.1.11', notes: `Herdr ${version}`, targets: { 'linux-x86_64': { url, sha256 } },
})
const LINUX = { platform: 'linux', arch: 'x64' }

test('the feed: this computer\'s build, unreachable, or read but unusable', async () => {
  const answer = body => async () => Response.json(body)
  assert.deepEqual(await readFeed({ ...LINUX, fetch: answer(feedOf(NEW)) }), { reachable: true, version: NEW, url: TAR_URL, sha256: 'a'.repeat(64) })
  const offline = await readFeed({ ...LINUX, fetch: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(offline, { reachable: false, error: 'fetch failed' })
  assert.equal((await readFeed({ ...LINUX, fetch: async () => new Response('down', { status: 503 }) })).reachable, false)
  assert.equal((await readFeed({ ...LINUX, fetch: async () => new Response('<html>') })).reachable, false)
  const unusable = [
    { ...feedOf(NEW), version: 'latest' },
    feedOf(NEW, 'a'.repeat(64), 'http://releases.herdr.dev/app/x.tar.gz'),
    feedOf(NEW, 'not-a-sha'),
    { ...feedOf(NEW), targets: { 'macos-aarch64': feedOf(NEW).targets['linux-x86_64'] } },
  ]
  for (const body of unusable) {
    const read = await readFeed({ ...LINUX, fetch: answer(body) })
    assert.equal(read.reachable, true)
    assert.ok(read.error, JSON.stringify(body))
  }
  // The feed has its own bound: a fetch that never answers ends with the timeout. (That timer
  // does not hold the event loop open on Node 22: this one does, for the test's sake.)
  const alive = setTimeout(() => {}, 5000)
  const hung = await readFeed({ ...LINUX, timeout: 50, fetch: (_url, { signal }) => new Promise((_ok, no) => signal.addEventListener('abort', () => no(signal.reason))) })
  clearTimeout(alive)
  assert.equal(hung.reachable, false)
})

// A fake herdr-app installed where herdrdev's Linux installer puts it (~/.local/share/herdr-app)
// in a temp home. Its state lives outside the install, so an update keeps it: `window` (open or
// closed: status answers 0 or 2, a start opens it), `ready` (app.update has a download to restart
// into: app.check_updates makes one when `downloads` is on), and `version` (set by app.update).
// Every call is one JSON line in calls.jsonl, with the version of the binary that answered.
function fakeInstall({ window = 'closed', downloads = false, drops = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-up-'))
  const home = join(root, 'home')
  const state = join(root, 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'window'), window)
  if (downloads) writeFileSync(join(state, 'downloads'), '1')
  if (drops) writeFileSync(join(state, 'drops'), '1')
  const binary = (version) => {
    const script = join(state, `herdr-app-${version}.cjs`)
    writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path')
const state = ${JSON.stringify(state)}
const file = name => path.join(state, name)
const has = name => fs.existsSync(file(name))
const args = process.argv.slice(2)
fs.appendFileSync(file('calls.jsonl'), JSON.stringify({ v: ${JSON.stringify(version)}, args }) + '\\n')
if (args[0] === '--version') {
  process.stdout.write('herdr-app ' + (has('version') ? fs.readFileSync(file('version'), 'utf8') : ${JSON.stringify(version)}) + '\\n')
} else if (args.length === 0) {
  fs.writeFileSync(file('window'), 'open')
} else if (args[0] === 'status') {
  const open = fs.readFileSync(file('window'), 'utf8') === 'open'
  if (!open) { process.stderr.write('herdr-app: no Herdr window\\n'); process.exit(2) }
  process.stdout.write('{}\\n')
} else if (args[0] === 'do' && args[1] === 'app.check_updates') {
  if (has('downloads')) fs.writeFileSync(file('ready'), '1')
  process.stdout.write('{}\\n')
} else if (args[0] === 'do' && args[1] === 'app.update') {
  if (!has('ready')) { process.stdout.write('{ "error": "no update downloaded" }\\n'); process.exit(1) }
  fs.writeFileSync(file('version'), ${JSON.stringify(NEW)})
  if (has('drops')) fs.writeFileSync(file('window'), 'closed')
  process.stdout.write('{}\\n')
} else if (args[0] === 'do' && args[1] === 'window.close') {
  fs.writeFileSync(file('window'), 'closed')
  process.stdout.write('{}\\n')
}
`)
    return `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`
  }
  const dir = join(home, '.local', 'share', 'herdr-app')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'herdr-app'), binary(OLD))
  chmodSync(join(dir, 'herdr-app'), 0o755)
  // The feed's build: a real tarball holding herdr-app/herdr-app, as herdrdev ships it.
  const build = join(root, 'build')
  mkdirSync(join(build, 'herdr-app'), { recursive: true })
  writeFileSync(join(build, 'herdr-app', 'herdr-app'), binary(NEW))
  chmodSync(join(build, 'herdr-app', 'herdr-app'), 0o755)
  writeFileSync(join(build, 'herdr-app', 'herdr-app.svg'), '<svg/>')
  execFileSync('tar', ['-czf', join(root, 'app.tar.gz'), '-C', build, 'herdr-app'])
  const tarball = readFileSync(join(root, 'app.tar.gz'))
  const sha256 = createHash('sha256').update(tarball).digest('hex')
  const calls = () => {
    try {
      return readFileSync(join(state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch {
      return []
    }
  }
  const installed = () => execFileSync(join(dir, 'herdr-app'), ['--version'], { encoding: 'utf8' }).trim()
  return { root, home, dir, state, tarball, sha256, calls, installed, window: () => readFileSync(join(state, 'window'), 'utf8') }
}

// The fake feed: what it answers, and every URL asked of it.
function fakeFeed({ feed, tarball, offline = false }) {
  const asked = []
  const fetch = async (url, options) => {
    asked.push(url)
    assert.equal(options?.redirect, 'error', `no redirects for ${url}`)
    if (offline) throw new TypeError('fetch failed')
    if (url === FEED) return Response.json(feed)
    if (url === TAR_URL) return new Response(tarball)
    return new Response('not found', { status: 404 })
  }
  return { fetch, asked }
}

// Virtual time: sleeps return at once and move the clock, so the bounded waits run out fast.
function clock() {
  let offset = 0
  return { now: () => Date.now() + offset, sleep: async ms => { offset += ms } }
}

function host(fake, feed, extra = {}) {
  const logged = []
  const marks = []
  const time = clock()
  return {
    options: { ...LINUX, home: fake.home, env: { PATH: '/usr/bin:/bin' }, fetch: feed.fetch, ...time, log: line => logged.push(line), mark: step => marks.push(step), ...extra },
    logged,
    marks,
  }
}

const started = fake => fake.calls().filter(call => call.args.length === 0)

test('newer in the feed, no answer yet: the offer, and nothing opens', posixOnly, async () => {
  const fake = fakeInstall()
  const feed = fakeFeed({ feed: feedOf(NEW, createHash('sha256').update('x').digest('hex')) })
  const { options, logged } = host(fake, feed)
  const result = await openLatest(options)
  assert.deepEqual(result, { ok: false, reason: 'update', installed: OLD, latest: NEW, message: `Herdr ${NEW} is available` })
  assert.deepEqual(feed.asked, [FEED])
  assert.deepEqual(started(fake), [])
  assert.equal(fake.window(), 'closed')
  assert.deepEqual(logged, [`offer ${OLD} -> ${NEW}`])
})

test('the same version in the feed: opens at once, no offer', posixOnly, async () => {
  const fake = fakeInstall()
  const feed = fakeFeed({ feed: feedOf(OLD) })
  const { options, marks } = host(fake, feed)
  const result = await openLatest(options)
  assert.deepEqual(result, { ok: true, raised: null, message: NO_FOCUS, detail: 'no DISPLAY', version: OLD })
  assert.deepEqual(marks, ['found', 'latest', 'started', 'ready'])
  assert.deepEqual(feed.asked, [FEED])
  assert.equal(started(fake).length, 1)
})

test('the feed unreachable (offline): the installed one opens, with the note', posixOnly, async () => {
  const fake = fakeInstall()
  for (const update of [undefined, true]) {
    const feed = fakeFeed({ offline: true })
    const { options, logged } = host(fake, feed, { update })
    const result = await openLatest(options)
    assert.equal(result.ok, true)
    assert.equal(result.note, OFFLINE)
    assert.equal(result.version, OLD)
    assert.match(logged[0], new RegExp(`^stale ${OLD} offline: fetch failed`))
    assert.equal(fake.installed(), `herdr-app ${OLD}`)
  }
})

test('no: the installed one opens, and the feed is not even read', posixOnly, async () => {
  const fake = fakeInstall()
  const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256) })
  const { options, logged } = host(fake, feed, { update: false, skip: NEW })
  const result = await openLatest(options)
  assert.equal(result.ok, true)
  assert.equal(result.version, OLD)
  assert.deepEqual(feed.asked, [])
  assert.deepEqual(logged, [`declined ${NEW} (installed ${OLD})`, 'no-focus no DISPLAY'])
  assert.equal(fake.installed(), `herdr-app ${OLD}`)
  assert.equal(fake.window(), 'open')
})

test('a version declined in this session is not offered again; a newer one is', posixOnly, async () => {
  const fake = fakeInstall()
  const declined = await openLatest(host(fake, fakeFeed({ feed: feedOf(NEW, fake.sha256) }), { skip: NEW }).options)
  assert.equal(declined.ok, true)
  assert.equal(declined.version, OLD)
  const newer = await openLatest(host(fake, fakeFeed({ feed: feedOf('0.1.13', fake.sha256) }), { skip: NEW }).options)
  assert.equal(newer.reason, 'update')
  assert.equal(newer.latest, '0.1.13')
})

test('yes, with Herdr closed: the feed\'s file, its sha256 checked, installed; it opens on the feed\'s version', posixOnly, async () => {
  const fake = fakeInstall()
  const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256), tarball: fake.tarball })
  const { options, logged, marks } = host(fake, feed, { update: true, offered: NEW })
  const result = await openLatest(options)
  assert.deepEqual(result, { ok: true, raised: null, message: NO_FOCUS, detail: 'no DISPLAY', version: NEW, updated: true })
  assert.deepEqual(feed.asked, [FEED, TAR_URL])
  assert.equal(fake.installed(), `herdr-app ${NEW}`)
  assert.ok(existsSync(join(fake.dir, 'herdr-app.svg')), 'the whole build is in place')
  assert.deepEqual(marks, ['found', 'latest', 'updated', 'started', 'ready'])
  assert.ok(logged.includes(`updated ${OLD} -> ${NEW} (file)`), logged.join('\n'))
  assert.deepEqual(started(fake).map(call => call.v), [NEW], 'the new build is the one started')
  assert.deepEqual(readdirSync(join(fake.home, '.local', 'share')).sort(), ['herdr-app'], 'no staging or .old left')
})

test('yes, but the download\'s sha256 is not the feed\'s: nothing in it runs, the installed one opens', posixOnly, async () => {
  const fake = fakeInstall()
  const before = readFileSync(join(fake.dir, 'herdr-app'))
  const wrong = createHash('sha256').update('something else').digest('hex')
  const feed = fakeFeed({ feed: feedOf(NEW, wrong), tarball: fake.tarball })
  const { options, logged } = host(fake, feed, { update: true, offered: NEW })
  const result = await openLatest(options)
  assert.equal(result.ok, true)
  assert.equal(result.version, OLD)
  assert.match(result.note, new RegExp(`^Herdr couldn't update to ${NEW} \\(the download's sha256 [0-9a-f]{64} is not the feed's ${wrong}\\)`))
  assert.match(logged.at(-2), new RegExp(`^stale ${OLD} the download's sha256`))
  assert.deepEqual(readFileSync(join(fake.dir, 'herdr-app')), before, 'the install is byte for byte as it was')
  assert.equal(fake.calls().some(call => call.v === NEW), false, 'the download never ran')
  assert.deepEqual(readdirSync(join(fake.home, '.local', 'share')), ['herdr-app'])
})

test('yes, with Herdr open: herdr-app\'s own app.update, after app.check_updates, and no download of ours', posixOnly, async () => {
  const fake = fakeInstall({ window: 'open', downloads: true })
  const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256), tarball: fake.tarball })
  const { options, logged } = host(fake, feed, { update: true, offered: NEW })
  const result = await openLatest(options)
  assert.equal(result.ok, true)
  assert.equal(result.version, NEW)
  assert.equal(result.updated, true)
  assert.deepEqual(feed.asked, [FEED])
  assert.ok(logged.includes(`updated ${OLD} -> ${NEW} (app.update)`), logged.join('\n'))
  const asked = fake.calls().filter(call => call.args[0] === 'do').map(call => call.args[1])
  assert.deepEqual(asked, ['app.update', 'app.check_updates', 'app.update'])
  assert.equal(fake.installed(), `herdr-app ${NEW}`)
})

test('yes, with Herdr open but app.update never lands: the feed\'s file, then the window restarts on it', posixOnly, async () => {
  const fake = fakeInstall({ window: 'open', downloads: false })
  const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256), tarball: fake.tarball })
  const { options, logged } = host(fake, feed, { update: true, offered: NEW })
  const t0 = options.now()
  const result = await openLatest(options)
  assert.equal(result.ok, true)
  assert.equal(result.version, NEW)
  assert.equal(result.updated, true)
  assert.ok(options.now() - t0 >= APP_UPDATE_MS, 'app.update was given its full bound')
  assert.ok(logged.includes(`updated ${OLD} -> ${NEW} (file)`), logged.join('\n'))
  const done = fake.calls().filter(call => call.args[0] === 'do').map(call => call.args[1])
  assert.equal(done.at(-1), 'window.close')
  assert.deepEqual(started(fake).map(call => call.v), [NEW])
  assert.equal(fake.installed(), `herdr-app ${NEW}`)
  assert.equal(fake.window(), 'open')
})

test('yes on a Herdr the installer did not put there (PATH, override): the person updates it', posixOnly, async () => {
  assert.equal(installOf({ platform: 'linux', found: { source: 'path', bin: '/usr/bin/herdr-app' } }), null)
  assert.equal(installOf({ platform: 'darwin', found: { source: 'override', bin: '/x/Herdr', app: '/x/Herdr.app' } }), null)
  assert.equal(installOf({ platform: 'linux', found: { source: 'install', bin: '/h/.local/bin/herdr-app' }, resolve: () => '/opt/elsewhere/herdr' }), null)
  assert.deepEqual(installOf({ platform: 'darwin', found: { source: 'install', bin: '/h/Applications/Herdr.app/Contents/MacOS/Herdr', app: '/h/Applications/Herdr.app' } }),
    { root: '/h/Applications/Herdr.app', name: 'Herdr.app', bin: 'Contents/MacOS/Herdr' })
  assert.deepEqual(installOf({ platform: 'win32', found: { source: 'install', bin: 'C:\\U\\AppData\\Local\\Programs\\herdr-app\\herdr-app.exe' }, resolve: file => file }),
    { root: 'C:\\U\\AppData\\Local\\Programs\\herdr-app', name: 'herdr-app', bin: 'herdr-app.exe' })
  const fake = fakeInstall()
  const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256), tarball: fake.tarball })
  const { options } = host(fake, feed, { update: true, offered: NEW, env: { PATH: '/usr/bin:/bin', AUTOMAGIK_HERDR_APP: join(fake.dir, 'herdr-app') } })
  const result = await openLatest(options)
  assert.equal(result.ok, true)
  assert.equal(result.version, OLD)
  assert.match(result.note, /update it yourself/)
  assert.deepEqual(feed.asked, [FEED])
})

test('a download is bounded in size, and its file is gone when its sha256 is wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-dl-'))
  const bytes = Buffer.alloc(4096, 1)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const fetch = async () => new Response(bytes)
  assert.deepEqual(await downloadVerified(TAR_URL, join(dir, 'a'), sha, { fetch }), { size: 4096, sha256: sha })
  await assert.rejects(downloadVerified(TAR_URL, join(dir, 'b'), sha, { fetch, max: 1024 }), /over 1024 bytes/)
  await assert.rejects(downloadVerified(TAR_URL, join(dir, 'c'), 'b'.repeat(64), { fetch }), /is not the feed's/)
  assert.equal(existsSync(join(dir, 'c')), false)
  await assert.rejects(downloadVerified(TAR_URL, join(dir, 'd'), sha, { fetch: async () => new Response('', { status: 404 }) }), /HTTP 404/)
})

// macOS without a Mac: the file system is real (a temp ~/Applications), every program is a fake
// execFile, so the argv herdrdev's installer steps would run is what is checked.
test('macOS: an ad hoc build gets the installer\'s PATH and an ad hoc signature, then lsregister', async () => {
  const home = mkdtempSync(join(tmpdir(), 'herdr-mac-'))
  const app = join(home, 'Applications', 'Herdr.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'Herdr'), 'old')
  const tarball = Buffer.from('a tarball')
  const sha256 = createHash('sha256').update(tarball).digest('hex')
  const ran = []
  const execFile = (file, args, _options, done) => {
    ran.push([file, ...args])
    if (file === '/usr/bin/tar') {
      const stage = args[args.indexOf('-C') + 1]
      mkdirSync(join(stage, 'Herdr.app', 'Contents', 'MacOS'), { recursive: true })
      writeFileSync(join(stage, 'Herdr.app', 'Contents', 'MacOS', 'Herdr'), 'new')
      return done(null, '', '')
    }
    if (file === '/usr/bin/codesign' && args[0] === '-dvv') return done(null, '', 'Executable=…\nSignature=adhoc\n')
    if (file.endsWith('/Contents/MacOS/Herdr') && args[0] === '--version') return done(null, `herdr-app ${NEW}\n`, '')
    done(null, '', '')
  }
  const found = { source: 'install', bin: join(app, 'Contents', 'MacOS', 'Herdr'), app }
  const feed = { version: NEW, url: TAR_URL, sha256 }
  assert.equal(await installFromFeed({ platform: 'darwin', found, feed, home, fetch: async () => new Response(tarball), execFile }), NEW)
  assert.equal(readFileSync(join(app, 'Contents', 'MacOS', 'Herdr'), 'utf8'), 'new')
  const steps = ran.map(([file, ...args]) => [file.split('/').pop(), ...args.map(arg => arg.replace(home, '~').replace(/\.herdr-update-[^/]+/, '<stage>'))])
  assert.deepEqual(steps, [
    ['tar', '-xzf', '~/Applications/<stage>/app.tar.gz', '-C', '~/Applications/<stage>'],
    ['codesign', '-dvv', '~/Applications/<stage>/Herdr.app'],
    ['PlistBuddy', '-c', `Add :LSEnvironment:PATH string ~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, '~/Applications/<stage>/Herdr.app/Contents/Info.plist'],
    ['codesign', '--force', '--sign', '-', '~/Applications/<stage>/Herdr.app'],
    ['Herdr', '--version'],
    ['lsregister', '-f', '~/Applications/Herdr.app'],
  ])
  assert.deepEqual(readdirSync(join(home, 'Applications')), ['Herdr.app'])
  // A Developer ID build is only verified, never changed; a failed check leaves the old app.
  writeFileSync(join(app, 'Contents', 'MacOS', 'Herdr'), 'old')
  ran.length = 0
  const signed = (file, args, options, done) => {
    if (file === '/usr/bin/codesign' && args[0] === '-dvv') return done(null, '', 'Authority=Developer ID Application: Herdr (TEAM)\n')
    if (file === '/usr/bin/codesign' && args[0] === '--verify') { ran.push(['verify']); return done(Object.assign(new Error('x'), { code: 1 }), '', 'a sealed resource is missing') }
    execFile(file, args, options, done)
  }
  await assert.rejects(installFromFeed({ platform: 'darwin', found, feed, home, fetch: async () => new Response(tarball), execFile: signed }), /invalid app signature: a sealed resource is missing/)
  assert.equal(ran.some(([file]) => String(file).endsWith('PlistBuddy')), false)
  assert.equal(readFileSync(join(app, 'Contents', 'MacOS', 'Herdr'), 'utf8'), 'old')
  assert.deepEqual(readdirSync(join(home, 'Applications')), ['Herdr.app'])
})

test('only herdrdev\'s release host: the feed\'s build URL, the download, and no redirects', async () => {
  assert.equal(onReleases(TAR_URL), true)
  for (const url of ['https://evil.example/herdr-app.tar.gz', 'http://releases.herdr.dev/app/x.tar.gz', 'https://releases.herdr.dev.evil.example/x',
    'https://releases.herdr.dev:8443/x', 'https://user@releases.herdr.dev/x', 'not a url']) assert.equal(onReleases(url), false, url)
  const elsewhere = await readFeed({ ...LINUX, fetch: async () => Response.json(feedOf(NEW, 'a'.repeat(64), 'https://evil.example/herdr-app.tar.gz')) })
  assert.equal(elsewhere.reachable, true)
  assert.match(elsewhere.error, /is not on https:\/\/releases\.herdr\.dev/)
  // A feed answered from somewhere else (a redirect the fetch followed anyway) is refused.
  const moved = Object.defineProperty(Response.json(feedOf(NEW)), 'url', { value: 'https://evil.example/latest.json' })
  assert.match((await readFeed({ ...LINUX, fetch: async () => moved })).error, /answered from https:\/\/evil\.example/)
  const dir = mkdtempSync(join(tmpdir(), 'herdr-host-'))
  let asked = 0
  const counting = async () => { asked++; return new Response('x') }
  await assert.rejects(downloadVerified('https://evil.example/a.tar.gz', join(dir, 'a'), 'a'.repeat(64), { fetch: counting }), /is not on/)
  assert.equal(asked, 0, 'nothing is fetched from another host')
  const redirected = async () => Object.defineProperty(new Response('x'), 'url', { value: 'https://evil.example/a.tar.gz' })
  await assert.rejects(downloadVerified(TAR_URL, join(dir, 'b'), 'a'.repeat(64), { fetch: redirected }), /answered from https:\/\/evil\.example/)
  // fetch's own refusal of a redirect ends the download.
  const refused = async (_url, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('fetch failed: unexpected redirect') }
  await assert.rejects(downloadVerified(TAR_URL, join(dir, 'c'), 'a'.repeat(64), { fetch: refused }), /unexpected redirect/)
})

test('yes counts only for a pending offer of the feed\'s version; otherwise it is the offer again', posixOnly, async () => {
  const fake = fakeInstall()
  for (const offered of [undefined, '0.1.10']) {
    const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256), tarball: fake.tarball })
    const { options, logged } = host(fake, feed, { update: true, offered })
    const result = await openLatest(options)
    assert.deepEqual(result, { ok: false, reason: 'update', installed: OLD, latest: NEW, message: `Herdr ${NEW} is available` })
    assert.deepEqual(feed.asked, [FEED], 'nothing downloaded')
    assert.match(logged[0], new RegExp(`^yes to ${offered ?? 'no offer'} while the feed names ${NEW}`))
  }
  assert.deepEqual(started(fake), [])
  assert.equal(fake.installed(), `herdr-app ${OLD}`)
})

test('app.update landed but the window did not come back: no download, the raise starts it', posixOnly, async () => {
  const fake = fakeInstall({ window: 'open', downloads: true, drops: true })
  const feed = fakeFeed({ feed: feedOf(NEW, fake.sha256), tarball: fake.tarball })
  const { options, logged } = host(fake, feed, { update: true, offered: NEW })
  const result = await openLatest(options)
  assert.equal(result.ok, true)
  assert.equal(result.version, NEW)
  assert.deepEqual(feed.asked, [FEED], 'the feed\'s file is not fetched again')
  assert.ok(logged.includes(`updated ${OLD} -> ${NEW} (app.update)`), logged.join('\n'))
  assert.equal(started(fake).length, 1)
  assert.equal(fake.window(), 'open')
})

test('a swap whose second rename fails puts the old install back', posixOnly, async () => {
  const fake = fakeInstall()
  const before = readFileSync(join(fake.dir, 'herdr-app'))
  const fs = { ...nodeFs, renameSync: (from, to) => {
    if (from.includes('.herdr-update-')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
    nodeFs.renameSync(from, to)
  } }
  const feed = { version: NEW, url: TAR_URL, sha256: fake.sha256 }
  const found = { source: 'install', bin: join(fake.dir, 'herdr-app') }
  await assert.rejects(installFromFeed({ platform: 'linux', found, feed, env: { PATH: '/usr/bin:/bin' }, home: fake.home, fetch: fakeFeed({ tarball: fake.tarball }).fetch, fs }), /EBUSY/)
  assert.deepEqual(readFileSync(join(fake.dir, 'herdr-app')), before)
  assert.deepEqual(readdirSync(join(fake.home, '.local', 'share')), ['herdr-app'], 'no .old or staging left')
})

// Windows without Windows: programs and the file system are fakes on one ordered log, and the
// fake file system refuses to rename the app's folder while its window runs, as Windows does.
function fakeWindows({ closes = true } = {}) {
  const root = 'C:\\Users\\u\\AppData\\Local\\Programs\\herdr-app'
  const exe = `${root}\\herdr-app.exe`
  const steps = []
  const files = new Set([exe])
  let window = 'open'
  const answer = (done, code, stdout = '', stderr = '') => done(code ? Object.assign(new Error('exit'), { code }) : null, stdout, stderr)
  const execFile = (file, args, _options, done) => {
    if (file === exe && args[0] === 'status') return answer(done, window === 'open' ? 0 : 2)
    if (file === exe && args[0] === '--version') return answer(done, 0, `herdr-app ${OLD}\n`)
    if (file === exe && args[0] === 'do') {
      steps.push(`do ${args[1]}`)
      if (args[1] === 'app.update') return answer(done, 1, '{ "error": "no update downloaded" }\n')
      if (args[1] === 'window.close' && closes) window = 'closed'
      return answer(done, 0, '{}\n')
    }
    if (file === 'C:\\Windows\\System32\\tar.exe') {
      steps.push('tar')
      files.add(`${args[args.indexOf('-C') + 1]}\\herdr-app\\herdr-app.exe`)
      return answer(done, 0)
    }
    if (file.endsWith('\\herdr-app\\herdr-app.exe') && args[0] === '--version') {
      steps.push('new --version')
      return answer(done, 0, `herdr-app ${NEW}\n`)
    }
    answer(done, 127, '', `unexpected ${file} ${args.join(' ')}`)
  }
  const fs = {
    mkdtempSync: prefix => `${prefix}X`,
    createWriteStream: () => new Writable({ write: (_chunk, _encoding, done) => done() }),
    existsSync: file => files.has(file),
    rmSync: () => {},
    renameSync: (from, to) => {
      if (from === root && window === 'open') throw Object.assign(new Error('EPERM: the folder is in use'), { code: 'EPERM' })
      steps.push(`rename ${from.replace(`${root}`, '<root>')} -> ${to.replace(`${root}`, '<root>')}`)
    },
  }
  const found = { source: 'install', bin: exe }
  return { found, fs, execFile, steps }
}

test('Windows, window open: the new build is ready first, then the window closes, then the swap', async () => {
  const tarball = Buffer.from('a windows build')
  const feed = { version: NEW, url: `https://releases.herdr.dev/app/${NEW}/herdr-app-windows-x86_64.tar.gz`, sha256: createHash('sha256').update(tarball).digest('hex') }
  const run = async (options) => updateHerdr({
    platform: 'win32', feed, env: { SystemRoot: 'C:\\Windows' }, home: 'C:\\Users\\u', resolve: file => file,
    fetch: async () => new Response(tarball), ...clock(), ...options,
  })
  const win = fakeWindows()
  assert.deepEqual(await run(win), { ok: true, via: 'file' })
  const after = win.steps.filter(step => !step.startsWith('do app.'))
  assert.deepEqual(after, [
    'tar', 'new --version', 'do window.close',
    'rename <root> -> <root>.old',
    'rename C:\\Users\\u\\AppData\\Local\\Programs\\.herdr-update-X\\herdr-app -> <root>',
  ])
  // A window that will not close stops the update before anything is renamed.
  const stuck = fakeWindows({ closes: false })
  const result = await run(stuck)
  assert.deepEqual(result, { ok: false, error: 'Herdr\'s window did not close' })
  assert.equal(stuck.steps.some(step => step.startsWith('rename')), false)
})
