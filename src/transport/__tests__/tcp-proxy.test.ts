import assert from 'node:assert/strict'
import { Agent } from 'node:http'
import test from 'node:test'

import { createNoopLogger } from '@infra/log/types'
import { WaMobileTcpSocketCtor } from '@transport/node/WaMobileTcpSocket'
import { toTcpProxyEndpoint } from '@transport/proxy'
import { WaComms } from '@transport/WaComms'

test('TCP proxy endpoint normalizes an IPv6 literal for socket dialing', () => {
    for (const [input, hostname] of [
        ['http://[::1]:8080', '::1'],
        ['http://127.0.0.1:8080', '127.0.0.1'],
        ['http://proxy.example:8080', 'proxy.example']
    ]) {
        const agent = Object.assign(new Agent(), { proxy: new URL(input) })
        assert.equal(toTcpProxyEndpoint(agent)?.hostname, hostname)
        agent.destroy()
    }
})

test('malformed proxy URLs never expose their userinfo in errors', () => {
    const agent = Object.assign(new Agent(), {
        proxy: 'http://synthetic-user:synthetic-secret@['
    })
    try {
        assert.throws(
            () => toTcpProxyEndpoint(agent),
            (error: Error) => {
                assert.match(error.message, /unparseable proxy url/)
                assert.doesNotMatch(error.message, /synthetic-user|synthetic-secret/)
                return true
            }
        )
    } finally {
        agent.destroy()
    }
})

test(
    'a malformed proxy remains redacted through socket connection logs',
    { timeout: 5_000 },
    async () => {
        const logged: string[] = []
        const agent = Object.assign(new Agent(), {
            proxy: 'http://synthetic-user:synthetic-secret@['
        })
        let reportFailure = (_message: string): void => undefined
        const failure = new Promise<string>((resolve) => {
            reportFailure = resolve
        })
        const capture = (message: string, context?: unknown): void => {
            logged.push(message, JSON.stringify(context))
        }
        const comms = new WaComms(
            {
                url: 'tcp://synthetic.invalid:443',
                agent,
                rawWebSocketConstructor: WaMobileTcpSocketCtor,
                maxReconnectAttempts: 0,
                noise: {
                    isRegistered: true,
                    clientStaticKeyPair: { pubKey: new Uint8Array(32), privKey: new Uint8Array(32) }
                }
            },
            {
                ...createNoopLogger(),
                warn: (message, context) => {
                    capture(message, context)
                    if (message === 'socket open failed') reportFailure(String(context?.message))
                }
            }
        )
        try {
            comms.startComms(async () => undefined)
            assert.match(await failure, /unparseable proxy url/)
            assert.doesNotMatch(logged.join('\n'), /synthetic-user|synthetic-secret/)
        } finally {
            await comms.stopComms()
            agent.destroy()
        }
    }
)
