const assert = require('node:assert/strict')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { setImmediate: nextTurn } = require('node:timers/promises')

const root = process.env.ZAPO_UPGRADE_CANDIDATE_ROOT || path.resolve(__dirname, '../..')
const { WaComms } = require(path.join(root, 'dist/transport/WaComms.js'))
const { WaNodeTransport } = require(path.join(root, 'dist/transport/node/WaNodeTransport.js'))
const { WaNodeOrchestrator } = require(path.join(root, 'dist/transport/node/WaNodeOrchestrator.js'))
const { encodeBinaryNodeStanza } = require(path.join(root, 'dist/transport/binary/index.js'))
const { createNoopLogger } = require(path.join(root, 'dist/infra/log/types.js'))

async function until(predicate) {
    const deadline = performance.now() + 5_000
    while (!predicate()) {
        assert.ok(performance.now() < deadline, 'benchmark did not drain')
        await nextTurn()
    }
}

function createHarness() {
    const logger = createNoopLogger()
    const comms = new WaComms(
        {
            url: 'wss://example.invalid',
            noise: {
                isRegistered: true,
                clientStaticKeyPair: { pubKey: new Uint8Array(32), privKey: new Uint8Array(32) }
            }
        },
        logger
    )
    const transport = new WaNodeTransport(logger)
    const outbound = []
    const state = { normal: 0, finished: 0, completed: 0, timedOut: 0, resumes: 0, peakHeap: 0 }
    const orchestrator = new WaNodeOrchestrator({
        logger,
        defaultTimeoutMs: 100,
        sendNode: async (node) => {
            outbound.push(node)
        }
    })
    const handle = async (node) => {
        if (await orchestrator.handleIncomingNode(node)) return
        if (node.attrs.type !== 'query-work') {
            state.normal++
            if (state.normal % 128 === 0) {
                state.peakHeap = Math.max(state.peakHeap, process.memoryUsage().heapUsed)
            }
            return
        }
        try {
            await orchestrator.query({ tag: 'iq', attrs: { id: node.attrs.id, type: 'get' } })
            state.completed++
        } catch (error) {
            assert.match(error.message, /query timeout/)
            state.timedOut++
        } finally {
            state.finished++
        }
    }
    comms.started = true
    comms.connected = true
    comms.handlingRequests = true
    // Component benchmark: binary codec and real queues, synthetic Noise/network boundaries.
    comms.noiseSession = { pushWireChunk: async (frame) => [frame] }
    comms.closeSocketAndResume = async () => {
        state.resumes++
    }
    comms.stanzaHandler = (frame) => transport.dispatchIncomingFrame(frame, handle)
    if (typeof transport.decodeIncomingFrame === 'function') {
        comms.prepareStanza = async (frame, isCurrent, accountDecodedBytes) => {
            const node = await transport.decodeIncomingFrame(frame, isCurrent, accountDecodedBytes)
            if (!node || !isCurrent()) return null
            if (orchestrator.tryResolvePendingIqResponse(node)) return null
            return () => handle(node)
        }
    }
    return { comms, outbound, state }
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

async function normalLoad() {
    const { comms, state } = createHarness()
    const frame = encodeBinaryNodeStanza({
        tag: 'notification',
        attrs: { id: 'normal', type: 'test' },
        content: new Uint8Array(128)
    })
    const samples = []
    for (let round = 0; round < 10; round++) {
        global.gc?.()
        const target = state.normal + 2_000
        const cpu = process.cpuUsage()
        const start = performance.now()
        for (let i = 0; i < 2_000; i++) comms.onSocketMessage(frame)
        state.peakHeap = Math.max(state.peakHeap, process.memoryUsage().heapUsed)
        await comms.frameProcessingQueue
        await until(() => state.normal === target && comms.frameHandlerQueue.inFlight() === 0)
        const elapsedMs = performance.now() - start
        const usage = process.cpuUsage(cpu)
        if (round >= 2) samples.push({ elapsedMs, cpuMs: (usage.user + usage.system) / 1_000 })
    }
    assert.equal(state.resumes, 0)
    return {
        framesPerSample: 2_000,
        measuredSamples: samples.length,
        medianElapsedMs: median(samples.map((s) => s.elapsedMs)),
        medianCpuMs: median(samples.map((s) => s.cpuMs)),
        peakSampledHeapBytes: state.peakHeap,
        processMaxRssKiB: process.resourceUsage().maxRSS,
        resumes: state.resumes
    }
}

async function saturatedQueries() {
    const samples = []
    for (let round = 0; round < 5; round++) {
        const { comms, outbound, state } = createHarness()
        for (let i = 0; i < 8; i++) {
            comms.onSocketMessage(
                encodeBinaryNodeStanza({
                    tag: 'notification',
                    attrs: { id: String(i), type: 'query-work' }
                })
            )
        }
        await until(() => outbound.length === 8)
        const start = performance.now()
        for (const node of [...outbound].reverse()) {
            comms.onSocketMessage(
                encodeBinaryNodeStanza({ tag: 'iq', attrs: { id: node.attrs.id, type: 'result' } })
            )
        }
        await until(() => state.finished === 8)
        samples.push({
            elapsedMs: performance.now() - start,
            completed: state.completed,
            timedOut: state.timedOut
        })
        assert.equal(state.resumes, 0)
    }
    return {
        medianReplyToSettlementMs: median(samples.map((s) => s.elapsedMs)),
        completed: samples.reduce((sum, s) => sum + s.completed, 0),
        timedOut: samples.reduce((sum, s) => sum + s.timedOut, 0),
        samples
    }
}

async function main() {
    const normal = await normalLoad()
    const saturated = await saturatedQueries()
    console.log(JSON.stringify({ root, node: process.version, normal, saturated }, null, 2))
}

main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
})
