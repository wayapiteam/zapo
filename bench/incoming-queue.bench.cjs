const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { execFileSync } = require('node:child_process')
const { setImmediate: nextTurn, setTimeout: delay } = require('node:timers/promises')

const root = process.env.ZAPO_UPGRADE_CANDIDATE_ROOT || path.resolve(__dirname, '..')
const profiles = [
    { active: 8, pending: 4_096 },
    { active: 12, pending: 4_096 },
    { active: 8, pending: 6_144 },
    { active: 12, pending: 6_144 }
]
const byteLimit = 64 * 1024 * 1024

async function until(predicate) {
    const deadline = performance.now() + 10_000
    while (!predicate()) {
        assert.ok(performance.now() < deadline, 'benchmark did not drain')
        await nextTurn()
    }
}

function quantile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function createHarness(handle, resolvePending = () => false) {
    const { WaComms } = require(path.join(root, 'dist/transport/WaComms.js'))
    const { WaNodeTransport } = require(path.join(root, 'dist/transport/node/WaNodeTransport.js'))
    const { createNoopLogger } = require(path.join(root, 'dist/infra/log/types.js'))
    const logger = createNoopLogger()
    const comms = new WaComms(
        {
            noise: {
                isRegistered: true,
                clientStaticKeyPair: { pubKey: new Uint8Array(32), privKey: new Uint8Array(32) }
            }
        },
        logger
    )
    const transport = new WaNodeTransport(logger)
    const state = { resumes: 0, handled: 0, running: 0, peakRunning: 0 }
    // Real codec, preparation and queue; synthetic Noise/network and application I/O.
    comms.started = true
    comms.connected = true
    comms.handlingRequests = true
    comms.noiseSession = { pushWireChunk: async (frame) => [frame] }
    comms.closeSocketAndResume = async () => {
        comms.resumeInFlight = true
        state.resumes++
    }
    comms.stanzaHandler = async () => assert.fail('expected prepared input')
    comms.prepareStanza = async (frame, isCurrent, accountDecodedBytes) => {
        const node = await transport.decodeIncomingFrame(frame, isCurrent, accountDecodedBytes)
        assert.ok(node)
        if (!isCurrent()) return null
        if (resolvePending(node)) return null
        return async () => {
            state.running++
            state.peakRunning = Math.max(state.peakRunning, state.running)
            try {
                await handle(node)
                state.handled++
            } finally {
                state.running--
            }
        }
    }
    return { comms, state }
}

function encode(id, bytes = 4_096, type = 'test') {
    const { encodeBinaryNodeStanza } = require(path.join(root, 'dist/transport/binary/index.js'))
    return encodeBinaryNodeStanza({
        tag: 'notification',
        attrs: { id, type },
        content: new Uint8Array(bytes)
    })
}

async function load(kind) {
    const samples = []
    for (let round = 0; round < 7; round++) {
        global.gc?.()
        const arrivals = []
        const waits = []
        let started = 0
        let finished = 0
        let finish
        const completed = new Promise((resolve) => {
            finish = resolve
        })
        const { comms, state } = createHarness(async (node) => {
            waits.push(performance.now() - arrivals[started++])
            if (kind === 'io') await delay(2)
            else for (let i = 0; i < 8; i++) createHash('sha256').update(node.content).digest()
            if (++finished === 1_024) finish()
        })
        const frame = encode('load')
        const cpu = process.cpuUsage()
        const start = performance.now()
        for (let i = 0; i < 1_024; i++) {
            arrivals.push(performance.now())
            comms.onSocketMessage(frame)
        }
        await comms.frameProcessingQueue
        await completed
        await nextTurn()
        assert.equal(state.handled, 1_024)
        assert.equal(comms.frameHandlerQueue.inFlight(), 0)
        const elapsedMs = performance.now() - start
        const usage = process.cpuUsage(cpu)
        assert.equal(state.resumes, 0)
        if (round >= 2)
            samples.push({
                elapsedMs,
                cpuMs: (usage.user + usage.system) / 1_000,
                p95AdmissionToStartMs: quantile(waits, 0.95),
                peakRunning: state.peakRunning
            })
    }
    return {
        events: 1_024,
        samples: samples.length,
        medianElapsedMs: quantile(
            samples.map((s) => s.elapsedMs),
            0.5
        ),
        medianCpuMs: quantile(
            samples.map((s) => s.cpuMs),
            0.5
        ),
        medianP95AdmissionToStartMs: quantile(
            samples.map((s) => s.p95AdmissionToStartMs),
            0.5
        ),
        peakRunning: Math.max(...samples.map((s) => s.peakRunning))
    }
}

