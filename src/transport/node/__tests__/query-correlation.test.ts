import assert from 'node:assert/strict'
import test from 'node:test'

import { createNoopLogger } from '@infra/log/types'
import { WA_IQ_TYPES, WA_NODE_TAGS } from '@protocol/constants'
import { WaNodeOrchestrator } from '@transport/node/WaNodeOrchestrator'
import type { BinaryNode } from '@transport/types'

function queryNode(id: string): BinaryNode {
    return { tag: WA_NODE_TAGS.IQ, attrs: { id, type: WA_IQ_TYPES.GET } }
}

function resultNode(id: string): BinaryNode {
    return { tag: WA_NODE_TAGS.IQ, attrs: { id, type: WA_IQ_TYPES.RESULT } }
}

function createHarness(onSend?: (node: BinaryNode) => Promise<void>) {
    const sent: BinaryNode[] = []
    const orchestrator = new WaNodeOrchestrator({
        logger: createNoopLogger(),
        defaultTimeoutMs: 1_000,
        sendNode: async (node) => {
            sent.push(node)
            await onSend?.(node)
        }
    })
    return { orchestrator, sent }
}

async function waitForSent(sent: readonly BinaryNode[], count: number): Promise<void> {
    for (let turn = 0; turn < 100; turn += 1) {
        if (sent.length === count) return
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.fail(`expected ${count} outgoing queries, received ${sent.length}`)
}

for (const settledBy of ['disconnect', 'timeout', 'response'] as const) {
    test(`late send failure after ${settledBy} cannot remove a newer query reusing its id`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        let rejectOldSend = (_error: Error): void => undefined
        let sends = 0
        const { orchestrator, sent } = createHarness(async () => {
            if (++sends === 1) {
                await new Promise<void>((_resolve, reject) => {
                    rejectOldSend = reject
                })
            }
        })
        const request = queryNode('late-send-reused-id')
        const original = orchestrator.query(request, 10).then(
            () => 'response',
            (error: Error) => error.message
        )
        await waitForSent(sent, 1)
        if (settledBy === 'disconnect') orchestrator.clearPending(new Error('disconnect'))
        else if (settledBy === 'timeout') t.mock.timers.tick(10)
        else orchestrator.tryResolvePending(resultNode(request.attrs.id))
        const outcome = await original
        assert.match(outcome, new RegExp(settledBy === 'timeout' ? 'query timeout' : settledBy))

        const fresh = orchestrator.query(request, 100)
        const cleanup = fresh.catch(() => undefined)
        try {
            await waitForSent(sent, 2)
            rejectOldSend(new Error('old connection send failed late'))
            await new Promise<void>((resolve) => setImmediate(resolve))
            assert.equal(orchestrator.hasPending(), true)
            assert.equal(
                orchestrator.tryResolvePendingIqResponse(resultNode(request.attrs.id)),
                true
            )
            assert.equal((await fresh).attrs.id, request.attrs.id)
            t.mock.timers.tick(100)
            assert.equal(orchestrator.hasPending(), false)
        } finally {
            orchestrator.clearPending(new Error('test cleanup'))
            t.mock.timers.tick(100)
            await cleanup
        }
    })
}

test('query is registered before send can deliver an immediate response', async () => {
    const harness = createHarness(async (node) => {
        assert.equal(harness.orchestrator.tryResolvePending(resultNode(node.attrs.id)), true)
    })
    const response = await harness.orchestrator.query(queryNode('immediate'))
    assert.equal(response.attrs.id, 'immediate')
    assert.equal(harness.orchestrator.hasPending(), false)
})

test('eight concurrent queries receive their own responses in reverse arrival order', async () => {
    const { orchestrator, sent } = createHarness()
    const ids = Array.from({ length: 8 }, (_, index) => `reverse-${index}`)
    const queries = ids.map((id) => orchestrator.query(queryNode(id)))
    await waitForSent(sent, ids.length)
    for (const id of [...ids].reverse()) {
        assert.equal(orchestrator.tryResolvePending(resultNode(id)), true)
    }
    const responses = await Promise.all(queries)
    assert.deepEqual(
        responses.map((response) => response.attrs.id),
        ids
    )
    assert.equal(orchestrator.hasPending(), false)
})

test('unknown and missing response ids leave the actual query pending', async () => {
    const { orchestrator, sent } = createHarness()
    const pending = orchestrator.query(queryNode('expected'))
    await waitForSent(sent, 1)
    assert.equal(orchestrator.tryResolvePending(resultNode('unknown')), false)
    assert.equal(
        orchestrator.tryResolvePending({
            tag: WA_NODE_TAGS.IQ,
            attrs: { type: WA_IQ_TYPES.RESULT }
        }),
        false
    )
    assert.equal(orchestrator.hasPending(), true)
    assert.equal(await orchestrator.handleIncomingNode(resultNode('expected')), true)
    assert.equal((await pending).attrs.id, 'expected')
})

test('a duplicate response does not settle a different pending query', async () => {
    const { orchestrator, sent } = createHarness()
    const first = orchestrator.query(queryNode('first'))
    const second = orchestrator.query(queryNode('second'))
    await waitForSent(sent, 2)
    assert.equal(orchestrator.tryResolvePending(resultNode('first')), true)
    assert.equal(orchestrator.tryResolvePending(resultNode('first')), false)
    assert.equal(orchestrator.hasPending(), true)
    assert.equal(orchestrator.tryResolvePending(resultNode('second')), true)
    assert.deepEqual(
        (await Promise.all([first, second])).map((node) => node.attrs.id),
        ['first', 'second']
    )
})

