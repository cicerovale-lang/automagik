// Disposable API 35 acceptance desktop for the Pocket memory notice fix: D1's harness (real bots-dsh runtime + bridge
// objects) whose memory writes can be held. Run as: node .automagik/memory-notice-harness.mjs
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createRuntime } from '../apps/bots-dsh/index.js'
import { socketPathOf } from '../apps/bots-dsh/src/host/pocket-socket.js'
import { fakeContext } from '../apps/bots-dsh/test/fake-ctx.js'
import { ChatConnection, chatWriter } from '../herdr/mods/pocket-link/bridge/chat.mjs'
import { DshSource, withDsh } from '../herdr/mods/pocket-link/bridge/dsh-source.mjs'

const BOT = 'b-aaaaaaaaaa'
const PRIVATE = 'b-bbbbbbbbbb'
const GLOBAL = 'b-cccccccccc'
const SEED = 'Seeded fixture note'
const home = mkdtempSync(join(tmpdir(), 'pocket-memory-device-'))
const path = socketPathOf(home)
const memoryFile = join(home, 'memory', 'bots', BOT, 'MEMORY.md')
const project = '/repo/pocket-memory-device'
const bots = {
  [BOT]: { id: BOT, name: 'Fixture Bot', sessionId: 's-fixture', model: 'deepseek/v4', createdAt: 1 },
  [PRIVATE]: { id: PRIVATE, name: 'Private Fixture', sessionId: 's-private', model: 'deepseek/v4', createdAt: 2, private: true },
  [GLOBAL]: { id: GLOBAL, name: 'Global Fixture', sessionId: 's-global', model: 'deepseek/v4', createdAt: 3 },
}
mkdirSync(join(home, 'memory', 'bots', BOT), { recursive: true })
writeFileSync(memoryFile, `# Memory\n\n- ${SEED} [id: fixture-seed; added: 2026-11-19]\n`)
writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, mainBotIds: [GLOBAL], whaleStored: true, bots, rooms: {} }))
const registryPath = join(home, 'bots.json')
writeFileSync(registryPath, JSON.stringify({
  version: 2, projects: [],
  bots: [BOT, PRIVATE].map(id => ({ id, name: bots[id].name, folder: project })),
  shown: [{ project, bots: [BOT, PRIVATE] }],
}))

const controller = {
  async* follow({ address }, signal) {
    yield { type: 'snapshot', header: { version: 1, id: address.sessionId, createdAt: 0 }, records: [], cursor: -1, hasMore: false, projections: { asOfSeq: -1, values: {} } }
    if (!signal.aborted) await once(signal, 'abort')
  },
  async events() { return { records: [], hasMore: false, cursor: -1 } },
  async state() { return { cursor: -1, active: true, running: false, queue: [], pendingInput: [] } },
  async* observeState() {},
  prompt: async () => ({ accepted: true }),
  cancel: () => ({ accepted: true }),
}
const ctx = fakeContext({ services: { sessionController: controller } })
ctx.logger.warn = () => {} // Runtime logs never include memory text.
const rt = createRuntime(ctx, { home, memoryReview: false })
rt.registryPath = registryPath
const dsh = new DshSource({ path })
const base = {
  ready: async () => {}, list: () => [], closeClient: () => {},
  watch() { throw new Error('unexpected base watch') },
  send() { throw new Error('unexpected base send') },
  sendHeld() { throw new Error('unexpected base sendHeld') },
  cancelHeld() { throw new Error('unexpected base cancelHeld') },
  answer() { throw new Error('unexpected base answer') },
  interrupt() { throw new Error('unexpected base interrupt') },
}
let held = null, seenWrites = 0
const releaseWrites = () => { held?.resolve(); held = null }
const sockets = new Set()
const servers = []
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  dsh.close()
  await ctx.dispose()
  await Promise.resolve(rt.dispose())
  rmSync(home, { recursive: true, force: true })
}
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)) })
process.on('SIGINT', () => { void stop().then(() => process.exit(0)) })

function route(engineFactory) {
  return socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    let conn
    const writer = chatWriter({
      send: bytes => new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve())),
      isClosed: () => conn.closed,
      isRevoked: () => false,
      onFail: () => conn.close('write failed'),
    })
    conn = new ChatConnection({ engine: engineFactory(), device: 'paired-key', write: writer, end: () => socket.destroy() })
    socket.on('data', bytes => conn.feed(bytes))
    socket.on('close', () => { conn.close(); sockets.delete(socket) })
  }
}
function control(socket) {
  sockets.add(socket)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('error', () => {})
  socket.on('close', () => sockets.delete(socket))
  socket.on('data', chunk => {
    buffer += chunk
    for (let at; (at = buffer.indexOf('\n')) !== -1;) {
      const command = buffer.slice(0, at).trimEnd()
      buffer = buffer.slice(at + 1)
      if (command === 'file') socket.write(JSON.stringify({ text: readFileSync(memoryFile, 'utf8') }) + '\n')
      else if (command.startsWith('desktop-edit ')) {
        const next = command.slice('desktop-edit '.length)
        const file = readFileSync(memoryFile, 'utf8')
        if (!file.includes(SEED)) socket.write('missing\n')
        else { writeFileSync(memoryFile, file.replace(SEED, next)); socket.write('ok\n') }
      } else if (command === 'hold-writes on') { held ??= Promise.withResolvers(); socket.write('ok\n') }
      else if (command === 'release-writes') { releaseWrites(); socket.write('ok\n') }
      else if (command === 'seen-writes') socket.write(`${seenWrites}\n`)
      else if (command === 'quit') { socket.write('ok\n'); socket.end(); void stop().then(() => process.exit(0)) }
      else socket.write('unknown\n')
    }
  })
}
async function listen(port, listener) {
  const server = createServer(listener)
  servers.push(server)
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
}

try {
  await rt.load()
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Pocket socket did not start')
    await delay(20)
  }
  if (!await dsh.open()) throw new Error('Pocket socket refused the bridge')
  await listen(47100, route(() => {
    const e = withDsh(base, dsh)
    const memory = e.memory.bind(e)
    return { ...e, memory: async (client, method, params) => {
      if (method === 'memory.add' || method === 'memory.edit') { seenWrites += 1; await held?.promise }
      return memory(client, method, params)
    } }
  }))
  await listen(47101, route(() => {
    const legacy = withDsh(base, dsh)
    delete legacy.openManage
    delete legacy.memory
    return legacy
  }))
  await listen(47102, control)
  process.stdout.write('READY\n')
} catch (error) {
  await stop()
  process.stderr.write(`Harness setup failed: ${error?.code ?? error?.name ?? 'error'}\n`)
  process.exitCode = 1
}
