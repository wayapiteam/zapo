const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { setImmediate: nextTurn } = require('node:timers/promises')
const path = require('node:path')
const test = require('node:test')
const { gzipSync } = require('node:zlib')

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

async function exerciseQueries(options) {
    const {
        count,
        mixedErrors,
        retryProbe,
        compressed,
        ignoreMode,
        filterMode,
        removeFilter,
        drain,
        handlerThrows
    } = options
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
    const handlerErrors = []
    client.on('debug_client_error', ({ error }) => handlerErrors.push(error.message))
    const connectionEvents = []
    let finished = 0
    let authentications = 0
    let retriesHandled = 0
    let filterCalls = 0
    let unregisterFilter = () => {}
    const observedIqIds = []
    client.on('debug_transport_node_in', ({ node }) => {
        if (node.tag === 'iq' && node.attrs.id?.startsWith('loopback-query-')) {
            observedIqIds.push(node.attrs.id)
        }
    })
    const filter = (node) => {
        if (node.tag !== 'iq' || !node.attrs.id?.startsWith('loopback-query-')) return false
        filterCalls++
        if (filterMode === 'throw') throw new Error('synthetic filter failure')
        return filterMode === 'drop' && node.attrs.id === 'loopback-query-0'
    }
    if (filterMode && filterMode !== 'dynamic') {
        unregisterFilter = client.lowlevel.registerIncomingStanzaFilter(filter)
    }
    if (filterMode === 'dynamic') {
        let registered = false
        client.on('debug_transport_node_in', ({ node }) => {
            if (!registered && node.attrs.id?.startsWith('loopback-query-')) {
                registered = true
                unregisterFilter = client.lowlevel.registerIncomingStanzaFilter(filter)
            }
        })
    }
    if (ignoreMode) {
        unregisterFilter = client.ignoreKey(
            ignoreMode === 'descriptor' ? { id: 'does-not-match' } : () => false
        )
    }
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
            const tracked = drain ? client.tryEnterIncomingHandler() : false
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
                if (tracked) client.leaveIncomingHandler()
                finished++
            }
            if (handlerThrows) throw new Error('synthetic incoming handler failure')
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
        if (removeFilter) {
            unregisterFilter()
            unregisterFilter()
        }
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
        // Model managed runtime work for the drain case; raw extension handlers are not
        // automatically included in WaClient's active-handler accounting.
        const disconnecting = drain ? client.disconnect() : null
        for (let index = count - 1; index >= 0; index--) {
            const type = mixedErrors && index % 2 === 0 ? 'error' : 'result'
            const response = {
                tag: 'iq',
                attrs: { id: outgoing[index].attrs.id, type, from: 's.whatsapp.net' },
                ...(type === 'error' ? { content: [{ tag: 'error', attrs: { code: '503' } }] } : {})
            }
            if (compressed) {
                const { encodeBinaryNode } = require(
                    path.join(root, 'dist/transport/binary/index.js')
                )
                const zipped = gzipSync(encodeBinaryNode(response))
                const frame = new Uint8Array(1 + zipped.length)
                frame[0] = 0x02
                frame.set(zipped, 1)
                // Test-only injection into the real encrypted transport. No new server API.
                const wire = await pipeline.state.transport.encryptFrame(frame)
                pipeline.frameSocket.sendFrame(wire)
            } else {
                await pipeline.sendStanza(response)
            }
        }
        await waitUntil(() => finished === count, 'all handler queries settling')
        if (disconnecting) await disconnecting
        return {
            completed,
            timedOut,
            errors,
            handlerErrors,
            authentications,
            retriesHandled,
            filterCalls,
            observedIqIds,
            connected: client.getState().connected,
            closes: connectionEvents.filter((status) => status === 'close').length
        }
    } finally {
        unregisterFilter()
        unregisterHandler()
        unregisterReceipt()
        unregisterIq()
        unregisterServer()
        await client.disconnect()
        await store.destroy()
        await server.stop()
    }
}

for (const options of [
    { label: 'seven handlers', count: 7 },
    { label: 'eight handlers', count: 8 },
    { label: 'mixed result/error replies', count: 8, mixedErrors: true },
    { label: 'retry receipts keep their handler', count: 7, retryProbe: true },
    { label: 'compressed replies', count: 8, compressed: true },
    { label: 'ignoreKey descriptor', count: 8, ignoreMode: 'descriptor' },
    { label: 'ignoreKey predicate', count: 8, ignoreMode: 'predicate' },
    { label: 'raw accepting filter', count: 7, filterMode: 'accept' },
    { label: 'raw dropping filter', count: 7, filterMode: 'drop' },
    { label: 'raw throwing filter', count: 7, filterMode: 'throw' },
    { label: 'filter registered during decode', count: 7, filterMode: 'dynamic' },
    { label: 'filter removed before dispatch', count: 8, filterMode: 'accept', removeFilter: true },
    { label: 'managed-handler graceful drain', count: 8, drain: true },
    { label: 'handler failures still reach debug_client_error', count: 8, handlerThrows: true }
]) {
    test(`WebSocket/Noise: ${options.label}`, async () => {
        const observed = await exerciseQueries(options)
        const dropped = options.filterMode === 'drop' ? 1 : 0
        assert.deepEqual(observed.errors, [])
        assert.deepEqual(
            observed.handlerErrors,
            options.handlerThrows
                ? Array(options.count).fill('synthetic incoming handler failure')
                : []
        )
        assert.equal(observed.authentications, 1)
        assert.equal(observed.connected, !options.drain)
        assert.equal(observed.closes, options.drain ? 1 : 0)
        assert.equal(observed.completed.length, options.count - dropped, JSON.stringify(observed))
        assert.equal(observed.timedOut.length, dropped)
        assert.equal(observed.observedIqIds.length, options.count, 'each reply is observed once')
        assert.equal(new Set(observed.observedIqIds).size, options.count)
        for (const response of observed.completed) assert.equal(response.id, response.expected)
        if (options.mixedErrors) {
            assert.equal(observed.completed.filter((node) => node.type === 'error').length, 4)
        }
        if (options.retryProbe) assert.equal(observed.retriesHandled, 2)
        if (options.filterMode && !options.removeFilter) {
            assert.equal(observed.filterCalls, options.count)
        }
    })
}

