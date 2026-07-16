import assert from 'node:assert/strict'
import test from 'node:test'

import { createNoopLogger, type Logger } from '@infra/log/types'
import { WaMessageClient } from '@message/WaMessageClient'
import type { WaMessagePublishNackDiagnostics } from '@message/types'
import type { BinaryNode } from '@transport/types'

interface CapturedLog {
    readonly message: string
    readonly context?: Readonly<Record<string, unknown>>
}

test('message publish NACK logs sanitized ack and outbound diagnostics', async () => {
    const warnings: CapturedLog[] = []
    const logger: Logger = {
        ...createNoopLogger(),
        warn: (message, context) => warnings.push({ message, context })
    }
    const ackNode: BinaryNode = {
        tag: 'ack',
        attrs: {
            id: '3EB08B23023116C13D73FF',
            class: 'message',
            error: '420',
            phash: 'server-phash',
            addressing_mode: 'lid',
            participant: '5511999999999@lid'
        },
        content: [
            {
                tag: 'error',
                attrs: { code: '420', retry_after: '30' },
                content: new Uint8Array([1, 2, 3])
            },
            {
                tag: 'reason',
                attrs: {},
                content: 'private diagnostics'
            }
        ]
    }
    const client = new WaMessageClient({
        logger,
        sendNode: async () => {},
        query: async () => ackNode
    })
    const outboundNode: BinaryNode = {
        tag: 'message',
        attrs: {
            to: '120363000000000000@g.us',
            id: '3EB08B23023116C13D73FF',
            type: 'text',
            participant: '5511888888888@lid',
            phash: 'outbound-phash',
            addressing_mode: 'lid'
        },
        content: new Uint8Array([9, 8, 7])
    }

    let publishError: (Error & { readonly diagnostics?: WaMessagePublishNackDiagnostics }) | null =
        null
    try {
        await client.publishNode(outboundNode)
    } catch (error) {
        assert.ok(error instanceof Error)
        publishError = error
    }

    assert.match(publishError?.message ?? '', /error=420/)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].message, 'message publish attempt failed')
    assert.strictEqual(warnings[0].context, publishError?.diagnostics)
    assert.deepEqual(warnings[0].context?.ackAttrs, ackNode.attrs)
    assert.equal(warnings[0].context?.ackTag, 'ack')
    assert.deepEqual(warnings[0].context?.ackContent, [
        {
            tag: 'error',
            attrs: { code: '420', retry_after: '30' },
            content: { kind: 'bytes', byteLength: 3 }
        },
        {
            tag: 'reason',
            attrs: {},
            content: { kind: 'text', charLength: 19 }
        }
    ])
    assert.equal(warnings[0].context?.outboundTo, outboundNode.attrs.to)
    assert.equal(warnings[0].context?.outboundId, outboundNode.attrs.id)
    assert.equal(warnings[0].context?.outboundType, outboundNode.attrs.type)
    assert.equal(warnings[0].context?.outboundParticipant, outboundNode.attrs.participant)
    assert.equal(warnings[0].context?.outboundPhash, outboundNode.attrs.phash)
    assert.equal(warnings[0].context?.outboundAddressingMode, outboundNode.attrs.addressing_mode)
    assert.doesNotMatch(JSON.stringify(warnings[0].context), /private diagnostics|\[1,2,3\]/)
})
