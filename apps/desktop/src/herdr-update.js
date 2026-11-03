// Code mode's second step (RFC 0013, delivery 2): Herdr, always latest. On an open, the installed
// `herdr-app --version` is compared with herdrdev's feed for this computer's build. A newer one
// is offered, never installed unasked: the open answers `reason: 'update'` and opens nothing,
// and the page asks again with the person's yes or no. On yes, herdr-app's own `app.update`
// when its window is open; else (or when that does not land) the feed's file, its sha256
// checked before anything in it runs, installed the way herdrdev's installer does. On no, or
// with no network, the installed one opens (offline with a note). The feed is read on an open
// only, never at boot, and every step has its own limit. Like herdr.js, pure apart from what
// it is handed: main.js passes the real fetch, file system and execFile; tests pass fakes.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { findHerdr, raiseHerdr, run, supportedHost, waitOpen } from './herdr.js'

// The feed and the sha256 in it come from this one host, so it is trusted in full (the RFC's
// threat model): the feed is read, and builds downloaded, from it alone, with no redirects.
export const RELEASES = 'https://releases.herdr.dev'
export const FEED = `${RELEASES}/app/latest.json`
export const FEED_MS = 5_000
export const DOWNLOAD_MS = 120_000
export const EXTRACT_MS = 60_000
// app.update restarts into an update Herdr has already downloaded, and nothing says when that
// download is done: after app.check_updates, app.update is asked again until this runs out.
export const APP_UPDATE_MS = 45_000
export const RESTART_MS = 30_000
export const MAX_BYTES = 512 * 1024 * 1024
export const OFFLINE = "Herdr couldn't check for updates (no connection); this is the installed one"

/** True for an https URL on herdrdev's release host and nowhere else (no port, no user). */
export function onReleases(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === RELEASES && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

const nodeFs = { createWriteStream, existsSync, mkdtempSync, renameSync, rmSync }

const pathOf = platform => (platform === 'win32' ? win32 : posix)
const lastLine = text => String(text ?? '').trim().split(/\r?\n/).pop() ?? ''
const defaultSleep = ms => new Promise(done => setTimeout(done, ms))

/** The feed's key for this computer's build: macos-aarch64, linux-x86_64, windows-x86_64… */
export const targetOf = ({ platform, arch }) => {
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform]
  const cpu = { arm64: 'aarch64', x64: 'x86_64' }[arch]
  return os && cpu ? `${os}-${cpu}` : null
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** The version in `herdr-app --version`'s answer ("herdr-app 0.1.12"), or null. */
export function versionIn(text) {
  const word = String(text ?? '').trim().split(/\s+/).find(part => VERSION.test(part.replace(/^v/, '')))
  return word ? word.replace(/^v/, '') : null
}

/** Semver order of two versions: < 0, 0 or > 0. A pre-release comes before its release. */
export function compareVersions(a, b) {
  const [, ...x] = VERSION.exec(a)
  const [, ...y] = VERSION.exec(b)
  for (let i = 0; i < 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i])
  if (x[3] === y[3]) return 0
  if (x[3] === undefined) return 1
  if (y[3] === undefined) return -1
  const p = x[3].split('.')
  const q = y[3].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])]
    if (m && n && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i])
    if (m !== n) return m ? -1 : 1
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  }
  return 0
}

/** The installed herdr-app's version, or null when it does not say. */
export async function installedVersion(bin, { env, execFile } = {}) {
  const answer = await run(bin, ['--version'], { env, execFile })
  return answer.code === 0 ? versionIn(answer.stdout) : null
}

/**
 * herdrdev's feed for this computer: `{ reachable: true, version, url, sha256 }`, or
 * `{ reachable: false, error }` when it could not be read in time (offline), or
 * `{ reachable: true, error }` when it was read and holds no usable build for this target.
 */
export async function readFeed({ platform, arch, fetch = globalThis.fetch, url = FEED, timeout = FEED_MS }) {
  let feed
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'automagik-desktop' }, redirect: 'error', signal: AbortSignal.timeout(timeout) })
    if (!response.ok) return { reachable: false, error: `${url}: HTTP ${response.status}` }
    if (response.url && response.url !== url) return { reachable: true, error: `the feed answered from ${response.url}` }
    feed = JSON.parse(await response.text())
  } catch (error) {
    return { reachable: false, error: error?.message ?? String(error) }
  }
  const target = targetOf({ platform, arch })
  const build = feed?.targets?.[target]
  const version = typeof feed?.version === 'string' ? feed.version : ''
  if (!VERSION.test(version)) return { reachable: true, error: `the feed's version is not one: ${JSON.stringify(feed?.version)}` }
  if (typeof build?.url !== 'string') return { reachable: true, error: `the feed has no ${target} build` }
  if (!onReleases(build.url)) return { reachable: true, error: `the feed's ${target} build is not on ${RELEASES}: ${build.url}` }
  if (typeof build.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(build.sha256)) return { reachable: true, error: `the feed's ${target} build has no sha256` }
  return { reachable: true, version, url: build.url, sha256: build.sha256.toLowerCase() }
}

