const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')

const [corePath, addonPath, action, database, driver = 'better-sqlite3', migrationAddonPath] =
    process.argv.slice(2)
if (!path.basename(path.dirname(database)).startsWith('zapo-upgrade-session-')) {
    throw new Error('upgrade test worker only accepts its synthetic temporary databases')
}

const core = require(corePath)
const addon = require(addonPath)
const logger = core.createNoopLogger()
const ids = ['upgrade-session-a', 'upgrade-session-b']
const activeClients = []
const address = { user: '5511888888888', server: 's.whatsapp.net', device: 2 }
const providers = Object.fromEntries(
    [
        'auth',
        'signal',
        'preKey',
        'session',
        'identity',
        'senderKey',
        'appState',
        'privacyToken'
    ].map((key) => [key, 'sqlite'])
)
Object.assign(providers, { messages: 'none', threads: 'none', contacts: 'none' })
const store = core.createStore({
    backends: { sqlite: addon.createSqliteStore({ path: database, driver }) },
    providers,
    cacheProviders: {
        groupMetadata: 'sqlite',
        deviceList: 'sqlite',
        messageSecret: 'sqlite',
        retry: 'memory'
    }
})
const bytes = (n, seed) => new Uint8Array(n).fill(seed)
const serialized = (value) => Uint8Array.from([5, ...value])
const fingerprint = (credentials) => {
    const hash = createHash('sha256')
    for (const value of [
        credentials.noiseKeyPair.pubKey,
        credentials.noiseKeyPair.privKey,
        credentials.registrationInfo.identityKeyPair.pubKey,
        credentials.registrationInfo.identityKeyPair.privKey,
        credentials.signedPreKey.keyPair.pubKey,
        credentials.signedPreKey.keyPair.privKey,
        credentials.signedPreKey.signature,
        credentials.advSecretKey,
        credentials.serverStaticKey,
        credentials.routingInfo,
        credentials.companionEncStatic,
        credentials.signedIdentity?.details,
        credentials.signedIdentity?.accountSignature,
        credentials.signedIdentity?.accountSignatureKey,
        credentials.signedIdentity?.deviceSignature
    ]) {
        if (value) hash.update(value)
    }
    hash.update(String(credentials.registrationInfo.registrationId))
    hash.update(credentials.meJid ?? '')
    return hash.digest('hex')
}

async function seed() {
    for (const [index, id] of ids.entries()) {
        const session = store.session(id)
        const client = new core.WaClient({ store, sessionId: id }, logger)
        const fresh = await client.auth.loadOrCreateCredentials()
        const credentials = {
            ...fresh,
            meJid: `551199999999${index}:1@s.whatsapp.net`,
            loginCounter: 42,
            meLid: `900000000000${index}@lid`,
            serverStaticKey: bytes(32, 51),
            routingInfo: bytes(16, 52),
            companionEncStatic: bytes(32, 53),
            signedIdentity: {
                details: bytes(8, 54),
                accountSignature: bytes(64, 55),
                accountSignatureKey: bytes(32, 56),
                deviceSignature: bytes(64, 57)
            }
        }
        await session.auth.save(credentials)
        assert.equal(fingerprint(await session.auth.load()), fingerprint(credentials))
        const key = credentials.registrationInfo.identityKeyPair
        await session.session.setSession(address, {
            local: { regId: 101, pubKey: serialized(key.pubKey) },
            remote: { regId: 202, pubKey: serialized(key.pubKey) },
            rootKey: bytes(32, 41 + index),
            sendChain: {
                ratchetKey: { pubKey: serialized(key.pubKey), privKey: key.privKey },
                nextMsgIndex: 3,
                chainKey: bytes(32, 43)
            },
            recvChains: [],
            initialExchangeInfo: null,
            prevSendChainHighestIndex: 2,
            aliceBaseKey: serialized(key.pubKey),
            prevSessions: []
        })
        await session.preKey.putPreKey({ keyId: 777, keyPair: key, uploaded: true })
        await session.identity.setRemoteIdentity(address, serialized(key.pubKey))
        await session.senderKey.upsertSenderKey({
            groupId: 'test-group@g.us',
            sender: address,
            keyId: 11,
            iteration: 12,
            chainKey: bytes(32, 44),
            signingPublicKey: key.pubKey,
            signingPrivateKey: key.privKey
        })
        await client.disconnect()
    }
}

