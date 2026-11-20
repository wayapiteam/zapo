const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { publishForkPackages } = require('./publish-fork-packages.cjs')

function fixture(t, sqliteName = '@wayapiteam/zapo-store-sqlite') {
    const root = mkdtempSync(path.join(tmpdir(), 'zapo-fork-release-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    for (const [directory, name] of [
        ['.', '@wayapiteam/zapo'],
        ['packages/store-sqlite', sqliteName]
    ]) {
        mkdirSync(path.join(root, directory), { recursive: true })
        writeFileSync(
            path.join(root, directory, 'package.json'),
            JSON.stringify({
                name,
                version: '1.2.3',
                publishConfig: { registry: 'https://npm.pkg.github.com' }
            })
        )
    }
    return root
}

test('checks fully scoped names and publishes both missing fork packages in order', (t) => {
    const root = fixture(t)
    const calls = []
    publishForkPackages({
        root,
        run: (command, args, options) => {
            calls.push({ command, args, cwd: options.cwd })
            return args[0] === 'view'
                ? { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) }
                : { status: 0 }
        }
    })
    assert.deepEqual(
        calls.map(({ args }) => args.slice(0, 2)),
        [
            ['view', '@wayapiteam/zapo@1.2.3'],
            ['publish', '--registry'],
            ['view', '@wayapiteam/zapo-store-sqlite@1.2.3'],
            ['publish', '--registry']
        ]
    )
    assert.equal(calls[3].cwd, path.join(root, 'packages/store-sqlite'))
    assert.ok(
        calls.every(
            ({ command, args }) => command === 'npm' && args.at(-1) === 'https://npm.pkg.github.com'
        )
    )
})

test('resuming a partial release skips the existing core and publishes SQLite', (t) => {
    const root = fixture(t)
    const published = []
    publishForkPackages({
        root,
        run: (_command, args, { cwd }) => {
            if (args[0] === 'publish') {
                published.push(cwd)
                return { status: 0 }
            }
            return cwd === root
                ? { status: 0, stdout: '"1.2.3"' }
                : { status: 1, stdout: '{"error":{"code":"E404"}}' }
        }
    })
    assert.deepEqual(published, [path.join(root, 'packages/store-sqlite')])
})

for (const code of ['E401', 'E403', 'ETIMEDOUT']) {
    test(`a registry ${code} aborts before publishing`, (t) => {
        let calls = 0
        assert.throws(
            () =>
                publishForkPackages({
                    root: fixture(t),
                    run: () => {
                        calls++
                        return { status: 1, stdout: JSON.stringify({ error: { code } }) }
                    }
                }),
            new RegExp(code)
        )
        assert.equal(calls, 1)
    })
}

test('an upstream manifest is rejected before either package is published', (t) => {
    let called = false
    assert.throws(
        () =>
            publishForkPackages({
                root: fixture(t, '@zapo-js/store-sqlite'),
                run: () => {
                    called = true
                }
            }),
        /not configured for fork publication/
    )
    assert.equal(called, false)
})