/**
 * Downloads `url` (on herdrdev's release host only, no redirects) to `file`, hashing it on the
 * way, and refuses it unless its sha256 is `sha256`: nothing in it is unpacked or run before
 * that. Bounded in time and size.
 */
export async function downloadVerified(url, file, sha256, { fetch = globalThis.fetch, timeout = DOWNLOAD_MS, max = MAX_BYTES, fs = nodeFs } = {}) {
  if (!onReleases(url)) throw new Error(`download: ${url} is not on ${RELEASES}`)
  const signal = AbortSignal.timeout(timeout)
  const response = await fetch(url, { headers: { 'user-agent': 'automagik-desktop' }, redirect: 'error', signal })
  if (!response.ok || !response.body) throw new Error(`download: HTTP ${response.status}`)
  if (response.url && !onReleases(response.url)) throw new Error(`download: answered from ${response.url}`)
  const hash = createHash('sha256')
  let size = 0
  const count = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length
      if (size > max) return done(new Error(`download: over ${max} bytes`))
      hash.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), count, fs.createWriteStream(file), { signal })
  const got = hash.digest('hex')
  if (got !== sha256) {
    fs.rmSync(file, { force: true })
    throw new Error(`the download's sha256 ${got} is not the feed's ${sha256}`)
  }
  return { size, sha256: got }
}

/**
 * Where herdrdev's installer put this herdr-app, as `{ root, name, bin }`: the folder (macOS
 * bundle) an update replaces, the name it has in the build's tarball, and the binary inside it.
 * null when this is not that layout (an override or a copy on PATH): then the person updates it.
 */
export function installOf({ platform, found, resolve = realpathOr }) {
  if (found.source !== 'install') return null
  const p = pathOf(platform)
  if (platform === 'darwin') {
    if (!found.app || p.basename(found.app) !== 'Herdr.app') return null
    return { root: found.app, name: 'Herdr.app', bin: p.join('Contents', 'MacOS', 'Herdr') }
  }
  const bin = resolve(found.bin)
  const root = p.dirname(bin)
  const exe = platform === 'win32' ? 'herdr-app.exe' : 'herdr-app'
  if (p.basename(root) !== 'herdr-app' || p.basename(bin) !== exe) return null
  return { root, name: 'herdr-app', bin: exe }
}

function realpathOr(file) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

const tarOf = ({ platform, env }) => {
  if (platform === 'win32') return win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe')
  return platform === 'darwin' ? '/usr/bin/tar' : 'tar'
}

/**
 * macOS, as herdrdev's installer: a Developer ID bundle is only checked, never changed (macOS
 * permissions follow its signing identity); an ad hoc or unsigned one gets the installer's PATH
 * in LSEnvironment and an ad hoc signature.
 */
