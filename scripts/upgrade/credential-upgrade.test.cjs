const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const referenceManifest = process.env.ZAPO_UPGRADE_REFERENCE_MANIFEST
if (!referenceManifest) {
    throw new Error(
        'set ZAPO_UPGRADE_REFERENCE_MANIFEST to a manifest resolving the installed fork and SQLite addon'
    )
}
const candidate = process.env.ZAPO_UPGRADE_CANDIDATE_ROOT || path.resolve(__dirname, '../..')
const appRequire = createRequire(path.resolve(referenceManifest))
const oldCore = appRequire.resolve('@wayapiteam/zapo')
const oldStore = appRequire.resolve('@zapo-js/store-sqlite')
const newCore = path.join(candidate, 'dist/index.js')
const newStore = path.join(candidate, 'packages/store-sqlite/dist/index.js')
const worker = path.join(__dirname, 'credential-worker.cjs')

function fixture(t) {
    const directory = mkdtempSync(path.join(tmpdir(), 'zapo-upgrade-session-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const database = path.join(directory, 'state.sqlite')
    const run = (core, addon, action, driver = 'better-sqlite3', selectedDatabase = database) => {
        const result = spawnSync(
            process.execPath,
            [worker, core, addon, action, selectedDatabase, driver],
            {
                encoding: 'utf8',
                timeout: 20_000,
                env: { ...process.env, NODE_OPTIONS: '' }
            }
        )
        assert.equal(result.status, 0, `${action}: ${result.stderr}`)
        return JSON.parse(result.stdout)
    }
    return { directory, database, run }
}

function sameKeys(left, right) {
    assert.deepEqual(
        left.state.map((row) => [row.id, row.authFingerprint]),
        right.state.map((row) => [row.id, row.authFingerprint])
    )
}

test('installed 1.7.1 and SQLite 1.0.1 -> candidate core with old addon -> rollback preserve two auth and Signal sessions', (t) => {
    const { run } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const upgraded = run(newCore, oldStore, 'inspect')
    sameKeys(initial, upgraded)
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
})

test('old addon -> SQLite 1.3.0 migrations -> rollback -> new addon preserve registered credentials and ratchets', (t) => {
    const { run } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    sameKeys(initial, run(newCore, newStore, 'migrate'))
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
    sameKeys(initial, run(newCore, newStore, 'inspect'))
})

test('upgrade to node:sqlite driver and rollback to old native driver preserve keys and session isolation', (t) => {
    const { run } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    sameKeys(initial, run(newCore, newStore, 'inspect', 'node'))
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`candidate process receives ${signal}; new process and old version can reread identical credentials`, async (t) => {
        const { run, database } = fixture(t)
        const initial = run(oldCore, oldStore, 'seed')
        const child = spawn(process.execPath, [worker, newCore, newStore, 'hold', database], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, NODE_OPTIONS: '' }
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        const exited = once(child, 'exit')
        const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
        t.after(() => clearTimeout(timeout))
        const [ready] = await Promise.race([
            once(child, 'message'),
            exited.then(() => {
                throw new Error(`child failed before ready: ${stderr}`)
            })
        ])
        assert.equal(ready.ready, true)
        assert.equal(child.kill(signal), true)
        assert.deepEqual(await exited, [0, null], stderr)
        sameKeys(initial, run(newCore, newStore, 'inspect'))
        sameKeys(initial, run(oldCore, oldStore, 'inspect'))
    })
}

test('database read failure propagates and cannot be converted into fresh credentials', (t) => {
    const { run } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    run(newCore, newStore, 'load-failure')
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
})

test('SIGKILL during an uncommitted SQLite delete rolls back and preserves both auth sessions', (t) => {
    const { run, database } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const killed = spawnSync(
        process.execPath,
        [worker, newCore, newStore, 'kill-transaction', database],
        {
            encoding: 'utf8',
            timeout: 15_000,
            env: { ...process.env, NODE_OPTIONS: '' }
        }
    )
    assert.equal(killed.signal, 'SIGKILL', killed.stderr)
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
    sameKeys(initial, run(newCore, newStore, 'inspect'))
})

test('wrong database path creates an unregistered identity while original credentials remain intact', (t) => {
    const { run, directory } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const wrongPath = path.join(directory, 'different-working-directory.sqlite')
    const missing = run(newCore, newStore, 'create-on-missing', 'better-sqlite3', wrongPath)
    assert.equal(missing.registered, false)
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
})

test('explicit auth clear remains effective and is scoped to its session', (t) => {
    const { run } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const cleared = run(newCore, newStore, 'clear-session-a')
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.otherFingerprint, initial.state[1].authFingerprint)
})

test('candidate SQLite preserves the core loginCounter across restart', (t) => {
    const { run } = fixture(t)
    const updated = run(newCore, newStore, 'seed')
    assert.equal(updated.state[0].loginCounter, 42)
})

test('corrupt SQLite is rejected instead of being replaced with fresh credentials', (t) => {
    const { run, database } = fixture(t)
    run(oldCore, oldStore, 'seed')
    const corrupt = new TextEncoder().encode('synthetic invalid sqlite database')
    writeFileSync(database, corrupt)
    const result = spawnSync(
        process.execPath,
        [worker, newCore, newStore, 'create-on-missing', database],
        { encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' } }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not a database|SQLITE_NOTADB/)
    assert.deepEqual(new Uint8Array(readFileSync(database)), corrupt)
})
