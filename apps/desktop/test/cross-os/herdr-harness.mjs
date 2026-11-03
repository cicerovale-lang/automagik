// RFC 0013 deliveries 1 and 2 on a real OS (.github/workflows/herdr-harness.yml, CI runners
// only: it installs herdr-app and drives its window). It checks herdrdev's feed and the sha256
// of this OS's build, installs herdr-app with herdrdev's own installer, then runs the app's own
// finder and start-or-raise (src/herdr.js) on a temp HERDR_APP_HOME: status, ls, do space.new,
// and a raise from behind another window. Then delivery 2 (src/herdr-update.js): herdrdev's
// installer puts back an older build (from a local copy of the feed naming it), and the open
// is driven through offline, the offer, no, and yes with the window open and closed; yes must
// end on the feed's version. Each check is one JSON line in $OUT/results.jsonl; the table goes
// to $GITHUB_STEP_SUMMARY. It exits 1 when a check a delivery needs fails.
//
//   node test/cross-os/herdr-harness.mjs        (Linux: under xvfb-run, with a window manager)
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { OVERRIDE, findHerdr, frontmost, openHerdr, run } from '../../src/herdr.js'
import { OFFLINE, compareVersions, installedVersion, openLatest, readFeed } from '../../src/herdr-update.js'

const FEED = 'https://releases.herdr.dev/app/latest.json'
const platform = process.platform
const OS = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform]
const ARCH = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
const target = `${OS}-${ARCH}`
const out = process.env.OUT || mkdtempSync(join(tmpdir(), 'herdr-harness-'))
mkdirSync(out, { recursive: true })
const results = join(out, 'results.jsonl')
const rows = []
let failed = false

const clip = (text, max = 1500) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value
}
/** One check: `ok` true, false, or null (informational). A false `needed` check fails the run. */
function record(check, ok, detail, { needed = true, value } = {}) {
  const line = { os: OS, target, check, ok, needed, detail: clip(detail), ...(value === undefined ? {} : { value }) }
  appendFileSync(results, `${JSON.stringify(line)}\n`)
  rows.push(line)
  if (ok === false && needed) failed = true
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'} ${check}: ${clip(detail, 400)}`)
}
const shown = result => `exit ${result.code}${result.stdout.trim() ? `\nstdout: ${result.stdout.trim()}` : ''}${result.stderr.trim() ? `\nstderr: ${result.stderr.trim()}` : ''}`
const sleep = ms => new Promise(done => setTimeout(done, ms))

// The socket lives in HERDR_APP_HOME, and a Unix socket path must stay short (SUN_LEN).
const appHome = platform === 'win32' ? join(tmpdir(), `hh${randomBytes(3).toString('hex')}`) : `/tmp/hh${randomBytes(3).toString('hex')}`
mkdirSync(appHome, { recursive: true })
const { [OVERRIDE]: _override, ...base } = process.env
const env = { ...base, HERDR_APP_HOME: appHome }
const host = { platform, arch: process.arch, env, home: homedir() }

async function feed() {
  const manifest = await fetch(FEED).then(response => response.json())
  const build = manifest.targets?.[target]
  if (!build?.url) return record('feed', false, `${FEED} has no ${target} build: ${JSON.stringify(manifest)}`)
  const bytes = Buffer.from(await fetch(build.url).then(response => response.arrayBuffer()))
  const sha = createHash('sha256').update(bytes).digest('hex')
  record('feed sha256', sha === build.sha256, `${manifest.version} ${build.url}: ${bytes.length} bytes, sha256 ${sha}${sha === build.sha256 ? ' matches' : ` != feed ${build.sha256}`}`, { value: manifest.version })
}

// herdrdev's installer, as published; `releases` points it at another feed (it reads
// HERDR_RELEASES_URL), as delivery 2's older build does.
function install({ check = 'install (herdrdev installer)', releases } = {}) {
  return new Promise(done => {
    const [file, args] = platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://releases.herdr.dev/app/install.ps1 | iex']]
      : ['sh', ['-c', 'curl -fsSL https://releases.herdr.dev/app/install.sh | sh']]
    const installEnv = releases ? { ...base, HERDR_RELEASES_URL: releases } : base
    execFile(file, args, { env: installEnv, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      record(check, !error, `${error ? `failed: ${error.message}\n` : ''}${stdout}${stderr}`)
      done(!error)
    })
  })
}

// When the window does not come up, the app's own output says why: run it attached for a while.
function attachedRun(bin, ms) {
  return new Promise(done => {
    let text = ''
    const child = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { text += chunk })
    child.stderr.on('data', chunk => { text += chunk })
    child.on('error', error => { text += `\nspawn error: ${error.message}` })
    const timer = setTimeout(() => { child.kill(); done(`still running after ${ms} ms\n${text}`) }, ms)
    child.on('exit', (code, signal) => { clearTimeout(timer); done(`exited ${code ?? signal}\n${text}`) })
  })
}

