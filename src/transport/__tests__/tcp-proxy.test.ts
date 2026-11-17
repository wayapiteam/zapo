import assert from 'node:assert/strict'
import { Agent } from 'node:http'
import test from 'node:test'

import { createNoopLogger } from '@infra/log/types'
import { WaMobileTcpSocketCtor } from '@transport/node/WaMobileTcpSocket'
import { toTcpProxyEndpoint } from '@transport/proxy'
import { WaWebSocket } from '@transport/WaWebSocket'

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

test('a malformed proxy remains redacted through socket connection logs', async () => {
    const logged: string[] = []
    const agent = Object.assign(new Agent(), {
        proxy: 'http://synthetic-user:synthetic-secret@['
    })
    const logger = createNoopLogger()
    const capture = (message: string, context?: unknown): void => {
        logged.push(message, JSON.stringify(context))
    }
    const socket = new WaWebSocket(
        {
            url: 'tcp://synthetic.invalid:443',
            agent,
            rawWebSocketConstructor: WaMobileTcpSocketCtor
        },
        { ...logger, warn: capture, error: capture, debug: capture, trace: capture }
    )
    try {
        await assert.rejects(socket.open(), (error: Error) => {
            assert.doesNotMatch(error.message, /synthetic-user|synthetic-secret/)
            return true
        })
        assert.ok(logged.length > 0)
        assert.doesNotMatch(logged.join('\n'), /synthetic-user|synthetic-secret/)
    } finally {
        await socket.close()
        agent.destroy()
    }
})