test('a duplicate outgoing id cannot overwrite the original pending query', async () => {
    const { orchestrator, sent } = createHarness()
    const original = orchestrator.query(queryNode('same-id'))
    await waitForSent(sent, 1)
    await assert.rejects(orchestrator.query(queryNode('same-id')), /pending node id collision/)
    assert.equal(sent.length, 1)
    assert.equal(orchestrator.tryResolvePending(resultNode('same-id')), true)
    assert.equal((await original).attrs.id, 'same-id')
})

test('an iq error payload reaches its caller instead of becoming a timeout', async () => {
    const { orchestrator, sent } = createHarness()
    const pending = orchestrator.query(queryNode('server-error'))
    await waitForSent(sent, 1)
    const error: BinaryNode = {
        tag: WA_NODE_TAGS.IQ,
        attrs: { id: 'server-error', type: WA_IQ_TYPES.ERROR },
        content: [{ tag: 'error', attrs: { code: '503', text: 'service-unavailable' } }]
    }
    assert.equal(await orchestrator.handleIncomingNode(error), true)
    assert.deepEqual(await pending, error)
    assert.equal(orchestrator.hasPending(), false)
})

test('a late response after timeout cannot consume a newer query', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { orchestrator, sent } = createHarness()
    const expired = orchestrator.query(queryNode('expired'), 10)
    const rejected = assert.rejects(expired, /query timeout/)
    await waitForSent(sent, 1)
    t.mock.timers.tick(10)
    await rejected
    const fresh = orchestrator.query(queryNode('fresh'), 100)
    await waitForSent(sent, 2)
    assert.equal(orchestrator.tryResolvePending(resultNode('expired')), false)
    assert.equal(orchestrator.hasPending(), true)
    assert.equal(orchestrator.tryResolvePending(resultNode('fresh')), true)
    assert.equal((await fresh).attrs.id, 'fresh')
})

test('failed send cancels its timer before the same id is reused', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let attempts = 0
    const { orchestrator, sent } = createHarness(async () => {
        if (++attempts === 1) throw new Error('synthetic send failure')
    })
    await assert.rejects(orchestrator.query(queryNode('retry-id'), 10), /synthetic send failure/)
    assert.equal(orchestrator.hasPending(), false)
    const fresh = orchestrator.query(queryNode('retry-id'), 100)
    await waitForSent(sent, 2)
    t.mock.timers.tick(10)
    assert.equal(orchestrator.hasPending(), true)
    assert.equal(orchestrator.tryResolvePending(resultNode('retry-id')), true)
    assert.equal((await fresh).attrs.id, 'retry-id')
})

test('successful response cancels its timer before the same id is reused', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { orchestrator, sent } = createHarness()
    const first = orchestrator.query(queryNode('reused-id'), 10)
    await waitForSent(sent, 1)
    orchestrator.tryResolvePending(resultNode('reused-id'))
    await first
    const fresh = orchestrator.query(queryNode('reused-id'), 100)
    await waitForSent(sent, 2)
    t.mock.timers.tick(10)
    assert.equal(orchestrator.hasPending(), true)
    orchestrator.tryResolvePending(resultNode('reused-id'))
    await fresh
})

test('connection cancellation rejects every waiter and cancels their old timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { orchestrator, sent } = createHarness()
    const ids = ['cancel-a', 'cancel-b', 'cancel-c']
    const rejected = ids.map((id) =>
        assert.rejects(orchestrator.query(queryNode(id), 10), /connection replaced/)
    )
    await waitForSent(sent, 3)
    orchestrator.clearPending(new Error('connection replaced'))
    await Promise.all(rejected)
    assert.equal(orchestrator.hasPending(), false)
    assert.doesNotThrow(() => orchestrator.clearPending(new Error('already cleared')))
    const fresh = orchestrator.query(queryNode('cancel-a'), 100)
    await waitForSent(sent, 4)
    t.mock.timers.tick(10)
    assert.equal(orchestrator.hasPending(), true)
    assert.equal(orchestrator.tryResolvePending(resultNode('cancel-b')), false)
    orchestrator.tryResolvePending(resultNode('cancel-a'))
    assert.equal((await fresh).attrs.id, 'cancel-a')
})

test('early resolution accepts only a matching IQ result/error for an IQ request', async () => {
    const { orchestrator, sent } = createHarness()
    const iq = orchestrator.query(queryNode('early-iq'))
    const other = orchestrator.query({ tag: 'message', attrs: { id: 'publish-id' } })
    await waitForSent(sent, 2)
    assert.equal(orchestrator.tryResolvePendingIqResponse(resultNode('unknown')), false)
    assert.equal(orchestrator.tryResolvePendingIqResponse(queryNode('early-iq')), false)
    assert.equal(
        orchestrator.tryResolvePendingIqResponse({
            tag: 'receipt',
            attrs: { id: 'early-iq', type: 'retry' }
        }),
        false
    )
    assert.equal(orchestrator.tryResolvePendingIqResponse(resultNode('publish-id')), false)
    assert.equal(orchestrator.tryResolvePendingIqResponse(resultNode('early-iq')), true)
    assert.equal((await iq).attrs.id, 'early-iq')
    assert.equal(orchestrator.hasPending(), true)
    orchestrator.tryResolvePending({ tag: 'ack', attrs: { id: 'publish-id' } })
    assert.equal((await other).tag, 'ack')
})