async function fullBacklog(profile) {
    const { WaNodeOrchestrator } = require(
        path.join(root, 'dist/transport/node/WaNodeOrchestrator.js')
    )
    const { encodeBinaryNodeStanza } = require(path.join(root, 'dist/transport/binary/index.js'))
    const { createNoopLogger } = require(path.join(root, 'dist/infra/log/types.js'))
    global.gc?.()
    const before = process.memoryUsage()
    let release
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const outbound = []
    const replies = []
    const orchestrator = new WaNodeOrchestrator({
        logger: createNoopLogger(),
        defaultTimeoutMs: 10_000,
        sendNode: async (node) => {
            outbound.push(node)
        }
    })
    const { comms, state } = createHarness(
        async (node) => {
            if (node.attrs.type !== 'request') return gate
            const reply = await orchestrator.query({
                tag: 'iq',
                attrs: { id: 'query-' + node.attrs.id, type: 'get' }
            })
            replies.push(reply.attrs.id)
        },
        (node) => orchestrator.tryResolvePendingIqResponse(node)
    )
    const count = profile.active + profile.pending
    const start = performance.now()
    try {
        for (let i = 0; i < count; i++)
            comms.onSocketMessage(encode(String(i), 4_096, i < profile.active ? 'request' : 'test'))
        await comms.frameProcessingQueue
        assert.equal(comms.frameHandlerQueue.inFlight(), profile.active)
        assert.equal(comms.frameHandlerQueue.pending(), profile.pending)
        assert.equal(state.resumes, 0)
        assert.equal(outbound.length, profile.active)
        global.gc?.()
        const full = process.memoryUsage()
        const accountedBodyBytes = comms.handlerByteBudget.bytes
        assert.ok(accountedBodyBytes < byteLimit)
        const replyStart = performance.now()
        for (const query of [...outbound].reverse())
            comms.onSocketMessage(
                encodeBinaryNodeStanza({ tag: 'iq', attrs: { id: query.attrs.id, type: 'result' } })
            )
        await until(() => replies.length === profile.active && state.handled === profile.active)
        const replyToSettlementMs = performance.now() - replyStart
        assert.equal(orchestrator.hasPending(), false)
        assert.equal(new Set(replies).size, profile.active)
        assert.equal(state.resumes, 0)
        for (let i = 0; i < profile.active; i++) comms.onSocketMessage(encode('refill-' + i))
        await comms.frameProcessingQueue
        assert.equal(comms.frameHandlerQueue.pending(), profile.pending)
        for (let i = 0; i < 5; i++) comms.onSocketMessage(encode('overflow-' + i))
        await comms.frameProcessingQueue
        await nextTurn()
        assert.equal(state.resumes, 1)
        release()
        await until(
            () =>
                state.handled === count + profile.active && comms.frameHandlerQueue.inFlight() === 0
        )
        assert.equal(comms.handlerByteBudget.bytes, 0)
        return {
            retainedEvents: count,
            payloadBytes: 4_096,
            accountedBodyBytes,
            retainedArrayBuffersDelta: full.arrayBuffers - before.arrayBuffers,
            retainedHeapDelta: full.heapUsed - before.heapUsed,
            fullRssBytes: full.rss,
            resolvedQueriesAtFullBacklog: replies.length,
            replyToSettlementMs,
            admitAndDrainMs: performance.now() - start,
            resumesForFiveExcess: state.resumes
        }
    } finally {
        release()
    }
}

