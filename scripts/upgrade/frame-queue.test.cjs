const assert = require('node:assert/strict')
const test = require('node:test')
const { blockedQueries, overflow } = require('./frame-queue-harness.cjs')

test('five excess frames produce only one socket resume', async () => {
    const observed = await overflow()
    assert.equal(observed.closes, 1)
    assert.equal(observed.opens, 1)
})

function useClock(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    return { advanceTime: (milliseconds) => t.mock.timers.tick(milliseconds) }
}

test('seven waiting handlers leave a slot for out-of-order responses', async (t) => {
    const observed = await blockedQueries({ ...useClock(t), count: 7, reverse: true })
    assert.equal(observed.beforeTimeout.completed, 7)
    assert.equal(observed.afterTimeout.timedOut, 0)
    assert.equal(observed.resumes, 0)
    assert.equal(observed.hasPending, false)
})

test('IQ responses progress before timeout while eight handlers await queries', async (t) => {
    const observed = await blockedQueries(useClock(t))
    assert.equal(
        observed.beforeTimeout.completed,
        8,
        'queued responses must not wait for query timeouts'
    )
    assert.equal(observed.afterTimeout.timedOut, 0)
    assert.equal(observed.resumes, 0)
})

test('eight waiting handlers receive mixed result/error responses in reverse order', async (t) => {
    const observed = await blockedQueries({ ...useClock(t), reverse: true, mixedErrors: true })
    assert.equal(observed.beforeTimeout.completed, 8)
    assert.equal(observed.afterTimeout.timedOut, 0)
    assert.equal(observed.beforeTimeout.responses.filter((node) => node.type === 'error').length, 4)
    for (const response of observed.beforeTimeout.responses) {
        assert.equal(response.id, response.requested)
    }
    assert.equal(observed.hasPending, false)
})

test('unknown, missing and duplicate ids cannot replace the eight expected responses', async (t) => {
    const observed = await blockedQueries({ ...useClock(t), unrelated: true, duplicates: true })
    assert.deepEqual(observed.beforeReplies, { completed: 0, timedOut: 0 })
    assert.equal(observed.beforeTimeout.completed, 8)
    assert.equal(observed.afterTimeout.timedOut, 0)
    assert.equal(observed.unmatched, 10)
    assert.equal(observed.hasPending, false)
})

test('matched responses progress with eight handlers busy and 4096 ordinary frames queued', async (t) => {
    const observed = await blockedQueries({ ...useClock(t), normalBacklog: 4096 })
    assert.equal(observed.beforeTimeout.completed, 8)
    assert.equal(observed.afterTimeout.timedOut, 0)
    assert.equal(observed.resumes, 0, 'matched responses must not overflow the ordinary queue')
    assert.equal(observed.normalProcessed, 4096, 'all ordinary work must survive the saturation')
    assert.equal(observed.hasPending, false)
})

test('one truly missing response times out without delaying the other seven', async (t) => {
    const observed = await blockedQueries({ ...useClock(t), omitLast: true })
    assert.equal(observed.beforeTimeout.completed, 7)
    assert.deepEqual(observed.afterTimeout, { completed: 7, timedOut: 1 })
    assert.equal(observed.hasPending, false)
})
