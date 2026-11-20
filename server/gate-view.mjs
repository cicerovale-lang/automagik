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
const TEMP_FILE = new RegExp(
  String.raw`^(launch-url|profile-state\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-` +
  String.raw`4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$`,
)
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

function entryProblem(view, name, checkMode) {
  const label = JSON.stringify(name)
  if (!VIEW_FILES.has(name) && !TEMP_FILE.test(name)) {
    return `unexpected entry in gate-view: ${label}`
  }
  let info
  try { info = lstatSync(join(view, name), { throwIfNoEntry: false }) }
  catch { return `could not inspect gate-view entry: ${label}` }
  // A writer can rename its temp file between readdir and lstat.
  if (!info) return null
  if (!info.isFile()) return `gate-view entry must be a regular file: ${label}`
  if (checkMode && !privateMode(info)) {
    return `gate-view entry must have mode 0600: ${label}`
  }
  return null
}

export function viewProblem(view, { requireLaunch = false } = {}) {
  try {
    if (!lstatSync(view).isDirectory()) return 'gate-view must be a real directory'
    for (const name of readdirSync(view)) {
      const problem = entryProblem(view, name, true)
      if (problem) return problem
    }
    if (requireLaunch) {
      const launch = lstatSync(join(view, LAUNCH_FILE), { throwIfNoEntry: false })
      if (!launch?.isFile() || !privateMode(launch)) return 'gate-view launch-url unavailable'
    }
    return null
  } catch { return 'could not inspect gate-view' }
}

export function withdrawGateView(view) {
  try {
    if (!lstatSync(view).isDirectory()) return
  } catch { return }
  for (const name of VIEW_FILES) {
    const file = join(view, name)
    try {
      const info = lstatSync(file)
      // Remove the publications. Leave unexpected entries in place, even at these names.
      if (info.isFile() && privateMode(info)) unlinkSync(file)
    } catch {}
  }
}

export function createViewCheck(view) {
  let ready = false
  let nextCheck = -Infinity
  return () => {
    const now = performance.now()
    if (now >= nextCheck) {
      nextCheck = now + 1000
      // No view mounted at all: the gate cannot reach DSH (its launch URL lives there), so its
      // own pages keep their usual answers. A mounted view must be clean and carry a launch.
      const mounted = lstatSync(view, { throwIfNoEntry: false }) !== undefined
      ready = !mounted || viewProblem(view, { requireLaunch: true }) === null
    }
    return ready
  }
}

export function readViewFile(path) {
  // A name can be replaced after validation. Never follow a link or block on a pipe.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Gate view file unavailable')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function prepareGateView(view, volumeRoot, privateDirs, { uid = process.getuid?.() ?? 1000 } = {}) {
  if (!lstatSync(view, { throwIfNoEntry: false })) {
    mkdirSync(view, { recursive: true, mode: 0o700 })
  }
  const info = lstatSync(view)
  // Owned by the uid DSH runs as (1000 in the image), never another account's folder.
  if (!info.isDirectory() || info.uid !== uid) {
    throw new Error(`gate-view must be a real directory owned by uid ${uid}`)
  }

  const location = realpathSync.native(view)
  // A custom home that does not exist yet resolves like any other missing path.
  const volume = realLocation(volumeRoot)
  for (const [name, dir] of Object.entries(privateDirs)) {
    const home = realLocation(dir)
    if (contains(location, home) || (home !== volume && contains(home, location))) {
      throw new Error(`gate-view overlaps ${name}`)
    }
  }
  if ((info.mode & 0o7777) !== 0o700) chmodSync(view, 0o700)

  for (const name of readdirSync(view)) {
    const problem = entryProblem(view, name, false)
    if (problem) throw new Error(problem)
    if (TEMP_FILE.test(name)) rmSync(join(view, name), { force: true })
  }
}

export function writePrivateFile(target, bytes) {
  const fresh = `${target}.${randomUUID()}.tmp`
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

export function writeProfileState(view, { plugins, followsImage, ownerManaged, reason }) {
  const versions = Object.fromEntries(PLUGINS.map(name => [name, plugins?.[name] ?? null]))
  const state = {
    schemaVersion: 1, at: new Date().toISOString(), plugins: versions,
    followsImage, ownerManaged, reason,
  }
  writePrivateFile(join(view, PROFILE_STATE_FILE), `${JSON.stringify(state)}\n`)
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