async function signLikeInstaller(bundle, { env, home, execFile }) {
  const shown = await run('/usr/bin/codesign', ['-dvv', bundle], { env, execFile })
  const text = `${shown.stdout}\n${shown.stderr}`
  if (shown.code === 0 && /^Authority=Developer ID Application:/m.test(text)) {
    const checked = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { env, execFile, timeout: EXTRACT_MS })
    if (checked.code !== 0) throw new Error(`invalid app signature: ${lastLine(checked.stderr)}`)
    return
  }
  const adhoc = shown.code === 0 && /^Signature=adhoc$/m.test(text)
  const unsigned = shown.code !== 0 && /: code object is not signed at all$/m.test(text.trim())
  if (!adhoc && !unsigned) throw new Error(`cannot determine app signature: ${lastLine(text)}`)
  const path = `${posix.join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  const plist = posix.join(bundle, 'Contents', 'Info.plist')
  await run('/usr/libexec/PlistBuddy', ['-c', `Add :LSEnvironment:PATH string ${path}`, plist], { env, execFile })
  const signed = await run('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { env, execFile, timeout: EXTRACT_MS })
  if (signed.code !== 0) throw new Error(`ad hoc signing failed: ${lastLine(signed.stderr)}`)
}

/**
 * The feed's build, installed over herdrdev's own install: downloaded and checked first, then
 * unpacked next to the install (one volume, so the swap is a rename), asked its --version, and
 * swapped in with the old one kept until the new one is in place. `beforeSwap` runs just before
 * the swap (the open window closes there: Windows will not rename a running app's folder); a
 * throw from it stops the update. Resolves to the version now installed; throws with what went
 * wrong, leaving the old install as it was.
 */
export async function installFromFeed({ platform, found, feed, env = {}, home, fetch, execFile, resolve, beforeSwap = async () => {}, fs = nodeFs }) {
  const where = installOf({ platform, found, resolve })
  if (!where) throw new Error('this Herdr was not installed by herdrdev\'s installer; update it yourself')
  const p = pathOf(platform)
  const stage = fs.mkdtempSync(p.join(p.dirname(where.root), '.herdr-update-'))
  try {
    const archive = p.join(stage, 'app.tar.gz')
    await downloadVerified(feed.url, archive, feed.sha256, { fetch, fs })
    const unpacked = await run(tarOf({ platform, env }), ['-xzf', archive, '-C', stage], { env, execFile, timeout: EXTRACT_MS })
    const fresh = p.join(stage, where.name)
    if (unpacked.code !== 0) throw new Error(`unpacking failed: ${lastLine(unpacked.stderr)}`)
    if (!fs.existsSync(p.join(fresh, where.bin))) throw new Error('the download holds no complete app')
    if (platform === 'darwin') await signLikeInstaller(fresh, { env, home, execFile })
    const version = await installedVersion(p.join(fresh, where.bin), { env, execFile })
    if (version !== feed.version) throw new Error(`the download says it is ${version ?? 'no version'}, not ${feed.version}`)
    await beforeSwap()
    const old = `${where.root}.old`
    fs.rmSync(old, { recursive: true, force: true })
    fs.renameSync(where.root, old)
    try {
      fs.renameSync(fresh, where.root)
    } catch (error) {
      fs.renameSync(old, where.root)
      throw error
    }
    try { fs.rmSync(old, { recursive: true, force: true }) } catch {}
    if (platform === 'darwin') {
      const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
      await run(lsregister, ['-f', where.root], { env, execFile })
    }
    return version
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** Asks the open window to close, and waits for it to be gone: true once `status` answers 2. */
async function closeWindow({ platform, found, env, execFile, now, sleep }) {
  await run(found.bin, ['do', platform === 'darwin' ? 'app.quit' : 'window.close'], { env, execFile })
  const start = now()
  for (;;) {
    const status = await run(found.bin, ['status'], { env, execFile })
    if (status.code === 2) return true
    if (now() - start >= RESTART_MS) return false
    await sleep(500)
  }
}

/**
 * Updates the open window through herdr-app's own app.update: asked once, then after
 * app.check_updates until APP_UPDATE_MS runs out; then until --version names the feed's
 * version and the window answers again. true when it landed.
 */
async function appUpdate({ found, feed, env, execFile, now, sleep }) {
  const ask = () => run(found.bin, ['do', 'app.update'], { env, execFile })
  const said = answer => answer.code === 0 && !/"error"/.test(answer.stdout)
  const start = now()
  let asked = await ask()
  if (!said(asked)) {
    await run(found.bin, ['do', 'app.check_updates'], { env, execFile })
    while (!said(asked) && now() - start < APP_UPDATE_MS) {
      await sleep(3000)
      asked = await ask()
    }
  }
  if (!said(asked)) return false
  const landed = now()
  for (;;) {
    const version = await installedVersion(found.bin, { env, execFile })
    if (version && compareVersions(version, feed.version) >= 0) {
      const waited = await waitOpen(found.bin, { env, execFile, now, sleep, limit: RESTART_MS })
      return waited.ready
    }
    if (now() - landed >= RESTART_MS) return false
    await sleep(1000)
  }
}

/**
 * Step 2 on yes. Resolves to `{ ok: true, via }` once the installed herdr-app is the feed's
 * version, else `{ ok: false, error }` with the installed one left as it was.
 */
export async function updateHerdr({ platform, found, feed, env = {}, home, fetch, execFile, resolve, fs, now = Date.now, sleep = defaultSleep, log = () => {} }) {
  const open = (await run(found.bin, ['status'], { env, execFile })).code === 0
  if (open) {
    if (await appUpdate({ found, feed, env, execFile, now, sleep })) return { ok: true, via: 'app.update' }
    // It may have landed after all, with the window slow to come back: then the raise starts it.
    const after = await installedVersion(found.bin, { env, execFile })
    if (after && compareVersions(after, feed.version) >= 0) return { ok: true, via: 'app.update' }
    log('app.update did not land; installing the feed\'s file')
  }
  // The open window runs the old build: it closes once the new one is ready, before the swap,
  // and the raise starts the new one. Windows keeps a running app's folder, so there a window
  // that will not close stops the update; elsewhere the new build waits for a restart.
  let closed = !open
  const beforeSwap = async () => {
    if (!open) return
    closed = await closeWindow({ platform, found, env, execFile, now, sleep })
    if (!closed && platform === 'win32') throw new Error('Herdr\'s window did not close')
  }
  try {
    await installFromFeed({ platform, found, feed, env, home, fetch, execFile, resolve, beforeSwap, fs })
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
  return closed ? { ok: true, via: 'file' } : { ok: true, via: 'file', restart: true }
}

/**
 * Code mode's open with step 2 (RFC 0013): find, latest, then start or raise. `update` is the
 * person's answer to an offer: undefined (no answer yet), true or false. A yes counts only for
 * `offered`, the version this session last offered, and only while the feed still names it:
 * any other yes gets the offer instead. `skip` is a version the person already declined in this
 * session: it is not offered again. Resolves to openHerdr's
 * answers, with `note` when the update did not happen, or to `{ ok: false, reason: 'update',
 * installed, latest, message }` when a newer Herdr waits for the person's answer.
 */
export async function openLatest({ update, offered, skip, platform, arch, env = {}, home, fetch, isFile, resolve, fs, execFile, spawn, now = Date.now, sleep = defaultSleep, limit, mark = () => {}, log = () => {} } = {}) {
  if (!supportedHost({ platform, arch })) {
    log('unsupported-host')
    return { ok: false, reason: 'unsupported', message: 'Herdr has no build for this computer' }
  }
  const found = findHerdr({ platform, env, home, isFile, resolve })
  if (!found) {
    log('missing')
    return { ok: false, reason: 'missing', message: 'Herdr is not set up' }
  }
  mark('found')
  const raise = extra => raiseHerdr({ platform, found, env, execFile, spawn, now, sleep, limit, mark, log }).then(opened => ({ ...opened, ...extra }))
  const installed = await installedVersion(found.bin, { env, execFile })
  if (update === false) {
    log(`declined ${skip ?? 'an update'} (installed ${installed ?? 'unknown'})`)
    return raise({ version: installed })
  }
  if (!installed) {
    log('latest unknown: herdr-app --version gave no version')
    return raise({ version: null })
  }
  const feed = await readFeed({ platform, arch, fetch })
  if (!feed.reachable) {
    log(`stale ${installed} offline: ${feed.error}`)
    return raise({ version: installed, note: OFFLINE })
  }
  if (feed.error) {
    log(`stale ${installed} feed: ${feed.error}`)
    return raise({ version: installed, note: `Herdr couldn't check for updates (${feed.error}); this is the installed one` })
  }
  mark('latest')
  if (compareVersions(feed.version, installed) <= 0) return raise({ version: installed })
  const yes = update === true && offered === feed.version
  if (update === true && !yes) log(`yes to ${offered ?? 'no offer'} while the feed names ${feed.version}: offered again`)
  if (!yes) {
    if (skip === feed.version) {
      log(`declined ${feed.version}`)
      return raise({ version: installed })
    }
    log(`offer ${installed} -> ${feed.version}`)
    return { ok: false, reason: 'update', installed, latest: feed.version, message: `Herdr ${feed.version} is available` }
  }
  const updated = await updateHerdr({ platform, found, feed, env, home, fetch, execFile, resolve, fs, now, sleep, log })
  if (!updated.ok) {
    log(`stale ${installed} ${updated.error}`)
    return raise({ version: installed, note: `Herdr couldn't update to ${feed.version} (${updated.error}); this is the installed ${installed}` })
  }
  mark('updated')
  log(`updated ${installed} -> ${feed.version} (${updated.via})`)
  if (updated.restart) return raise({ version: feed.version, note: `Herdr ${feed.version} is installed; it starts when Herdr restarts` })
  return raise({ version: feed.version, updated: true })
}
