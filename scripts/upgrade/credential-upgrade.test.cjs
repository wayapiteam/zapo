const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

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

function snapshotRows(database) {
    const db = new DatabaseSync(database, { readOnly: true })
    const snapshot = {}
    try {
        const tables = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'wa_migrations' ORDER BY name"
            )
            .all()
        const quote = (name) => `"${name.replaceAll('"', '""')}"`
        for (const { name } of tables) {
            const columns = db
                .prepare(`PRAGMA table_info(${quote(name)})`)
                .all()
                .map((column) => column.name)
                .filter((column) => column !== 'login_counter')
            const fields = columns.map(quote).join(', ')
            const rows = db.prepare(`SELECT ${fields} FROM ${quote(name)} ORDER BY ${fields}`).all()
            const hash = createHash('sha256')
            for (const row of rows) {
                for (const column of columns) {
                    const value = row[column]
                    if (value instanceof Uint8Array) {
                        hash.update(`bytes:${value.length}:`)
                        hash.update(value)
                    } else hash.update(`${typeof value}:${String(value)};`)
                }
            }
            snapshot[name] = { rows: rows.length, digest: hash.digest('hex') }
        }
        return snapshot
    } finally {
        db.close()
    }
}

test('auth migration adds only the counter and preserves every existing table row', (t) => {
    const { run, database } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const before = snapshotRows(database)
    const first = run(newCore, newStore, 'migrate-auth-only')
    sameKeys(initial, first)
    assert.deepEqual(snapshotRows(database), before)
    assert.equal(first.state[0].loginCounter, null)
    const db = new DatabaseSync(database, { readOnly: true })
    try {
        const columns = db.prepare('PRAGMA table_info(auth_credentials)').all()
        assert.equal(columns.filter((column) => column.name === 'login_counter').length, 1)
        assert.equal(
            db
                .prepare(
                    "SELECT count(*) AS count FROM wa_migrations WHERE id = '0021_auth_login_counter'"
                )
                .get().count,
            1
        )
    } finally {
        db.close()
    }
    sameKeys(initial, run(newCore, newStore, 'migrate-auth-only'))
    assert.deepEqual(snapshotRows(database), before)
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
})

test('old provider can save after upgrade without clearing the new counter or any keys', (t) => {
    const { run, database } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const before = snapshotRows(database)
    const updated = run(newCore, newStore, 'rewrite-counter')
    assert.equal(updated.state[0].loginCounter, 43)
    sameKeys(initial, updated)
    assert.deepEqual(snapshotRows(database), before)
    sameKeys(initial, run(oldCore, oldStore, 'rewrite-counter'))
    const resumed = run(newCore, newStore, 'inspect')
    assert.equal(resumed.state[0].loginCounter, 43)
    assert.deepEqual(snapshotRows(database), before)
    sameKeys(initial, resumed)
})

test('successful login advances the persisted counter without changing credentials', (t) => {
    const { run } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    run(newCore, newStore, 'rewrite-counter')
    const after = run(newCore, newStore, 'login-success')
    assert.equal(after.state[0].loginCounter, 44)
    assert.equal(after.state[1].loginCounter, 43)
    sameKeys(initial, after)
    const reopened = run(newCore, newStore, 'inspect')
    assert.equal(reopened.state[0].loginCounter, 44)
    sameKeys(initial, reopened)
})

test('failed auth migration rolls back the DDL and preserves all legacy rows', (t) => {
    const { run, database } = fixture(t)
    const initial = run(oldCore, oldStore, 'seed')
    const before = snapshotRows(database)
    assert.equal(run(newCore, newStore, 'reject-migration').rejected, true)
    assert.deepEqual(snapshotRows(database), before)
    const db = new DatabaseSync(database, { readOnly: true })
    try {
        assert.equal(
            db
                .prepare('PRAGMA table_info(auth_credentials)')
                .all()
                .some((column) => column.name === 'login_counter'),
            false
        )
        assert.equal(
            db
                .prepare(
                    "SELECT count(*) AS count FROM wa_migrations WHERE id = '0021_auth_login_counter'"
                )
                .get().count,
            0
        )
    } finally {
        db.close()
    }
    sameKeys(initial, run(oldCore, oldStore, 'inspect'))
    sameKeys(initial, run(newCore, newStore, 'migrate-auth-only'))
})

for (const [label, selectedCore] of [
    ['fork 1.7.1', oldCore],
    ['candidate 1.11.0', newCore]
]) {
    test(`${label}: two authenticated loopback connections remain open during SQLite migration`, (t) => {
        const { run, database } = fixture(t)
        run(oldCore, oldStore, 'seed')
        const result = spawnSync(
            process.execPath,
            [
                worker,
                selectedCore,
                oldStore,
                'connected-migration',
                database,
                'better-sqlite3',
                newStore
            ],
            { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' } }
        )
        assert.equal(result.status, 0, result.error?.message ?? result.stderr)
        assert.deepEqual(JSON.parse(result.stdout), {
            connections: 2,
            pings: 4,
            closesDuringMigration: 0,
            keysUnchanged: true,
            authenticatedBefore: 2,
            authenticatedAfter: 2
        })
    })
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
