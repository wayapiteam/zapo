import assert from 'node:assert/strict'
import test from 'node:test'

import { BoundedTaskQueue, BoundedTaskQueueFullError } from '@infra/perf/BoundedTaskQueue'

test('bounded task queue enforces queue size and concurrency', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const queue = new BoundedTaskQueue(2, 1)
    const order: string[] = []

    const a = queue.enqueue(async () => {
        order.push('a:start')
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('a:end')
        return 'a'
    })
    const b = queue.enqueue(async () => {
        order.push('b')
        return 'b'
    })
    const c = queue.enqueue(async () => {
        order.push('c')
        return 'c'
    })

    await assert.rejects(
        () => queue.enqueue(async () => 'overflow'),
        (error) => error instanceof BoundedTaskQueueFullError
    )

    t.mock.timers.tick(5)
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(await a, 'a')
    assert.equal(await b, 'b')
    assert.equal(await c, 'c')
    assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c'])
})

test('bounded task queue validates constructor params', () => {
    assert.throws(() => new BoundedTaskQueue(0, 1), /maxQueueSize must be > 0/)
    assert.throws(() => new BoundedTaskQueue(1, 0), /maxConcurrency must be > 0/)
})

test('a rejected task releases its slot and preserves the queued work', async () => {
    const queue = new BoundedTaskQueue(2, 1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const order: string[] = []
    const first = queue.enqueue(async () => {
        await gate
        throw new Error('synthetic handler failure')
    })
    const rejected = assert.rejects(first, /synthetic handler failure/)
    const rest = ['second', 'third'].map((name) =>
        queue.enqueue(async () => {
            order.push(name)
            return name
        })
    )
    assert.equal(queue.inFlight(), 1)
    assert.equal(queue.pending(), 2)
    release()
    await rejected
    assert.deepEqual(await Promise.all(rest), ['second', 'third'])
    assert.deepEqual(order, ['second', 'third'])
    assert.equal(await queue.enqueue(async () => 'recovered'), 'recovered')
})

test('eight running tasks and 4096 waiting tasks drain without drops or reordering', async () => {
    const queue = new BoundedTaskQueue(4_096, 8)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const started: number[] = []
    const tasks = Array.from({ length: 8 + 4_096 }, (_, index) =>
        queue.enqueue(async () => {
            started.push(index)
            await gate
            return index
        })
    )
    try {
        assert.equal(queue.inFlight(), 8)
        assert.equal(queue.pending(), 4_096)
        assert.equal(started.length, 8)
        await assert.rejects(
            queue.enqueue(async () => -1),
            BoundedTaskQueueFullError
        )
    } finally {
        release()
    }
    const expected = Array.from({ length: tasks.length }, (_, index) => index)
    assert.deepEqual(await Promise.all(tasks), expected)
    assert.deepEqual(started, expected)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(queue.inFlight(), 0)
    assert.equal(queue.pending(), 0)
})
