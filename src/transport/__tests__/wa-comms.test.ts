import assert from 'node:assert/strict'
import test from 'node:test'

import { createNoopLogger } from '@infra/log/types'
import { WaNoiseSession } from '@transport/noise/WaNoiseSession'
import type { RawWebSocketConstructor, WaStanzaPreparer } from '@transport/types'
import { WaComms } from '@transport/WaComms'

const NOOP_SOCKET_CTOR = class {
    public binaryType = 'arraybuffer'
    public readyState = 0
    public onopen: unknown = null
    public onclose: unknown = null
    public onerror: unknown = null
    public onmessage: unknown = null
    public close(): void {
        return
    }
    public send(): void {
        return
    }
} as unknown as RawWebSocketConstructor

function createComms(logger = createNoopLogger()): WaComms {
    return new WaComms(
        {
            urls: ['wss://example.invalid/ws'],
            rawWebSocketConstructor: NOOP_SOCKET_CTOR,
            noise: {
                clientStaticKeyPair: {
                    pubKey: new Uint8Array(32),
                    privKey: new Uint8Array(32)
                },
                isRegistered: false
            }
        },
        logger
    )
}

test('closeSocketAndResume does not revive a comms that was never started', async () => {
    const comms = createComms()
    assert.equal(comms.getCommsState().started, false)

    await comms.closeSocketAndResume()

    assert.equal(comms.getCommsState().started, false)
    assert.equal(comms.getCommsState().connected, false)
})

test('closeSocketAndResume does not revive a comms after stopComms', async () => {
    const comms = createComms()
    await comms.stopComms()

    await comms.closeSocketAndResume()

    assert.equal(comms.getCommsState().started, false)
    assert.equal(comms.getCommsState().connected, false)
})

interface CommsTestState {
    started: boolean
    connected: boolean
    handlingRequests: boolean
    resumeInFlight: boolean
    connectionGeneration: number
    stanzaHandler: (frame: Uint8Array) => Promise<void>
    inflateFrame: ((frame: Uint8Array) => Promise<Uint8Array>) | null
    noiseSession: object | null
    frameProcessingQueue: Promise<void>
    prepareStanza: WaStanzaPreparer | null
    wireInputBudget: { count: number; bytes: number }
    handlerByteBudget: { bytes: number }
    routeDecodedFrames: (frames: readonly Uint8Array[]) => Promise<void>
    onSocketMessage: (payload: Uint8Array) => void
    onSocketOpened: () => Promise<void>
    processSocketPayload: (session: object, payload: Uint8Array) => Promise<void>
    scheduleDecodedFrame: (frame: Uint8Array) => void
    resetConnectionState: (options: Record<string, boolean>) => void
}

function stateOf(comms: WaComms): CommsTestState {
    return comms as unknown as CommsTestState
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((release) => {
        resolve = release
    })
    return { promise, resolve }
}

async function flushTasks(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
}

