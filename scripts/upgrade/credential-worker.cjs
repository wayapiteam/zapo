const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')

const [corePath, addonPath, action, database, driver = 'better-sqlite3'] = process.argv.slice(2)
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
