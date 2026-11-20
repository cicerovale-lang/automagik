import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { PLUGINS, releaseVersion } from './profile-state.mjs'

export const LAUNCH_FILE = 'launch-url'
const PROFILE_STATE_FILE = 'profile-state.json'
const VIEW_FILES = new Set([LAUNCH_FILE, PROFILE_STATE_FILE])
const LEGACY_TEMP_FILE = new RegExp(
  String.raw`^(launch-url|profile-state\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-` +
  String.raw`4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$`,
)
const IDENTITY_PROBLEM = 'gate-view directory identity does not match startup'
const MAX_AGE = 5 * 60_000
const MAX_CLOCK_SKEW = 60_000
const STATE_KEYS = ['schemaVersion', 'at', 'plugins', 'followsImage', 'ownerManaged', 'reason']
const REASONS = new Set([
  'invalid-profile', 'unsupported-seed-marker', 'owner-managed', 'invalid-image-metadata',
  'matching-image', 'update-rolled-back', 'missing-plugins', 'newer-than-image',
  'update-required', 'invalid-profile-state',
])

// Resolve existing symlinks even when the private directory is yet to be created.
function realLocation(path) {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (error.code !== 'ENOENT' || lstatSync(path, { throwIfNoEntry: false })) throw error
    return join(realLocation(dirname(path)), basename(path))
  }
}