function credentialFingerprint(credentials) {
    const hash = createHash('sha256')
    for (const bytes of [
        credentials.noiseKeyPair.pubKey,
        credentials.noiseKeyPair.privKey,
        credentials.registrationInfo.identityKeyPair.pubKey,
        credentials.registrationInfo.identityKeyPair.privKey,
        credentials.signedPreKey.keyPair.pubKey,
        credentials.signedPreKey.keyPair.privKey,
        credentials.signedPreKey.signature,
        credentials.advSecretKey
    ])
        hash.update(bytes)
    return hash.digest('hex')
}

for (const delayed of ['decoded reply', 'send failure']) {
    test(`WebSocket/Noise: old ${delayed} cannot affect a reused id after reconnect`, async () => {
        const server = await FakeWaServer.start({ host: '127.0.0.1' })
        const store = core.createStore({})
        const client = new core.WaClient(
            {
                store,
                sessionId: 'iq-generation-reuse',
                chatSocketUrls: [server.url],
                history: { enabled: false },
                proxy: {
                    mediaUpload: server.mediaProxyAgent,
                    mediaDownload: server.mediaProxyAgent
                },
                testHooks: { noiseRootCa: server.noiseRootCa }
            },
            core.createNoopLogger()
        )
        const pipelines = []
        const queries = []
        const unbindPipeline = server.onAuthenticatedPipeline((pipeline) =>
            pipelines.push(pipeline)
        )
        const unbindIq = server.registerIqHandler({ xmlns: 'w:test', type: 'get' }, (node) => {
            queries.push(node)
            return null
        })
        let releaseOld
        const oldGate = new Promise((resolve) => {
            releaseOld = resolve
        })
        let held = false
        let returnedOld = false
        const transport = client.deps.nodeTransport
        const decode = transport.decodeIncomingFrame.bind(transport)
        const send = transport.sendNode.bind(transport)
        if (delayed === 'decoded reply')
            transport.decodeIncomingFrame = async (frame, isCurrent, accountDecodedBytes) => {
                const node = await decode(frame, isCurrent, accountDecodedBytes)
                if (!held && node?.attrs.id === 'reused-after-reconnect') {
                    held = true
                    // Hold after real decoding, at the boundary checked again by WaClient.
                    await oldGate
                    returnedOld = true
                }
                return node
            }
        if (delayed === 'send failure')
            transport.sendNode = async (node) => {
                await send(node)
                if (!held && node.attrs.id === 'reused-after-reconnect') {
                    held = true
                    // Send bytes through the real socket, delay only its completion/failure.
                    await oldGate
                    returnedOld = true
                    throw new Error('synthetic late send failure from old connection')
                }
            }
        try {
            const credentials = await client.auth.loadOrCreateCredentials()
            await store.session('iq-generation-reuse').auth.save({
                ...credentials,
                meJid: '5511999999991:1@s.whatsapp.net',
                serverStaticKey: server.serverStaticKeyPair.pubKey,
                serverHasPreKeys: true
            })
            await client.connect()
            await waitUntil(() => pipelines.length === 1, 'initial authenticated connection')
            const fingerprint = credentialFingerprint(client.auth.getCurrentCredentials())
            const request = {
                tag: 'iq',
                attrs: { id: 'reused-after-reconnect', type: 'get', xmlns: 'w:test' }
            }
            const old = client.lowlevel.query(request, 5_000).then(
                (node) => ({ node }),
                (error) => ({ error: error.message })
            )
            await waitUntil(() => queries.length === 1, 'old connection query')
            if (delayed === 'decoded reply')
                await pipelines[0].sendStanza({
                    tag: 'iq',
                    attrs: { id: request.attrs.id, type: 'result', phase: 'old' }
                })
            await waitUntil(() => held, 'old work held')
            await client.disconnect()
            assert.match((await old).error, /client disconnected/)
            await client.connect()
            await waitUntil(() => pipelines.length === 2, 'new authenticated connection')
            let freshSettled = false
            const fresh = client.lowlevel.query(request, 5_000).then(
                (node) => {
                    freshSettled = true
                    return { node }
                },
                (error) => {
                    freshSettled = true
                    return { error: error.message }
                }
            )
            await waitUntil(() => queries.length === 2, 'new query reusing the old id')
            releaseOld()
            await waitUntil(() => returnedOld, 'old work released')
            await nextTurn()
            assert.equal(freshSettled, false, 'old work must not settle the new query')
            await pipelines[1].sendStanza({
                tag: 'iq',
                attrs: { id: request.attrs.id, type: 'result', phase: 'fresh' }
            })
            const response = await fresh
            assert.equal(response.error, undefined)
            assert.equal(response.node.attrs.phase, 'fresh')
            assert.equal(credentialFingerprint(client.auth.getCurrentCredentials()), fingerprint)
            assert.equal(client.getState().connected, true)
            assert.equal(pipelines.length, 2)
        } finally {
            releaseOld()
            transport.decodeIncomingFrame = decode
            transport.sendNode = send
            unbindIq()
            unbindPipeline()
            await client.disconnect()
            await store.destroy()
            await server.stop()
        }
    })
}