test('queued callbacks from an old generation cannot run on the resumed connection', async () => {
    const state = stateOf(createComms())
    const gate = deferred<void>()
    const delivered: number[] = []
    state.handlingRequests = true
    state.stanzaHandler = async (frame) => {
        delivered.push(frame[0])
        if (frame[0] < 8) await gate.promise
    }
    for (let index = 0; index < 9; index++) state.scheduleDecodedFrame(new Uint8Array([index]))
    await flushTasks()
    state.resetConnectionState({
        started: true,
        connected: false,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    state.scheduleDecodedFrame(new Uint8Array([9]))
    gate.resolve()
    await flushTasks()
    assert.deepEqual(delivered, [0, 1, 2, 3, 4, 5, 6, 7, 9])
})

test('a frame finishing async inflation after reset cannot reach the new connection', async () => {
    const state = stateOf(createComms())
    const inflated = deferred<Uint8Array>()
    const delivered: number[] = []
    state.handlingRequests = true
    state.inflateFrame = () => inflated.promise
    state.stanzaHandler = async (frame) => {
        delivered.push(frame[0])
    }
    state.scheduleDecodedFrame(new Uint8Array([1]))
    await flushTasks()
    state.resetConnectionState({
        started: true,
        connected: false,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    inflated.resolve(new Uint8Array([1]))
    await flushTasks()
    assert.deepEqual(delivered, [])
})

test('a replaced Noise session cannot dispatch frames returned by its pending decode', async () => {
    const state = stateOf(createComms())
    const decoded = deferred<readonly Uint8Array[]>()
    const oldSession = { pushWireChunk: () => decoded.promise }
    const delivered: number[] = []
    state.handlingRequests = true
    state.noiseSession = oldSession
    state.stanzaHandler = async (frame) => {
        delivered.push(frame[0])
    }
    const processing = state.processSocketPayload(oldSession, new Uint8Array([1]))
    state.noiseSession = {}
    state.connectionGeneration++
    decoded.resolve([new Uint8Array([1])])
    await processing
    await flushTasks()
    assert.deepEqual(delivered, [])
})

test('wire admission bounds queued chunks and starts a single overflow recovery', async () => {
    const comms = createComms()
    const state = stateOf(comms)
    const gate = deferred<readonly Uint8Array[]>()
    state.started = true
    state.noiseSession = { pushWireChunk: () => gate.promise }
    let resumes = 0
    comms.closeSocketAndResume = async () => {
        resumes++
        state.resumeInFlight = true
    }
    for (let index = 0; index < 8 + 4_096 + 5; index++) {
        state.onSocketMessage(new Uint8Array([1]))
    }
    gate.resolve([])
    await state.frameProcessingQueue
    assert.equal(resumes, 1)
})

test('wire admission rejects a chunk exceeding the byte budget without decoding it', async () => {
    const comms = createComms()
    const state = stateOf(comms)
    let decoded = 0
    let resumes = 0
    state.started = true
    state.noiseSession = {
        pushWireChunk: async () => {
            decoded++
            return []
        }
    }
    comms.closeSocketAndResume = async () => {
        resumes++
        state.resumeInFlight = true
    }
    state.onSocketMessage(new Uint8Array(64 * 1024 * 1024 + 1))
    await state.frameProcessingQueue
    assert.equal(decoded, 0)
    assert.equal(resumes, 1)
})

test('preparation finishing after reset cannot enqueue old work or block the new generation', async () => {
    const state = stateOf(createComms())
    const gate = deferred<void>()
    const delivered: number[] = []
    state.connected = true
    state.handlingRequests = true
    state.stanzaHandler = async () => undefined
    state.prepareStanza = async (frame) => {
        if (frame[0] === 1) await gate.promise
        return () => {
            delivered.push(frame[0])
        }
    }
    const old = state.routeDecodedFrames([new Uint8Array([1])])
    state.resetConnectionState({
        started: true,
        connected: true,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    await state.routeDecodedFrames([new Uint8Array([2])])
    await flushTasks()
    assert.deepEqual(delivered, [2])
    gate.resolve()
    await old
    await flushTasks()
    assert.deepEqual(delivered, [2])
})

test('old wire completions release their own budget after a generation reset', async () => {
    const state = stateOf(createComms())
    const gate = deferred<readonly Uint8Array[]>()
    state.started = true
    state.noiseSession = { pushWireChunk: () => gate.promise, onSocketClosed: () => undefined }
    state.onSocketMessage(new Uint8Array([1]))
    await flushTasks()
    const old = state.frameProcessingQueue
    state.resetConnectionState({
        started: true,
        connected: false,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    state.noiseSession = { pushWireChunk: async () => [] }
    state.onSocketMessage(new Uint8Array([2]))
    await state.frameProcessingQueue
    gate.resolve([])
    await old
    assert.deepEqual(state.wireInputBudget, { count: 0, bytes: 0 })
})

test('overflow rejection from a replaced generation cannot resume the new socket', async () => {
    const comms = createComms()
    const state = stateOf(comms)
    const gate = deferred<void>()
    state.started = true
    state.handlingRequests = true
    state.stanzaHandler = () => gate.promise
    let resumes = 0
    comms.closeSocketAndResume = async () => {
        resumes++
    }
    for (let index = 0; index < 8 + 4_096 + 1; index++) {
        state.scheduleDecodedFrame(new Uint8Array([1]))
    }
    state.resetConnectionState({
        started: true,
        connected: false,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    gate.resolve()
    await flushTasks()
    assert.equal(resumes, 0)
})

test('a full old handler queue cannot consume the new generation capacity', async () => {
    const comms = createComms()
    const state = stateOf(comms)
    const gate = deferred<void>()
    const delivered: number[] = []
    state.started = true
    state.handlingRequests = true
    state.stanzaHandler = async (frame) => {
        delivered.push(frame[0])
        if (frame[0] === 1) await gate.promise
    }
    let resumes = 0
    comms.closeSocketAndResume = async () => {
        resumes++
    }
    for (let index = 0; index < 8 + 4_096; index++) {
        state.scheduleDecodedFrame(new Uint8Array([1]))
    }
    state.resetConnectionState({
        started: true,
        connected: true,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    state.scheduleDecodedFrame(new Uint8Array([2]))
    try {
        await flushTasks()
        assert.equal(delivered.includes(2), true)
        assert.equal(resumes, 0)
        assert.equal(delivered.filter((id) => id === 1).length, 8)
    } finally {
        gate.resolve()
        await flushTasks()
    }
})

test('buffered post-handshake preparation is ordered before later wire payloads', async (t) => {
    const state = stateOf(createComms())
    const gate = deferred<void>()
    const events: string[] = []
    state.handlingRequests = true
    state.stanzaHandler = async () => undefined
    state.prepareStanza = async (frame) => {
        events.push('prepare-' + frame[0])
        if (frame[0] === 1) await gate.promise
        return () => {
            events.push('handler-' + frame[0])
        }
    }
    t.mock.method(WaNoiseSession.prototype, 'start', async () => undefined)
    t.mock.method(WaNoiseSession.prototype, 'pushWireChunk', async (chunk: Uint8Array) => [
        new Uint8Array([chunk.length === 0 ? 1 : 2])
    ])
    const opening = state.onSocketOpened()
    await flushTasks()
    state.onSocketMessage(new Uint8Array([2]))
    try {
        await flushTasks()
        assert.deepEqual(events, ['prepare-1'])
    } finally {
        gate.resolve()
        await opening
        await state.frameProcessingQueue
    }
    await flushTasks()
    assert.deepEqual(events, ['prepare-1', 'handler-1', 'prepare-2', 'handler-2'])
})

test('a running external prepared callback still reports its error after replacement', async () => {
    const errors: unknown[] = []
    const state = stateOf(
        createComms({
            ...createNoopLogger(),
            error: (_message, context) => errors.push(context?.message)
        })
    )
    const gate = deferred<void>()
    state.connected = true
    state.handlingRequests = true
    state.stanzaHandler = async () => undefined
    state.prepareStanza = async () => async () => {
        await gate.promise
        throw new Error('late external callback failure')
    }
    await state.routeDecodedFrames([new Uint8Array([1])])
    state.resetConnectionState({
        started: true,
        connected: true,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    gate.resolve()
    await flushTasks()
    assert.deepEqual(errors, ['late external callback failure'])
})

test('prepared callbacks are charged for decoded bytes, not only compressed wire size', async () => {
    const comms = createComms()
    const state = stateOf(comms)
    const gate = deferred<void>()
    state.connected = true
    state.handlingRequests = true
    state.stanzaHandler = async () => undefined
    state.prepareStanza = async (_frame, _isCurrent, accountDecodedBytes) => {
        accountDecodedBytes(16 * 1024 * 1024)
        return () => gate.promise
    }
    let resumes = 0
    comms.closeSocketAndResume = async () => {
        resumes++
        state.resumeInFlight = true
    }
    try {
        await state.routeDecodedFrames(Array.from({ length: 5 }, () => new Uint8Array([1])))
        assert.equal(state.handlerByteBudget.bytes, 64 * 1024 * 1024)
        assert.equal(resumes, 1)
    } finally {
        gate.resolve()
        await flushTasks()
    }
    assert.equal(state.handlerByteBudget.bytes, 0)
})

test('pending prepared byte reservations are released on generation cancellation', async () => {
    const state = stateOf(createComms())
    const gate = deferred<void>()
    state.connected = true
    state.handlingRequests = true
    state.stanzaHandler = async () => undefined
    state.prepareStanza = async (_frame, _isCurrent, accountDecodedBytes) => {
        accountDecodedBytes(1024)
        return () => gate.promise
    }
    await state.routeDecodedFrames(Array.from({ length: 12 }, () => new Uint8Array([1])))
    const oldBudget = state.handlerByteBudget
    assert.equal(oldBudget.bytes, 12 * 1024)
    state.resetConnectionState({
        started: true,
        connected: true,
        handlingRequests: true,
        preventRetry: false,
        resumeInFlight: false
    })
    await flushTasks()
    assert.equal(oldBudget.bytes, 8 * 1024, 'only running callbacks retain their old reservation')
    assert.equal(state.handlerByteBudget.bytes, 0)
    gate.resolve()
    await flushTasks()
    assert.equal(oldBudget.bytes, 0)
    assert.equal(state.handlerByteBudget.bytes, 0)
})