function contains(parent, path) {
  const child = relative(parent, path)
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

function privateMode(info) {
  return (info.mode & 0o7777) === 0o600
}

function fileProblem(info, label, checkMode = true) {
  if (!info.isFile()) return `gate-view entry must be a regular file: ${label}`
  if (info.nlink !== 1) return `gate-view entry must have one link: ${label}`
  if (checkMode && !privateMode(info)) {
    return `gate-view entry must have mode 0600: ${label}`
  }
  return null
}

function entryProblem(view, name, checkMode = true) {
  const label = JSON.stringify(name)
  let info
  try { info = lstatSync(join(view, name), { throwIfNoEntry: false }) }
  catch { return `could not inspect gate-view entry: ${label}` }
  // A withdrawal can unlink a publication between readdir and lstat.
  return info ? fileProblem(info, label, checkMode) : null
}

export function viewProblem(view, { requireLaunch = false } = {}) {
  try {
    if (!lstatSync(view).isDirectory()) return 'gate-view must be a real directory'
    for (const name of readdirSync(view)) {
      if (!VIEW_FILES.has(name)) return `unexpected entry in gate-view: ${JSON.stringify(name)}`
      const problem = entryProblem(view, name)
      if (problem) return problem
    }
    if (requireLaunch) {
      const launch = lstatSync(join(view, LAUNCH_FILE), { throwIfNoEntry: false })
      if (!launch || fileProblem(launch, LAUNCH_FILE)) return 'gate-view launch-url unavailable'
    }
    return null
  } catch { return 'could not inspect gate-view' }
}

export function withdrawGateView(view) {
  try {
    if (!lstatSync(view).isDirectory()) return
  } catch { return }
  for (const name of VIEW_FILES) {
    // Unlink the name itself, regardless of mode. A directory is left in place.
    try { unlinkSync(join(view, name)) } catch {}
  }
}

export function createViewCheck(view, build) {
  let expires = -Infinity
  let nextCheck = -Infinity
  return () => {
    const now = performance.now()
    if (now >= nextCheck) {
      nextCheck = now + 1000
      const problem = viewProblem(view, { requireLaunch: true })
      const state = problem ? null : readProfileState(view, build)
      expires = state?.at ? Date.parse(state.at) + MAX_AGE : -Infinity
    }
    return Date.now() <= expires
  }
}

export function readViewFile(path) {
  // A name can be replaced after validation. Never follow a link or block on a pipe.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (fileProblem(fstatSync(fd), 'publication')) {
      throw new Error('Gate view file unavailable')
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

const stagingDir = view => `${view}-staging`
const identityFile = view => `${view}-identity.json`

function directoryIdentity(view) {
  const info = lstatSync(view, { bigint: true })
  if (!info.isDirectory()) throw new Error('gate-view must be a real directory')
  return { dev: String(info.dev), ino: String(info.ino) }
}

function matchingIdentity(view) {
  try {
    const recorded = JSON.parse(readViewFile(identityFile(view)))
    const current = directoryIdentity(view)
    if (recorded?.dev === current.dev && recorded.ino === current.ino) return current
  } catch {}
  return null
}

export function viewIdentityProblem(view) {
  return matchingIdentity(view) ? null : IDENTITY_PROBLEM
}

function preparePrivateDirectory(path, label, volumeRoot, privateDirs, uid) {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.uid !== uid) {
    throw new Error(`${label} must be a real directory owned by uid ${uid}`)
  }

  const location = realpathSync.native(path)
  // A custom home that does not exist yet resolves like any other missing path.
  const volume = realLocation(volumeRoot)
  for (const [name, dir] of Object.entries(privateDirs)) {
    const home = realLocation(dir)
    if (contains(location, home) || (home !== volume && contains(home, location))) {
      throw new Error(`${label} overlaps ${name}`)
    }
  }
  if ((info.mode & 0o7777) !== 0o700) chmodSync(path, 0o700)
}

export function prepareGateView(view, volumeRoot, privateDirs,
  { uid = process.getuid?.() ?? 1000 } = {}) {
  preparePrivateDirectory(view, 'gate-view', volumeRoot, privateDirs, uid)
  for (const name of readdirSync(view)) {
    // Old writers staged in the view. Clear their leftovers only during startup.
    const legacyTemp = LEGACY_TEMP_FILE.test(name)
    if (!VIEW_FILES.has(name) && !legacyTemp) {
      throw new Error(`unexpected entry in gate-view: ${JSON.stringify(name)}`)
    }
    const problem = entryProblem(view, name, false)
    if (problem) throw new Error(problem)
    if (legacyTemp) rmSync(join(view, name), { force: true })
  }

  const stage = stagingDir(view)
  preparePrivateDirectory(stage, 'gate-view staging', volumeRoot,
    { ...privateDirs, 'gate-view': view }, uid)
  const identity = directoryIdentity(view)
  checkStaging(view, identity, uid)
  writePrivateFile(identityFile(view), `${JSON.stringify(identity)}\n`, stage)
}

function checkStaging(view, identity, uid) {
  const info = lstatSync(stagingDir(view), { bigint: true })
  if (!info.isDirectory() || info.uid !== BigInt(uid) || (info.mode & 0o7777n) !== 0o700n ||
      String(info.dev) !== identity.dev) {
    throw new Error('gate-view staging must be a private directory on the same volume')
  }
}

export function writePrivateFile(target, bytes, stage = dirname(target)) {
  const fresh = join(stage, `${basename(target)}.${randomUUID()}.tmp`)
  const fd = openSync(fresh, 'wx', 0o600)
  try {
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    renameSync(fresh, target)
  } finally {
    rmSync(fresh, { force: true })
  }
}

export function writeGateFile(view, name, bytes) {
  const identity = matchingIdentity(view)
  if (!identity) throw new Error(IDENTITY_PROBLEM)
  checkStaging(view, identity, process.getuid?.() ?? 1000)
  writePrivateFile(join(view, name), bytes, stagingDir(view))
}

export function writeProfileState(view, { plugins, followsImage, ownerManaged, reason }) {
  const versions = Object.fromEntries(PLUGINS.map(name => [name, plugins?.[name] ?? null]))
  const state = {
    schemaVersion: 1, at: new Date().toISOString(), plugins: versions,
    followsImage, ownerManaged, reason,
  }
  writeGateFile(view, PROFILE_STATE_FILE, `${JSON.stringify(state)}\n`)
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isTimestamp(value) {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function isProfileState(state, build) {
  if (!hasKeys(state, STATE_KEYS) || state.schemaVersion !== 1 || !isTimestamp(state.at) ||
      !hasKeys(state.plugins, PLUGINS) || typeof state.followsImage !== 'boolean' ||
      typeof state.ownerManaged !== 'boolean' || !REASONS.has(state.reason)) return false
  const versions = PLUGINS.map(name => state.plugins[name])
  if (state.followsImage) {
    // profileState: followsImage only when the profile is image-managed and every plugin is the
    // image's own version.
    return !state.ownerManaged && state.reason === 'matching-image' &&
      PLUGINS.every(name => releaseVersion(state.plugins[name]) && state.plugins[name] === build?.plugins?.[name])
  }
  // profileState: ownerManaged only with reason owner-managed.
  if (state.ownerManaged && state.reason !== 'owner-managed') return false
  return versions.every(version => version === null || releaseVersion(version))
}

export function unavailableProfileState(reason) {
  return {
    plugins: Object.fromEntries(PLUGINS.map(name => [name, null])),
    followsImage: false,
    ownerManaged: false,
    reason,
  }
}

export function readProfileState(view, build) {
  let state
  try { state = JSON.parse(readViewFile(join(view, PROFILE_STATE_FILE))) } catch {}
  if (!isProfileState(state, build)) return unavailableProfileState('no-profile-state')
  const age = Date.now() - Date.parse(state.at)
  if (age > MAX_AGE || age < -MAX_CLOCK_SKEW) {
    return unavailableProfileState('stale-profile-state')
  }
  return state
}