// Something else in front, so the second open is a raise, not a start.
async function somethingElseInFront() {
  if (platform === 'darwin') return run('/usr/bin/open', ['-a', 'Finder'], { env })
  const file = platform === 'win32' ? 'notepad.exe' : 'xterm'
  const child = spawn(file, [], { env, detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  await sleep(2500)
  return { code: 0, stdout: '', stderr: '' }
}

async function main() {
  record('runner', null, `${process.platform} ${process.arch} node ${process.version}; HERDR_APP_HOME=${appHome}; DISPLAY=${process.env.DISPLAY ?? ''}`, { needed: false })
  await feed().catch(error => record('feed sha256', false, error.stack))
  await install()

  const found = findHerdr(host)
  record('find', found !== null, found ? `${found.bin} (${found.source}${found.app ? `, bundle ${found.app}` : ''})` : 'herdr-app not found after the install')
  if (!found) return
  record('find without PATH', findHerdr({ ...host, env: { ...env, PATH: '', Path: '' } }) !== null, 'the install paths alone, as for an app started from Finder or the Start menu')
  const version = await run(found.bin, ['--version'], { env })
  record('--version', version.code === 0, shown(version))

  const before = await run(found.bin, ['status'], { env })
  record('status before start (exit 2)', before.code === 2, shown(before))

  const marks = []
  const t0 = Date.now()
  const logs = []
  const opened = await openHerdr({ ...host, mark: step => marks.push(`${step} +${Date.now() - t0} ms`), log: line => logs.push(line) })
  record('start and wait', opened.ok, `${JSON.stringify(opened)}\nsteps: ${marks.join(', ')}${logs.length ? `\nlog: ${logs.join(' | ')}` : ''}`)
  if (!opened.ok) {
    record('app output (attached run, 20 s)', null, await attachedRun(found.bin, 20_000), { needed: false })
    const after = await run(found.bin, ['status'], { env })
    record('status after the attached run', after.code === 0, shown(after), { needed: false })
    return
  }
  record('first open: raised or the no-focus message', opened.raised === true || opened.message !== undefined, opened.raised === true ? 'raised' : `${opened.message} (front: ${opened.detail})`, { value: opened.raised })

  const status = await run(found.bin, ['status'], { env })
  record('status (exit 0)', status.code === 0, shown(status))
  const ls = await run(found.bin, ['ls'], { env })
  let lsOk = ls.code === 0
  try { JSON.parse(ls.stdout) } catch { lsOk = false }
  record('ls (JSON)', lsOk, shown(ls))
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'hs')))
  const made = await run(found.bin, ['do', 'space.new', '--name', 'harness', '--folder', folder], { env })
  let madeOk = made.code === 0 && !/"error"/.test(made.stdout)
  record('do space.new', madeOk, shown(made))
  const again = await run(found.bin, ['ls'], { env })
  madeOk = again.code === 0 && again.stdout.includes(JSON.stringify(folder).slice(1, -1))
  record('ls shows the new space\'s folder', madeOk, shown(again))

  const other = await somethingElseInFront()
  const behind = await frontmost({ platform, env })
  record('another window in front', null, `${shown(other)}\nfront: ${JSON.stringify(behind)}`, { needed: false })
  const raised = await openHerdr({ ...host, log: line => logs.push(line) })
  record('second open from behind: raised or the no-focus message', raised.ok && (raised.raised === true || raised.message !== undefined), raised.raised === true ? 'raised' : JSON.stringify(raised), { value: raised.raised })

  const shot = await run(found.bin, ['shot', join(out, `herdr-${OS}.png`)], { env })
  record('shot', null, shown(shot), { needed: false })
}

// Delivery 2. herdrdev keeps older builds at their versioned URLs
// (releases.herdr.dev/app/<version>/herdr-app-<target>.tar.gz) but publishes a sha256 only for
// the latest, in latest.json. So the older build's feed is a local copy: the real versioned URL,
// and a sha256 this run computes from the download (trust on first use, CI only). herdrdev's
// installer reads it through HERDR_RELEASES_URL; anything else it asks of that address goes on
// to releases.herdr.dev.
async function olderBuild(latest) {
  const [major, minor, patch] = latest.split(/[.-]/).map(Number)
  for (let back = 1; back <= Math.min(patch, 3); back++) {
    const version = `${major}.${minor}.${patch - back}`
    const url = `https://releases.herdr.dev/app/${version}/herdr-app-${target}.tar.gz`
    const response = await fetch(url).catch(() => null)
    if (!response?.ok) continue
    const bytes = Buffer.from(await response.arrayBuffer())
    return { version, url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  }
  return null
}

function feedServer(older) {
  const manifest = JSON.stringify({ version: older.version, notes: `harness: ${older.version}`, targets: { [target]: { url: older.url, sha256: older.sha256 } } }, null, 2)
  const server = createServer((request, response) => {
    if (request.url.split('?')[0] === '/app/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(manifest)
    }
    response.writeHead(302, { location: `https://releases.herdr.dev${request.url}` })
    response.end()
  })
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, releases: `http://127.0.0.1:${server.address().port}` })))
}