async function inspect() {
    const results = []
    for (const [index, id] of ids.entries()) {
        const session = store.session(id)
        const persisted = await session.auth.load()
        assert.ok(persisted, 'registered auth must exist before loadOrCreate')
        const before = fingerprint(persisted)
        const client = new core.WaClient({ store, sessionId: id }, logger)
        const loaded = await client.auth.loadOrCreateCredentials()
        assert.equal(fingerprint(loaded), before, 'loadOrCreate must preserve registered keys')
        const signal = await session.session.getSession(address)
        assert.ok(signal, 'Signal ratchet must survive')
        assert.equal(signal.rootKey[0], 41 + index)
        assert.equal(signal.sendChain.nextMsgIndex, 3)
        assert.ok(await session.preKey.getPreKeyById(777), 'prekey must survive')
        assert.ok(await session.identity.getRemoteIdentity(address), 'peer identity must survive')
        const sender = await session.senderKey.getDeviceSenderKey('test-group@g.us', address)
        assert.equal(sender?.iteration, 12, 'sender key must survive')
        results.push({ id, authFingerprint: before, loginCounter: persisted.loginCounter ?? null })
        if (action === 'hold') activeClients.push(client)
        else await client.disconnect()
    }
    assert.equal(
        await store.session('unrelated-session').auth.load(),
        null,
        'sessions must be isolated'
    )
    return results
}

async function loadFailure() {
    const session = store.session(ids[0])
    const client = new core.WaClient({ store, sessionId: ids[0] }, logger)
    let saved = false
    session.auth.load = () => Promise.reject(new Error('synthetic database read failure'))
    session.auth.save = () => {
        saved = true
        return Promise.resolve()
    }
    await assert.rejects(client.auth.loadOrCreateCredentials(), /synthetic database read failure/)
    assert.equal(saved, false, 'read failure must not become fresh credentials')
    await client.disconnect()
}

