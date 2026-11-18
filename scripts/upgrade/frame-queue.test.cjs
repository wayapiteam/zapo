const assert = require('node:assert/strict')
const test = require('node:test')
const { blockedQueries, overflow } = require('./frame-queue-harness.cjs')

test('twelve active and 4096 pending frames admit no extra work and resume only once', async () => {
    const observed = await overflow()
    assert.deepEqual(observed.atCapacity, { inFlight: 12, pending: 4096 })
    assert.equal(observed.closes, 1)
    assert.equal(observed.opens, 1)
})

function useClock(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    return { advanceTime: (milliseconds) => t.mock.timers.tick(milliseconds) }
}

for (const count of [7, 11]) {
    test(`${count} waiting handlers leave capacity for out-of-order responses`, async (t) => {
        const observed = await blockedQueries({ ...useClock(t), count, reverse: true })
        assert.equal(observed.beforeTimeout.completed, count)
        assert.equal(observed.afterTimeout.timedOut, 0)
        assert.equal(observed.resumes, 0)
        assert.equal(observed.hasPending, false)
    })
}

for (const count of [8, 12]) {
    test(`IQ responses progress before timeout while ${count} handlers await queries`, async (t) => {
        const observed = await blockedQueries({ ...useClock(t), count })
        assert.equal(
            observed.beforeTimeout.completed,
            count,
            'responses must not wait for timeouts'
        )
        assert.equal(observed.afterTimeout.timedOut, 0)
        assert.equal(observed.resumes, 0)
    })

    test(`${count} waiting handlers receive mixed result/error responses in reverse order`, async (t) => {
        const observed = await blockedQueries({
            ...useClock(t),
            count,
            reverse: true,
            mixedErrors: true
        })
        assert.equal(observed.beforeTimeout.completed, count)
        assert.equal(observed.afterTimeout.timedOut, 0)
        assert.equal(
            observed.beforeTimeout.responses.filter((node) => node.type === 'error').length,
            count / 2
        )
        for (const response of observed.beforeTimeout.responses)
            assert.equal(response.id, response.requested)
        assert.equal(observed.hasPending, false)
    })

    test(`unknown, missing and duplicate ids cannot replace ${count} expected responses`, async (t) => {
        const observed = await blockedQueries({
            ...useClock(t),
            count,
            unrelated: true,
            duplicates: true
        })
        assert.deepEqual(observed.beforeReplies, { completed: 0, timedOut: 0 })
        assert.equal(observed.beforeTimeout.completed, count)
        assert.equal(observed.afterTimeout.timedOut, 0)
        assert.equal(observed.unmatched, count + 2)
        assert.equal(observed.hasPending, false)
    })

    test(`matched responses progress with ${count} waiting queries and 4096 ordinary frames`, async (t) => {
        const observed = await blockedQueries({ ...useClock(t), count, normalBacklog: 4096 })
        if (count === 12)
            assert.deepEqual(observed.backlogBeforeReplies, { inFlight: 12, pending: 4096 })
        assert.equal(observed.beforeTimeout.completed, count)
        assert.equal(observed.afterTimeout.timedOut, 0)
        assert.equal(observed.resumes, 0, 'matched responses must not overflow the ordinary queue')
        assert.equal(observed.normalProcessed, 4096, 'ordinary work must survive saturation')
        assert.equal(observed.hasPending, false)
    })

    test(`one missing response times out without delaying the other ${count - 1}`, async (t) => {
        const observed = await blockedQueries({ ...useClock(t), count, omitLast: true })
        assert.equal(observed.beforeTimeout.completed, count - 1)
        assert.deepEqual(observed.afterTimeout, { completed: count - 1, timedOut: 1 })
        assert.equal(observed.hasPending, false)
    })
}
