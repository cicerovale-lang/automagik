// Disposable RFC 0033 D4d device bridge. Run from the repository root with the
// bots-dsh test resolver preloaded. Only counters and content types leave here.
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { realAdmission, connectWire, fixturePng, uploadWire, watchWire } from '../apps/bots-dsh/test/support/pocket-upload-admission.js'
import { PocketUploads, sha256 } from '../apps/bots-dsh/src/host/pocket-attach.js'
import { servePocketConnection, socketPathOf, writeLimits } from '../apps/bots-dsh/src/host/pocket-socket.js'
import { rowIdOf } from '../apps/bots-dsh/src/host/pocket-chat.js'
import { ChatConnection, chatWriter } from '../herdr/mods/pocket-link/bridge/chat.mjs'
import { DshSource, withDsh } from '../herdr/mods/pocket-link/bridge/dsh-source.mjs'

const BOT = 'b-aaaaaaaaaa'
const PHONE = 'paired-key'
const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'rfc-0033-d4d-device-'))
const h = await realAdmission(home)
let session = 'a'
let slowMs = 0
let gifFile
let hookFired = 0
let pendingChunkAcks = 0
const reads = []
const forwardedCancel = []
const admitted = []
const repeatReplies = []
const uploadBegins = []
const ingress = { image: 0, document: 0, other: 0, attachmentRead: 0 }
const storedFiles = []
let refuseFiles = false
const phoneSockets = new Set()
const servers = []
const dshSources = []
const socketServers = []
const registry = new PocketUploads({ home })
const originalStop = registry.stop.bind(registry)
registry.stop = (record, state, result) => {
  const answer = originalStop(record, state, result)
  if (state === 'admitted') admitted.push(record.upload)
  return answer
}
const limits = writeLimits()
const originalFileUpload = h.uploads.uploadStream.bind(h.uploads)
h.uploads.uploadStream = async request => {
  if (refuseFiles) {
    const error = new Error('file admission unavailable')
    error.details = { reason: 'ATTACHMENT_FILES_UNSUPPORTED' }
    throw error
  }
  return originalFileUpload(request)
}
const originalSaveFile = h.store.saveFileStream.bind(h.store)
h.store.saveFileStream = async request => {
  const file = await originalSaveFile(request)
  const bytes = readFileSync(h.store.fileHostPath(file))
  storedFiles.push({ digest: sha256(bytes), name: file.name, size: bytes.length })
  return file
}
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const realRead = h.store.readImageRequest.bind(h.store)
h.store.readImageRequest = async (ref, options, signal) => {
  if (gifFile && ref?.attachmentId === gifFile.attachmentId && ref.mediaType === 'image/gif') {
    const chunks = []
    for await (const chunk of h.store.readFileStream(gifFile, signal)) chunks.push(chunk)
    reads.push({ mediaType: 'image/gif', width: 1, height: 1 })
    return { data: Buffer.concat(chunks), mediaType: 'image/gif', width: 1, height: 1 }
  }
  const answer = await realRead(ref, options, signal)
  reads.push({ mediaType: answer?.mediaType ?? null, width: answer?.width ?? null, height: answer?.height ?? null })
  return answer
}

