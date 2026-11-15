const assert = require('node:assert/strict')
const { setImmediate: nextTurn } = require('node:timers/promises')
const path = require('node:path')
const test = require('node:test')

const root = process.env.ZAPO_UPGRADE_CANDIDATE_ROOT || path.resolve(__dirname, '../..')
const core = require(path.join(root, 'dist/index.js'))
const { WA_MESSAGE_TYPES } = require(path.join(root, 'dist/protocol/index.js'))
const { FakeWaServer } = require(path.join(root, 'packages/fake-server/dist/index.js'))

async function waitUntil(predicate, label) {
    const deadline = Date.now() + 5_000
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${label}`)
        await nextTurn()
    }
}

async function exerciseQueries(count, mixedErrors, retryProbe) {
    const server = await FakeWaServer.start({ host: '127.0.0.1' })
    const store = core.createStore({})
    const sessionId = `iq-loopback-${count}`
    const client = new core.WaClient(
        {
            store,
            sessionId,
            chatSocketUrls: [server.url],
            history: { enabled: false },
            proxy: { mediaUpload: server.mediaProxyAgent, mediaDownload: server.mediaProxyAgent },
            testHooks: { noiseRootCa: server.noiseRootCa }
        },
        core.createNoopLogger()
    )
    const outgoing = []
    const completed = []
    const timedOut = []
    const errors = []
    const connectionEvents = []
    let finished = 0
    let authentications = 0
    let retriesHandled = 0
    const unregisterServer = server.onAuthenticatedPipeline(() => authentications++)
    const unregisterIq = server.registerIqHandler({ xmlns: 'w:test', type: 'get' }, (node) => {
        outgoing.push(node)
        return null
    })
    // These synthetic notification/type and w:test fixtures exercise the public raw API.
    // The server intentionally withholds test IQ replies until every handler is waiting.
    const unregisterHandler = client.lowlevel.registerIncomingHandler({
        tag: 'notification',
        subtype: 'test',
        prepend: true,
        handler: async (node) => {
            const id = 'loopback-query-' + node.attrs.id
            try {
                const response = await client.lowlevel.query(
                    { tag: 'iq', attrs: { id, type: 'get', xmlns: 'w:test' } },
                    2_000
                )
                completed.push({ expected: id, id: response.attrs.id, type: response.attrs.type })
            } catch (error) {
                if (error.message.includes('query timeout')) timedOut.push(id)
                else errors.push(error.message)
            } finally {
                finished++
            }
            return true
        }
    })
    const unregisterReceipt = client.lowlevel.registerIncomingHandler({
        tag: 'receipt',
        prepend: true,
        handler: async () => {
            retriesHandled++
            return true
        }
    })
    client.on('connection', (event) => connectionEvents.push(event.status))
    try {
        const credentials = await client.auth.loadOrCreateCredentials()
        await store.session(sessionId).auth.save({
            ...credentials,
            meJid: '5511999999990:1@s.whatsapp.net',
            serverStaticKey: server.serverStaticKeyPair.pubKey,
            serverHasPreKeys: true
        })
        await client.connect()
        const pipeline = await server.waitForAuthenticatedPipeline()
        await client.lowlevel.query(
            { tag: 'iq', attrs: { type: 'get', xmlns: 'w:p', to: 's.whatsapp.net' } },
            5_000
        )
        for (let index = 0; index < count; index++) {
            await pipeline.sendStanza({
                tag: 'notification',
                attrs: { id: String(index), type: 'test' }
            })
        }
        await waitUntil(() => outgoing.length === count, 'all test IQs reaching the server')
        assert.equal(completed.length, 0, 'the server has not sent any test responses yet')
        assert.equal(timedOut.length, 0, 'setup must finish before the query deadline')
        if (retryProbe) {
            for (const type of [
                WA_MESSAGE_TYPES.RECEIPT_TYPE_RETRY,
                WA_MESSAGE_TYPES.RECEIPT_TYPE_ENC_REKEY_RETRY
            ]) {
                await pipeline.sendStanza({
                    tag: 'receipt',
                    attrs: { id: outgoing[0].attrs.id, type, from: 's.whatsapp.net' }
                })
            }
            await waitUntil(() => retriesHandled === 2, 'retry receipts reaching their handler')
            assert.equal(completed.length, 0, 'retry receipts must not complete the pending IQ')
        }
        for (let index = count - 1; index >= 0; index--) {
            const type = mixedErrors && index % 2 === 0 ? 'error' : 'result'
            await pipeline.sendStanza({
                tag: 'iq',
                attrs: { id: outgoing[index].attrs.id, type, from: 's.whatsapp.net' },
                ...(type === 'error' ? { content: [{ tag: 'error', attrs: { code: '503' } }] } : {})
            })
        }
        await waitUntil(() => finished === count, 'all handler queries settling')
        return {
            completed,
            timedOut,
            errors,
            authentications,
            retriesHandled,
            connected: client.getState().connected,
            closes: connectionEvents.filter((status) => status === 'close').length
        }
    } finally {
        unregisterHandler()
        unregisterReceipt()
        unregisterIq()
        unregisterServer()
        await client.disconnect()
        await store.destroy()
        await server.stop()
    }
}

for (const { count, mixedErrors, retryProbe } of [
    { count: 7, mixedErrors: false },
    { count: 8, mixedErrors: false },
    { count: 8, mixedErrors: true },
    { count: 7, mixedErrors: false, retryProbe: true }
]) {
    test(`WebSocket/Noise: ${count} waiting handlers receive reversed ${mixedErrors ? 'mixed' : 'result'} IQ replies${retryProbe ? ' without consuming retry receipts' : ''}`, async () => {
        const observed = await exerciseQueries(count, mixedErrors, retryProbe)
        assert.deepEqual(observed.errors, [])
        assert.equal(observed.authentications, 1)
        assert.equal(observed.connected, true)
        assert.equal(observed.closes, 0)
        assert.equal(observed.completed.length, count, JSON.stringify(observed))
        assert.deepEqual(observed.timedOut, [])
        for (const response of observed.completed) assert.equal(response.id, response.expected)
        if (mixedErrors) {
            assert.equal(observed.completed.filter((node) => node.type === 'error').length, 4)
        }
        if (retryProbe) assert.equal(observed.retriesHandled, 2)
    })
}