async function byteCap() {
    let release
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const { comms, state } = createHarness(() => gate)
    try {
        let received = 0
        while (state.resumes === 0 && received < 1_100) {
            comms.onSocketMessage(encode(String(received++), 65_536))
            await comms.frameProcessingQueue
        }
        assert.equal(state.resumes, 1)
        const retained = comms.frameHandlerQueue.pending() + comms.frameHandlerQueue.inFlight()
        assert.ok(comms.handlerByteBudget.bytes <= byteLimit)
        const accountedBodyBytes = comms.handlerByteBudget.bytes
        release()
        await until(() => state.handled === retained && comms.frameHandlerQueue.inFlight() === 0)
        assert.equal(comms.handlerByteBudget.bytes, 0)
        return {
            payloadBytes: 65_536,
            retainedEvents: retained,
            accountedBodyBytes,
            resumes: state.resumes
        }
    } finally {
        release()
    }
}

function stage(profile) {
    const directory = mkdtempSync(path.join(tmpdir(), 'zapo-incoming-limits-'))
    try {
        cpSync(path.join(root, 'dist'), path.join(directory, 'dist'), { recursive: true })
        for (const name of ['node_modules', 'spec', 'packages']) {
            symlinkSync(path.join(root, name), path.join(directory, name), 'dir')
        }
        const file = path.join(directory, 'dist/transport/WaComms.js')
        let code = readFileSync(file, 'utf8')
        for (const [name, oldValue, nextValue] of [
            ['WA_FRAME_HANDLER_QUEUE_MAX_SIZE', 4096, profile.pending],
            ['WA_FRAME_HANDLER_MAX_CONCURRENCY', 8, profile.active]
        ]) {
            const needle = `const ${name} = ${oldValue};`
            assert.equal(code.split(needle).length, 2, `unexpected compiled constant: ${name}`)
            code = code.replace(needle, `const ${name} = ${nextValue};`)
        }
        writeFileSync(file, code)
        return { directory, compiledSha256: createHash('sha256').update(code).digest('hex') }
    } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
    }
}

function loopback(directory, profile) {
    const source = readFileSync(path.join(root, 'scripts/upgrade/iq-loopback.test.cjs'), 'utf8')
    const marker = 'for (const options of ['
    assert.equal(source.split(marker).length, 2)
    const cases = [
        { label: 'configured full concurrency', count: profile.active },
        { label: 'configured compressed replies', count: profile.active, compressed: true },
        { label: 'configured ignoreKey', count: profile.active, ignoreMode: 'predicate' },
        { label: 'configured graceful drain', count: profile.active, drain: true }
    ]
    const file = path.join(directory, 'loopback.test.cjs')
    writeFileSync(
        file,
        source.replace(marker, marker + '\n' + cases.map((c) => JSON.stringify(c) + ',').join('\n'))
    )
    return execFileSync(process.execPath, ['--test', '--test-concurrency=1', file], {
        env: { ...process.env, ZAPO_UPGRADE_CANDIDATE_ROOT: directory },
        encoding: 'utf8'
    })
}

async function main() {
    if (process.argv[2] === '--worker') {
        const profile = JSON.parse(process.argv[3])
        const cpu = await load('cpu')
        const io = await load('io')
        const backlog = await fullBacklog(profile)
        const bytes = await byteCap()
        console.log(JSON.stringify({ profile, node: process.version, cpu, io, backlog, bytes }))
        return
    }
    const results = []
    for (let round = 0; round < 2; round++) {
        for (const profile of round === 0 ? profiles : [...profiles].reverse()) {
            const candidate = stage(profile)
            try {
                const output = execFileSync(
                    process.execPath,
                    ['--expose-gc', __filename, '--worker', JSON.stringify(profile)],
                    {
                        env: { ...process.env, ZAPO_UPGRADE_CANDIDATE_ROOT: candidate.directory },
                        encoding: 'utf8'
                    }
                )
                const result = {
                    round,
                    compiledSha256: candidate.compiledSha256,
                    ...JSON.parse(output)
                }
                if (round === 0 && profile.pending === (profile.active === 8 ? 4096 : 6144)) {
                    result.loopbackLog = loopback(candidate.directory, profile)
                }
                results.push(result)
                process.stderr.write(
                    `completed ${profile.active}/${profile.pending}, round ${round + 1}\n`
                )
            } finally {
                rmSync(candidate.directory, { recursive: true, force: true })
            }
        }
    }
    console.log(
        JSON.stringify(
            { root, scope: 'isolated compiled constants; defaults unchanged', results },
            null,
            2
        )
    )
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
