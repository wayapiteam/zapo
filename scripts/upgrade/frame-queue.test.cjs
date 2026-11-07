const assert = require('node:assert/strict')
const test = require('node:test')
const { blockedQueries, overflow } = require('./frame-queue-harness.cjs')

test('five excess frames produce only one socket resume', async () => {
    const observed = await overflow()
    assert.equal(observed.closes, 1)
    assert.equal(observed.opens, 1)
})

test('IQ responses progress before timeout while eight handlers await queries', async () => {
    const observed = await blockedQueries()
    assert.equal(
        observed.beforeTimeout.completed,
        8,
        'queued responses must not wait for query timeouts'
    )
    assert.equal(observed.afterTimeout.timedOut, 0)
})
