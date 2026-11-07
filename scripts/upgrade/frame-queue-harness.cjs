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
async function blockedQueries() {
    const comms = makeComms()
    const transport = new WaNodeTransport(logger)
    const outbound = []
    let completed = 0
    let timedOut = 0
    const orchestrator = new WaNodeOrchestrator({
        logger,
        sendNode: async (node) => {
            outbound.push(node)
        },
        defaultTimeoutMs: 250
    })
    comms.handlingRequests = true
    comms.stanzaHandler = (frame) =>
        transport.dispatchIncomingFrame(frame, async (node) => {
            if (await orchestrator.handleIncomingNode(node)) return
            try {
                await orchestrator.query({
                    tag: 'iq',
                    attrs: { id: 'query-' + node.attrs.id, type: 'get' }
                })
                completed++
            } catch (error) {
                if (!error.message.includes('query timeout')) throw error
                timedOut++
            }
        })
    for (let i = 0; i < 8; i++)
        comms.scheduleDecodedFrame(
            encodeBinaryNodeStanza({ tag: 'notification', attrs: { id: String(i), type: 'test' } })
        )
    for (let i = 0; i < 30 && outbound.length < 8; i++) await tick()
    assert.equal(outbound.length, 8)
    for (const node of outbound)
        comms.scheduleDecodedFrame(
            encodeBinaryNodeStanza({ tag: 'iq', attrs: { id: node.attrs.id, type: 'result' } })
        )
    await delay(50)
    const blocked = {
        inFlight: comms.frameHandlerQueue.inFlight(),
        pending: comms.frameHandlerQueue.pending(),
        completed,
        timedOut
    }
    await delay(350)
    return { beforeTimeout: blocked, afterTimeout: { completed, timedOut } }
}
async function overflow() {
    const comms = makeComms()
    comms.started = true
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
    for (let i = 0; i < 8 + 4096; i++) comms.scheduleDecodedFrame(new Uint8Array([0]))
    for (let i = 0; i < 5; i++) comms.scheduleDecodedFrame(new Uint8Array([0]))
    await tick()
    releaseClose()
    await tick()
    releaseTask()
    await tick()
    return { excessFrames: 5, closes, opens }
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
