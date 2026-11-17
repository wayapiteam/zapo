const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const REGISTRY = 'https://npm.pkg.github.com'
const PACKAGE_DIRECTORIES = ['.', 'packages/store-sqlite']

function lookupErrorCode(result) {
    try {
        return JSON.parse(result.stdout).error?.code
    } catch {
        return null
    }
}

/** Publica somente os dois pacotes do fork; falhas de consulta não viram ausência. */
function publishForkPackages({ root = path.resolve(__dirname, '../..'), run = spawnSync } = {}) {
    // Valida todos os manifests antes da primeira publicação.
    const packages = PACKAGE_DIRECTORIES.map((directory) => {
        const cwd = path.join(root, directory)
        const manifest = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'))
        if (
            !manifest.name.startsWith('@wayapiteam/') ||
            manifest.publishConfig?.registry !== REGISTRY
        )
            throw new Error(`package is not configured for fork publication: ${manifest.name}`)
        return { cwd, spec: `${manifest.name}@${manifest.version}` }
    })

    for (const { cwd, spec } of packages) {
        const lookup = run('npm', ['view', spec, 'version', '--json', '--registry', REGISTRY], {
            cwd,
            encoding: 'utf8'
        })
        if (lookup.error) throw lookup.error
        if (lookup.status === 0) {
            console.log(`${spec} already published, skipping`)
            continue
        }
        const code = lookupErrorCode(lookup)
        if (code !== 'E404')
            throw new Error(`cannot check published version ${spec}: ${code ?? lookup.status}`)

        const published = run('npm', ['publish', '--registry', REGISTRY], {
            cwd,
            stdio: 'inherit'
        })
        if (published.error) throw published.error
        if (published.status !== 0) throw new Error(`publication failed for ${spec}`)
    }
}

module.exports = { publishForkPackages }

if (require.main === module) {
    try {
        publishForkPackages()
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