function source(withAttachments) {
  const value = h.source()
  value.bots = async () => [{ id: BOT, name: 'Fixture Bot', sessionId: session }]
  if (!withAttachments) { value.fileUploads = undefined; value.attachmentStore = undefined }
  return value
}
async function socketHost(path, appAttachments) {
  const server = createServer(socket => {
    // Observe metadata before DSH consumes each request. Never retain chunk data.
    let pending = ''
    socket.on('data', bytes => {
      pending += bytes.toString('utf8')
      for (let end; (end = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        let request
        try { request = JSON.parse(line) } catch { continue }
        if (request.method === 'upload-begin') uploadBegins.push(request.params?.upload)
        if (request.method === 'upload-cancel') forwardedCancel.push(request.params?.upload)
      }
    })
    // Delay DSH's chunk acknowledgements while preserving all real request handling.
    const rawWrite = socket.write.bind(socket)
    socket.write = (data, encoding, callback) => {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      if (text.includes('"repeat":true')) repeatReplies.push(true)
      if (slowMs && text.includes('"received"')) {
        pendingChunkAcks++
        setTimeout(() => {
          pendingChunkAcks--
          rawWrite(data, encoding, callback)
        }, slowMs)
        return true
      }
      return rawWrite(data, encoding, callback)
    }
    const connection = servePocketConnection(socket, appAttachments ? source(true) : source(false), () => {}, limits, registry)
    socket.on('close', () => connection.close())
  })
  socketServers.push(server)
  server.listen(path)
  await once(server, 'listening')
}
const base = {
  ready: async () => {}, list: () => [], closeClient: () => {},
  watch() { throw new Error('unexpected base watch') },
  send() { throw new Error('unexpected base send') },
  sendHeld() { throw new Error('unexpected base sendHeld') },
  cancelHeld() { throw new Error('unexpected base cancelHeld') },
  answer() { throw new Error('unexpected base answer') },
  interrupt() { throw new Error('unexpected base interrupt') },
}
function route(engine, Connection = ChatConnection, Writer = chatWriter, port = 0) {
  return socket => {
    process.stderr.write(`phone-open port=${port}\n`)
    phoneSockets.add(socket)
    socket.on('error', () => {})
    let conn
    const writer = Writer({ send: bytes => new Promise((resolve, reject) => {
      // The only unframed reply is hello. Report its capability shape, never its payload.
      const line = bytes.toString('utf8')
      if (line.startsWith('{')) {
        try {
          const reply = JSON.parse(line)
          if (reply.id === 0 && reply.result) process.stderr.write(
            `phone-hello port=${port} peer=${reply.result.attachments?.unavailable ?? (reply.result.attachments ? 'offered' : 'missing')} documents=${Boolean(reply.result.attachments?.documents)}\n`)
        } catch {}
      }
      socket.write(bytes, error => error ? reject(error) : resolve())
    }),
      isClosed: () => conn.closed, isRevoked: () => false, onFail: () => conn.close('write failed') })
    conn = new Connection({ engine, device: PHONE, write: writer, end: () => socket.destroy() })
    let ingressPending = ''
    socket.on('data', bytes => {
      ingressPending += bytes.toString('utf8')
      for (let end; (end = ingressPending.indexOf('\n')) >= 0;) {
        const line = ingressPending.slice(0, end); ingressPending = ingressPending.slice(end + 1)
        let request
        try { request = JSON.parse(line) } catch { continue }
        if (request.method === 'hello') process.stderr.write(
          `phone-request port=${port} attachments=${request.params?.attachments === 1} documents=${request.params?.documents === 1}\n`)
        if (request.method === 'chat.attach') {
          const type = request.params?.mediaType
          ingress[type === 'text/plain' || type === 'application/pdf' ? 'document' :
            typeof type === 'string' && type.startsWith('image/') ? 'image' : 'other']++
        }
        if (request.method === 'chat.attachmentRead') ingress.attachmentRead++
      }
      conn.feed(bytes)
    })
    socket.on('close', () => { process.stderr.write(`phone-close port=${port}\n`); conn.close(); phoneSockets.delete(socket) })
  }
}
async function listen(port, handler) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
}
const committed = id => h.agents.get(id).session.snapshotEvents().filter(e => e.type === 'user/message')
const types = content => Array.isArray(content) ? content.map(part => part.type) : []
function counts() {
  const firstPromptById = new Map()
  const prompts = h.prompts.map(p => {
    const first = firstPromptById.get(p.requestId)
    if (!first) firstPromptById.set(p.requestId, p)
    return { session: p.sessionId, requestId: p.requestId, contentTypes: types(p.content),
      repeatsContent: !!first && isDeepStrictEqual(first.content, p.content) }
  })
  return {
    prompts,
    committed: Object.fromEntries(['a', 'b'].map(id => [id, committed(id).map(e => ({ id: e.data?.source?.rpcId ?? null, contentTypes: types(e.data?.content), rowId: rowIdOf(id, e.seq) }))])),
    reads, ingress: { ...ingress }, storedFileCount: storedFiles.length, admitted, uploadBegins, forwardedCancel, repeatReplies, hookFired, pendingChunkAcks,
    watches: [...dshSources].reduce((sum, dsh) => sum + [...dsh.subs.values()].filter(s => s.attachments).length, 0),
    outstanding: [...registry.records.get(sha256(PHONE))?.values() ?? []].reduce((sum, rec) => sum + (rec.bytes ?? 0), 0),
    held: admitted.map(upload => ({ upload, present: registry.find(sha256(PHONE), upload) !== undefined })),
    session,
  }
}
function drop() { for (const socket of phoneSockets) socket.destroy() }
async function seed() {
  const sessionId = session
  const agent = h.agents.get(sessionId)
  let stage = 'open the DSH socket'
  let wire
  try {
    wire = await connectWire(socketPathOf(home))
    stage = 'watch the fixture Bot'
    if ((await watchWire(wire, 1, `dsh:${BOT}`))?.channel !== 1) throw new Error()
    const upload = async (id, png) => {
      const result = await uploadWire(wire, png, { phone: 'seed-phone', channel: 1, upload: id })
      if (result?.state !== 'admitted') throw new Error()
      const receipt = h.receiptIds.at(-1)
      const ref = h.uploads.resolve(agent, receipt)?.attachment
      if (!ref) throw new Error()
      return ref
    }
    const append = content => h.append(agent.session, 'user/message',
      { id: randomUUID(), role: 'user', source: { kind: 'user' }, content }, { surfaceOp: 'append' })
    stage = 'admit the captioned fixture'
    const first = await upload('seed-caption', fixturePng(32, 24, 80))
    stage = 'append the captioned fixture'
    const captioned = append([{ type: 'text', text: 'Fixture caption' }, { type: 'image', attachment: first }])
    stage = 'admit the image-only fixture'
    const second = await upload('seed-image', fixturePng(40, 30, 100))
    stage = 'append the image-only fixture'
    const imageOnly = append([{ type: 'image', attachment: second }])
    // Desktop GIFs bypass the phone upload and the store's single-frame normalization.
    stage = 'store the original GIF fixture'
    gifFile = await h.store.saveFile({ data: gif, name: 'fixture.gif' })
    const gifRef = { attachmentId: gifFile.attachmentId, bytes: gifFile.bytes, mediaType: 'image/gif', width: 1, height: 1 }
    stage = 'append the GIF fixture'
    const animated = append([{ type: 'image', attachment: gifRef }])
    return { ok: true, captioned: rowIdOf(sessionId, captioned.seq), imageOnly: rowIdOf(sessionId, imageOnly.seq), gif: rowIdOf(sessionId, animated.seq) }
  } catch {
    const error = `seed failed while trying to ${stage}`
    process.stderr.write(`${error}\n`)
    return { ok: false, error }
  } finally { wire?.stop() }
}
async function command(input) {
  switch (input.cmd) {
    case 'counts': return counts()
    case 'reset': session = 'a'; slowMs = 0; refuseFiles = false; delete h.hooks.accepted; return { ok: true }
    case 'drop': drop(); return { ok: true }
    case 'dropMove':
      if (pendingChunkAcks === 0) return { ok: false, error: 'no delayed chunk acknowledgement in flight' }
      drop(); session = 'b'; slowMs = 0; return { ok: true }
    case 'dropAfterAccept': h.hooks.accepted = () => { delete h.hooks.accepted; hookFired++; drop() }; return { ok: true }
    case 'slowChunks': slowMs = input.ms ?? 2500; return { ok: true }
    case 'move': session = 'b'; return { ok: true }
    case 'seed': return seed()
    case 'refuseFiles': refuseFiles = true; return { ok: true }
    case 'verifyRow': {
      const event = committed(input.session ?? 'a').at(-1)
      const content = event?.data?.content
      if (!Array.isArray(content) || !Array.isArray(input.types)) return { ok: false }
      return { ok: isDeepStrictEqual(types(content), input.types) &&
        content.find(part => part.type === 'text')?.text === input.text &&
        isDeepStrictEqual(content.filter(part => part.type === 'file').map(part =>
          ({ name: part.attachment?.name, size: part.attachment?.bytes })), input.files) }
    }
    case 'verifyFiles': {
      const expected = input.expected
      if (!Array.isArray(expected) || expected.length > 4) return { ok: false }
      const actual = storedFiles.slice(-expected.length)
      return { ok: actual.length === expected.length && actual.every((file, index) =>
        file.digest === expected[index]?.digest && file.name === expected[index]?.name && file.size === expected[index]?.size),
        count: actual.length }
    }
    case 'probe': return { present: registry.find(sha256(PHONE), input.upload) !== undefined }
    default: return { error: 'unknown command' }
  }
}
function control(socket) {
  socket.setEncoding('utf8')
  let pending = ''
  socket.on('error', () => {})
  socket.on('data', chunk => {
    pending += chunk
    for (let end; (end = pending.indexOf('\n')) >= 0;) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      let input
      try { input = JSON.parse(line) } catch { socket.write('{"error":"invalid JSON"}\n'); continue }
      void Promise.resolve(command(input)).then(answer => socket.write(JSON.stringify(answer) + '\n'), () => socket.write('{"error":"command failed"}\n'))
    }
  })
}
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  drop()
  for (const dsh of dshSources) dsh.close()
  await Promise.all([...servers, ...socketServers].map(server => new Promise(resolve => server.close(resolve))))
  rmSync(home, { recursive: true, force: true })
}
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)) })
process.on('SIGINT', () => { void stop().then(() => process.exit(0)) })
try {
  await socketHost(socketPathOf(home), true)
  const noAppPath = join(home, 'no-app.sock')
  await socketHost(noAppPath, false)
  const modern = new DshSource({ path: socketPathOf(home), check: () => true, attachments: true, documents: true })
  const noApp = new DshSource({ path: noAppPath, check: () => true, attachments: true })
  const none = new DshSource({ path: join(home, 'absent.sock'), check: () => true, attachments: true })
  const imagesOnly = new DshSource({ path: socketPathOf(home), check: () => true, attachments: true, documents: false })
  dshSources.push(modern, noApp, none, imagesOnly)
  if (!await modern.open() || !await noApp.open() || !await imagesOnly.open()) throw new Error('DSH socket refused bridge')
  process.stderr.write(`dsh-offer modern=${Boolean(modern.attachOffer)} documents=${Boolean(modern.attachOffer?.documents)} images-only=${Boolean(imagesOnly.attachOffer)}\n`)
  await listen(47110, route(withDsh(base, modern), ChatConnection, chatWriter, 47110))
  if (!process.env.OLD_BRIDGE_DIR) throw new Error('OLD_BRIDGE_DIR required')
  const oldDir = process.env.OLD_BRIDGE_DIR
  const oldChat = await import(pathToFileURL(join(oldDir, 'chat.mjs')).href)
  const oldDsh = await import(pathToFileURL(join(oldDir, 'dsh-source.mjs')).href)
  const legacy = new oldDsh.DshSource({ path: socketPathOf(home), check: () => true })
  dshSources.push(legacy)
  if (!await legacy.open()) throw new Error('old bridge could not open DSH socket')
  await listen(47111, route(oldDsh.withDsh(base, legacy), oldChat.ChatConnection, oldChat.chatWriter, 47111))
  await listen(47112, route(withDsh(base, noApp), ChatConnection, chatWriter, 47112))
  await listen(47113, route(withDsh(base, none), ChatConnection, chatWriter, 47113))
  await listen(47114, route(withDsh(base, imagesOnly), ChatConnection, chatWriter, 47114))
  await listen(47115, control)
  process.stdout.write('READY\n')
} catch (error) {
  await stop()
  process.stderr.write(`Harness setup failed: ${error?.message ?? 'unknown'}\n`)
  process.exitCode = 1
}
