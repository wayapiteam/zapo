const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')

test('published fork tarballs load CJS/ESM and preserve SQLite auth without upstream core', (t) => {
    const root = path.resolve(__dirname, '../..')
    const directory = mkdtempSync(path.join(tmpdir(), 'zapo-packed-release-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const tarballs = ['.', 'packages/store-sqlite'].map((packageDirectory) => {
        const output = execFileSync(
            'npm',
            ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
            { cwd: path.join(root, packageDirectory), encoding: 'utf8' }
        )
        return path.join(directory, JSON.parse(output)[0].filename)
    })
    execFileSync(
        'npm',
        [
            'install',
            '--ignore-scripts',
            '--omit=optional',
            '--package-lock=false',
            '--no-audit',
            '--no-fund',
            ...tarballs
        ],
        { cwd: directory, encoding: 'utf8', timeout: 120_000 }
    )

    const output = execFileSync(
        process.execPath,
        [
            '-e',
            `
        const assert = require('node:assert/strict');
        const path = require('node:path');
        const core = require('@wayapiteam/zapo');
        const sqlite = require('@wayapiteam/zapo-store-sqlite');
        (async () => {
            assert.throws(() => require.resolve('zapo-js'), {code: 'MODULE_NOT_FOUND'});
            assert.equal(typeof (await import('@wayapiteam/zapo')).WaClient, 'function');
            assert.equal(typeof (await import('@wayapiteam/zapo-store-sqlite')).createSqliteStore, 'function');
            const database = path.join(process.cwd(), 'auth.sqlite');
            const makeStore = () => core.createStore({
                backends: {sqlite: sqlite.createSqliteStore({path: database, driver: 'node'})},
                providers: Object.fromEntries([
                    'auth', 'signal', 'preKey', 'session', 'identity', 'senderKey',
                    'appState', 'messages', 'threads', 'contacts', 'privacyToken'
                ].map(domain => [domain, 'sqlite']))
            });
            const store = makeStore();
            const client = new core.WaClient({store, sessionId: 'packed-auth'}, core.createNoopLogger());
            const credentials = await client.auth.loadOrCreateCredentials();
            await store.session('packed-auth').auth.save({...credentials, loginCounter: 42});
            await client.disconnect();
            await store.destroy();
            const reopened = makeStore();
            try {
                const restored = await reopened.session('packed-auth').auth.load();
                assert.equal(restored.loginCounter, 42);
                assert.deepEqual(restored.noiseKeyPair, credentials.noiseKeyPair);
                assert.equal(await reopened.session('other-auth').auth.load(), null);
            } finally {
                await reopened.destroy();
            }
            console.log('packed-auth-ok');
        })().catch(error => {console.error(error); process.exitCode = 1});
    `
        ],
        { cwd: directory, encoding: 'utf8', timeout: 30_000 }
    )
    assert.match(output, /packed-auth-ok/)
})
