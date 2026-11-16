import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { createNoopLogger } from '@infra/log/types'
import { encodeBinaryNode, encodeBinaryNodeStanza } from '@transport/binary'
import { WaNodeOrchestrator } from '@transport/node/WaNodeOrchestrator'
import { WaNodeTransport } from '@transport/node/WaNodeTransport'
import type { BinaryNode } from '@transport/types'

const RESPONSE: BinaryNode = { tag: 'iq', attrs: { id: 'prepared-id', type: 'result' } }

test('prepared decoding emits frame/node once and legacy dispatch still awaits its handler', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    const events: string[] = []
    transport.on('frame_in', () => events.push('frame'))
    transport.on('node_in', () => events.push('node'))
    await transport.dispatchIncomingFrame(encodeBinaryNodeStanza(RESPONSE), async (node) => {
        assert.deepEqual(node, RESPONSE)
        events.push('handler')
        await Promise.resolve()
        events.push('done')
    })
    assert.deepEqual(events, ['frame', 'node', 'handler', 'done'])
})

test('prepared decoding preserves compressed IQ payloads', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    const compressed = gzipSync(encodeBinaryNode(RESPONSE))
    const frame = new Uint8Array(1 + compressed.length)
    frame[0] = 0x02
    frame.set(compressed, 1)
    assert.deepEqual(await transport.decodeIncomingFrame(frame, () => true), RESPONSE)
})

test('compressed decoding reports the expanded stanza size for queue accounting', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    const body = encodeBinaryNode({ ...RESPONSE, content: new Uint8Array(1024 * 1024) })
    const compressed = gzipSync(body)
    const frame = new Uint8Array(1 + compressed.length)
    frame[0] = 0x02
    frame.set(compressed, 1)
    let accounted = 0
    const decoded = await transport.decodeIncomingFrame(
        frame,
        () => true,
        (bytes) => {
            accounted = bytes
        }
    )
    assert.ok(decoded)
    assert.equal(accounted, body.byteLength)
    assert.ok(accounted > frame.byteLength * 100)
})

test('a generation replaced during decode cannot emit a node or return a reply', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    let current = true
    let frames = 0
    let nodes = 0
    transport.on('frame_in', () => frames++)
    transport.on('node_in', () => nodes++)
    const pending = transport.decodeIncomingFrame(encodeBinaryNodeStanza(RESPONSE), () => current)
    current = false
    assert.equal(await pending, null)
    assert.equal(frames, 1)
    assert.equal(nodes, 0)
    assert.equal(
        await transport.decodeIncomingFrame(encodeBinaryNodeStanza(RESPONSE), () => false),
        null
    )
    assert.equal(frames, 1)
})

test('invalid current input emits one decode error and never dispatches business work', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    let errors = 0
    let handled = 0
    transport.on('decode_error', () => errors++)
    await transport.dispatchIncomingFrame(new Uint8Array([255]), () => {
        handled++
    })
    assert.equal(errors, 1)
    assert.equal(handled, 0)
})

test('invalid input finishing after generation replacement does not report a current error', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    let current = true
    let errors = 0
    transport.on('decode_error', () => errors++)
    const pending = transport.decodeIncomingFrame(new Uint8Array([255]), () => current)
    current = false
    assert.equal(await pending, null)
    assert.equal(errors, 0)
})

test('an old decoded reply cannot consume a new query reusing the same id', async () => {
    const transport = new WaNodeTransport(createNoopLogger())
    const orchestrator = new WaNodeOrchestrator({
        logger: createNoopLogger(),
        sendNode: async () => undefined
    })
    const request: BinaryNode = { tag: 'iq', attrs: { id: RESPONSE.attrs.id, type: 'get' } }
    const old = orchestrator.query(request)
    const rejected = assert.rejects(old, /connection replaced/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    let oldIsCurrent = true
    const oldDecode = transport.decodeIncomingFrame(
        encodeBinaryNodeStanza(RESPONSE),
        () => oldIsCurrent
    )
    oldIsCurrent = false
    orchestrator.clearPending(new Error('connection replaced'))
    await rejected
    const fresh = orchestrator.query(request)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(await oldDecode, null)
    assert.equal(orchestrator.hasPending(), true)
    const response = await transport.decodeIncomingFrame(
        encodeBinaryNodeStanza(RESPONSE),
        () => true
    )
    assert.ok(response)
    assert.equal(orchestrator.tryResolvePendingIqResponse(response), true)
    assert.equal((await fresh).attrs.id, RESPONSE.attrs.id)
})