async function main() {
    if (action === 'reject-migration') {
        const connection = await addon.openSqliteConnection({
            path: database,
            sessionId: ids[0],
            driver
        })
        const exec = connection.exec.bind(connection)
        connection.exec = (sql) => {
            exec(sql)
            if (sql.includes('ADD COLUMN login_counter'))
                throw new Error('synthetic migration failure after DDL')
        }
        try {
            await assert.rejects(
                addon.ensureSqliteMigrations(connection, ['auth']),
                /synthetic migration failure/
            )
        } finally {
            connection.close()
        }
        await store.destroy()
        console.log(JSON.stringify({ rejected: true }))
        return
    }
    if (action === 'connected-migration') {
        const { FakeWaServer } = require(
            path.resolve(path.dirname(migrationAddonPath), '../../fake-server/dist/index.js')
        )
        const protocol = require(path.join(path.dirname(corePath), 'protocol/index.js'))
        const server = await FakeWaServer.start({
            host: '127.0.0.1',
            sessionKey: ({ clientPayload }) => String(clientPayload.username)
        })
        const nextAddon = require(migrationAddonPath)
        const migrationStore = nextAddon.createSqliteStore({ path: database, driver })
        const migratedAuth = []
        const clients = []
        const events = []
        let authenticated = 0
        const unregister = server.onAuthenticatedPipeline(() => {
            authenticated += 1
        })
        const probe = async (client) => {
            const reply = await client.lowlevel.query(
                {
                    tag: protocol.WA_NODE_TAGS.IQ,
                    attrs: {
                        to: protocol.WA_DEFAULTS.HOST_DOMAIN,
                        type: protocol.WA_IQ_TYPES.GET,
                        xmlns: protocol.WA_XMLNS.WHATSAPP_PING
                    }
                },
                5_000
            )
            assert.equal(reply.attrs.type, protocol.WA_IQ_TYPES.RESULT)
        }
        try {
            for (const id of ids) {
                const auth = store.session(id).auth
                const credentials = await auth.load()
                await auth.save({
                    ...credentials,
                    serverStaticKey: server.serverStaticKeyPair.pubKey,
                    serverHasPreKeys: true,
                    routingInfo: undefined
                })
                const client = new core.WaClient(
                    {
                        store,
                        sessionId: id,
                        chatSocketUrls: [server.url],
                        history: { enabled: false },
                        proxy: {
                            mediaUpload: server.mediaProxyAgent,
                            mediaDownload: server.mediaProxyAgent
                        },
                        testHooks: { noiseRootCa: server.noiseRootCa }
                    },
                    logger
                )
                client.on('connection', (event) => events.push({ id, status: event.status }))
                clients.push(client)
                await client.connect()
                await probe(client)
            }
            const before = await Promise.all(
                ids.map(async (id) => fingerprint(await store.session(id).auth.load()))
            )
            const authenticatedBefore = authenticated
            for (const id of ids) {
                const auth = migrationStore.stores.auth(id)
                migratedAuth.push(auth)
                const credentials = await auth.load()
                assert.ok(credentials)
                await auth.save({ ...credentials, loginCounter: 42 })
                assert.equal((await auth.load()).loginCounter, 42)
            }
            await Promise.all(clients.map(probe))
            const after = await Promise.all(
                ids.map(async (id) => fingerprint(await store.session(id).auth.load()))
            )
            assert.deepEqual(after, before)
            assert.ok(clients.every((client) => client.getState().connected))
            assert.equal(events.filter((event) => event.status === 'close').length, 0)
            assert.equal(authenticated, authenticatedBefore)
            console.log(
                JSON.stringify({
                    connections: clients.length,
                    pings: clients.length * 2,
                    closesDuringMigration: 0,
                    keysUnchanged: true,
                    authenticatedBefore,
                    authenticatedAfter: authenticated
                })
            )
        } finally {
            unregister()
            await Promise.all(clients.map((client) => client.disconnect()))
            await Promise.all(migratedAuth.map((auth) => auth.destroy()))
            await store.destroy()
            await server.stop()
        }
        return
    }
    if (action === 'rewrite-counter') {
        for (const id of ids) {
            const auth = store.session(id).auth
            const credentials = await auth.load()
            assert.ok(credentials)
            await auth.save({ ...credentials, loginCounter: 43 })
        }
    }
    if (action === 'migrate-auth-only') {
        for (const id of ids) assert.ok(await store.session(id).auth.load())
    }
    if (action === 'login-success') {
        const client = new core.WaClient({ store, sessionId: ids[0] }, logger)
        const credentials = await client.auth.loadOrCreateCredentials()
        const before = fingerprint(credentials)
        await client.auth.persistSuccessAttributes({}, { countsAsLogin: true })
        assert.equal(client.auth.getCurrentCredentials().loginCounter, 44)
        await client.auth.persistSuccessAttributes({ meDisplayName: 'synthetic renamed device' })
        assert.equal(client.auth.getCurrentCredentials().loginCounter, 44)
        assert.equal(fingerprint(client.auth.getCurrentCredentials()), before)
        await client.disconnect()
    }
    if (action === 'clear-session-a') {
        const client = new core.WaClient({ store, sessionId: ids[0] }, logger)
        await client.auth.loadOrCreateCredentials()
        await client.auth.clearStoredCredentials()
        assert.equal(await store.session(ids[0]).auth.load(), null)
        const other = await store.session(ids[1]).auth.load()
        assert.ok(other)
        await client.disconnect()
        await store.destroy()
        console.log(JSON.stringify({ cleared: true, otherFingerprint: fingerprint(other) }))
        return
    }
    if (action === 'kill-transaction') {
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(database)
        db.exec('BEGIN IMMEDIATE; DELETE FROM auth_credentials;')
        process.kill(process.pid, 'SIGKILL')
        return
    }
    if (action === 'create-on-missing') {
        const client = new core.WaClient({ store, sessionId: ids[0] }, logger)
        const credentials = await client.auth.loadOrCreateCredentials()
        console.log(JSON.stringify({ registered: Boolean(credentials.meJid) }))
        await client.disconnect()
        await store.destroy()
        return
    }
    if (action === 'seed') await seed()
    if (action === 'load-failure') await loadFailure()
    if (action === 'migrate') {
        const backend = addon.createSqliteStore({ path: database, driver })
        const contacts = backend.stores.contacts('migration-session')
        await contacts.upsert({ jid: '900000@lid', username: 'synthetic', lastUpdatedMs: 1 })
        await contacts.destroy()
    }
    if (action === 'hold') {
        const state = await inspect()
        let stopping = false
        const stop = async () => {
            if (stopping) return
            stopping = true
            try {
                await Promise.all(activeClients.map((client) => client.disconnect()))
                await store.destroy()
                process.exit(0)
            } catch {
                process.exit(1)
            }
        }
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
        setInterval(() => {}, 1000)
        process.send({ ready: true, state })
        return
    }
    const state = action === 'load-failure' ? null : await inspect()
    await store.destroy()
    console.log(JSON.stringify({ action, state }))
}

main().catch(async (error) => {
    console.error(error.message)
    await store.destroy().catch(() => {})
    process.exitCode = 1
})
