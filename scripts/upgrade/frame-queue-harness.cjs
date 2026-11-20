const assert = require('node:assert/strict')
const path = require('node:path')
const root = process.env.ZAPO_UPGRADE_CANDIDATE_ROOT || path.resolve(__dirname, '../..')
const { WaComms } = require(path.join(root, 'dist/transport/WaComms.js'))
const { WaNodeTransport } = require(path.join(root, 'dist/transport/node/WaNodeTransport.js'))
const { WaNodeOrchestrator } = require(path.join(root, 'dist/transport/node/WaNodeOrchestrator.js'))
const { encodeBinaryNodeStanza } = require(path.join(root, 'dist/transport/binary/index.js'))
const { createNoopLogger } = require(path.join(root, 'dist/infra/log/types.js'))
const logger = createNoopLogger()
const tick = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const makeComms = () =>
    new WaComms(
        {
            url: 'wss://example.invalid',
            noise: {
                isRegistered: true,
                clientStaticKeyPair: { pubKey: new Uint8Array(32), privKey: new Uint8Array(32) }
            }
        },
        logger
    )
async function flush(turns = 40) {
    for (let turn = 0; turn < turns; turn++) await tick()
}

async function blockedQueries(options = {}) {
    const count = options.count ?? 8
    const comms = makeComms()
    const transport = new WaNodeTransport(logger)
    const outbound = []
    const responses = []
    let completed = 0
    let timedOut = 0
    let unmatched = 0
    let resumes = 0
    let normalProcessed = 0
    let releaseNormal
    const normalGate = new Promise((resolve) => {
        releaseNormal = resolve
    })
    const orchestrator = new WaNodeOrchestrator({
        logger,
        sendNode: async (node) => {
            outbound.push(node)
        },
        defaultTimeoutMs: 250
    })
    // Isolate the queue failure from actual network reconnects in this controlled harness.
    comms.closeSocketAndResume = async () => {
        resumes++
    }
    comms.connected = true
    comms.handlingRequests = true
    const handleNode = async (node) => {
        if (await orchestrator.handleIncomingNode(node)) return
        if (node.tag !== 'notification') {
            unmatched++
            return
        }
        if (node.attrs.type === 'work') {
            await normalGate
            normalProcessed++
            return
        }
        try {
            const response = await orchestrator.query({
                tag: 'iq',
                attrs: { id: 'query-' + node.attrs.id, type: 'get' }
            })
            responses.push({ requested: 'query-' + node.attrs.id, ...response.attrs })
            completed++
        } catch (error) {
            if (!error.message.includes('query timeout')) throw error
            timedOut++
        }
    }
    comms.stanzaHandler = (frame) => transport.dispatchIncomingFrame(frame, handleNode)
    comms.prepareStanza = async (frame, isCurrent, accountDecodedBytes) => {
        const node = await transport.decodeIncomingFrame(frame, isCurrent, accountDecodedBytes)
        if (!node || !isCurrent()) return null
        if (orchestrator.tryResolvePendingIqResponse(node)) return null
        return () => handleNode(node)
    }
    const deliver = (node) => comms.routeDecodedFrames([encodeBinaryNodeStanza(node)])
    let observed
    try {
        for (let i = 0; i < count; i++)
            await deliver({ tag: 'notification', attrs: { id: String(i), type: 'test' } })
        for (let i = 0; i < 200 && outbound.length < count; i++) await tick()
        assert.equal(outbound.length, count, 'all handlers must issue their queries first')

        if (options.unrelated) {
            await deliver({ tag: 'iq', attrs: { id: 'unknown', type: 'result' } })
            await deliver({ tag: 'iq', attrs: { type: 'result' } })
            await flush()
        }
        const beforeReplies = { completed, timedOut }
        for (let i = 0; i < (options.normalBacklog ?? 0); i++)
            await deliver({ tag: 'notification', attrs: { id: 'normal-' + i, type: 'work' } })
        const backlogBeforeReplies = {
            inFlight: comms.frameHandlerQueue.inFlight(),
            pending: comms.frameHandlerQueue.pending()
        }

        const answers = options.reverse ? [...outbound].reverse() : outbound
        for (let i = 0; i < answers.length; i++) {
            const node = answers[i]
            if (options.omitLast && node === outbound[outbound.length - 1]) continue
            const type = options.mixedErrors && i % 2 === 0 ? 'error' : 'result'
            const response = {
                tag: 'iq',
                attrs: { id: node.attrs.id, type },
                ...(type === 'error' ? { content: [{ tag: 'error', attrs: { code: '503' } }] } : {})
            }
            await deliver(response)
            if (options.duplicates) await deliver(response)
        }
        await flush()
        const beforeTimeout = {
            inFlight: comms.frameHandlerQueue.inFlight(),
            pending: comms.frameHandlerQueue.pending(),
            completed,
            timedOut,
            responses: [...responses]
        }
        if (options.advanceTime) options.advanceTime(250)
        else await delay(350)
        await flush()
        observed = {
            beforeReplies,
            backlogBeforeReplies,
            beforeTimeout,
            afterTimeout: { completed, timedOut },
            resumes
        }
    } finally {
        releaseNormal()
        orchestrator.clearPending(new Error('synthetic test cleanup'))
        await flush()
    }
    return { ...observed, unmatched, normalProcessed, hasPending: orchestrator.hasPending() }
}

async function overflow() {
    const comms = makeComms()
    comms.started = true
    comms.connected = true
    comms.handlingRequests = true
    let releaseTask, releaseClose
    const waitingTask = new Promise((resolve) => {
        releaseTask = resolve
    })
    const waitingClose = new Promise((resolve) => {
        releaseClose = resolve
    })
    let closes = 0,
        opens = 0
    comms.stanzaHandler = () => waitingTask
    comms.socket.close = () => {
        closes++
        return waitingClose
    }
    comms.openSocket = async () => {
        opens++
    }
    for (let i = 0; i < 12 + 4096; i++) comms.scheduleDecodedFrame(new Uint8Array([0]))
    const atCapacity = {
        inFlight: comms.frameHandlerQueue.inFlight(),
        pending: comms.frameHandlerQueue.pending()
    }
    for (let i = 0; i < 5; i++) comms.scheduleDecodedFrame(new Uint8Array([0]))
    await tick()
    releaseClose()
    await tick()
    releaseTask()
    await tick()
    return { excessFrames: 5, closes, opens, atCapacity }
}
async function main() {
    console.log(
        JSON.stringify(
            { root, overflow: await overflow(), queryQueue: await blockedQueries() },
            null,
            2
        )
    )
}
module.exports = { blockedQueries, overflow }
if (require.main === module)
    main().catch((error) => {
        console.error(error)
        process.exitCode = 1
    })