// The window closed (its terminals live on in herdr-core): herdr-app's own command, else the
// process ended. CI only, on the harness's own HERDR_APP_HOME.
async function closeHerdr(bin) {
  const closed = async () => {
    for (let i = 0; i < 40; i++) {
      if ((await run(bin, ['status'], { env })).code === 2) return true
      await sleep(250)
    }
    return false
  }
  const asked = await run(bin, ['do', platform === 'darwin' ? 'app.quit' : 'window.close'], { env })
  if (await closed()) return `closed (${shown(asked)})`
  try {
    if (platform === 'win32') execFileSync('taskkill', ['/F', '/IM', 'herdr-app.exe'])
    else execFileSync('pkill', ['-f', platform === 'darwin' ? 'Herdr.app/Contents/MacOS/Herdr' : 'herdr-app/herdr-app'])
  } catch {}
  return (await closed()) ? `ended (${shown(asked)})` : `still open (${shown(asked)})`
}

async function latest() {
  const feed = await readFeed({ platform, arch: process.arch })
  record('d2: the feed for this target', Boolean(feed.version), JSON.stringify(feed))
  if (!feed.version) return
  const older = await olderBuild(feed.version)
  record('d2: an older build herdrdev keeps', older !== null, older ? `${older.version}: ${older.url} (${older.size} bytes, sha256 ${older.sha256}, computed here)` : `none of the three versions before ${feed.version} is kept for ${target}`, { value: older?.version })
  if (!older) return
  const { server, releases } = await feedServer(older)
  const found = () => findHerdr(host)
  const version = async () => installedVersion(found().bin, { env })
  const downgrade = async (check) => {
    const bin = found()?.bin
    if (bin) record(`${check}: window closed first`, null, await closeHerdr(bin), { needed: false })
    if (!(await install({ check: `${check}: herdrdev's installer, older feed`, releases }))) return false
    const now = await version()
    record(`${check}: installed ${older.version}`, now === older.version, `--version: ${now}`)
    return now === older.version
  }
  const step = async (check, options, expect) => {
    const logs = []
    const marks = []
    const t0 = Date.now()
    const result = await openLatest({ ...host, ...options, log: line => logs.push(line), mark: mark => marks.push(`${mark} +${Date.now() - t0} ms`) })
    const now = await version()
    const ok = expect(result, now)
    record(check, ok, `${JSON.stringify(result)}\n--version after: ${now}\nsteps: ${marks.join(', ')}\nlog: ${logs.join(' | ')}`, { value: now })
    return result
  }
  try {
    if (!(await downgrade('d2: downgrade'))) return
    // Before any window has run the older build on this home, so its own updater has not had
    // a chance to fetch the new one yet: offline, then the offer, then no.
    await step('d2: offline opens the installed one, with the note', { fetch: () => Promise.reject(new TypeError('fetch failed')) },
      (result, now) => result.ok && result.note === OFFLINE && now === older.version)
    await step('d2: online, no answer yet: the offer, nothing else', {},
      (result, now) => result.reason === 'update' && result.installed === older.version && result.latest === feed.version && now === older.version)
    await step('d2: no opens the installed one', { update: false, skip: feed.version },
      (result, now) => result.ok && now === older.version)
    await step('d2: yes with the window open ends on the feed\'s version', { update: true, offered: feed.version },
      (result, now) => result.ok && result.version === feed.version && now === feed.version && compareVersions(now, older.version) > 0)
    const status = await run(found().bin, ['status'], { env })
    record('d2: the window answers after the update', status.code === 0, shown(status))
    if (status.code !== 0) {
      // Did Herdr's own restart drop HERDR_APP_HOME (a variable only this harness sets)?
      const homeless = await run(found().bin, ['status'], { env: base })
      record('d2: (diagnostic) status on the default home', null, shown(homeless), { needed: false })
    }
    if (!(await downgrade('d2: downgrade again'))) return
    await step('d2: yes with the window closed ends on the feed\'s version', { update: true, offered: feed.version },
      (result, now) => result.ok && result.version === feed.version && now === feed.version)
    const after = await run(found().bin, ['status'], { env })
    record('d2: the window answers on the new build', after.code === 0, shown(after))
  } finally {
    server.close()
  }
}

function summary() {
  const cell = row => (row.ok === true ? 'pass' : row.ok === false ? '**fail**' : 'info')
  const md = [`### herdr-app on ${target}`, '', '| check | result | detail |', '|---|---|---|',
    ...rows.map(row => `| ${row.check} | ${cell(row)} | ${clip(row.detail, 700).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')} |`), '']
  writeFileSync(join(out, 'summary.md'), md.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`)
}

try {
  await main()
} catch (error) {
  record('harness', false, error.stack)
}
try {
  await latest()
} catch (error) {
  record('d2: harness', false, error.stack)
}
summary()
console.log(readFileSync(join(out, 'summary.md'), 'utf8'))
process.exit(failed ? 1 : 0)
