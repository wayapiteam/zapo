import assert from 'node:assert/strict'
import test from 'node:test'

import { createNoopLogger, type Logger } from '@infra/log/types'
import { WaMessageClient } from '@message/WaMessageClient'
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

    let publishError: Error | null = null
    try {
        await client.publishNode(outboundNode)
    } catch (error) {
        assert.ok(error instanceof Error)
        publishError = error
    }

    assert.match(publishError?.message ?? '', /error=420/)
    assert.equal(publishError && 'diagnostics' in publishError, false)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].message, 'message publish attempt failed')
    assert.deepEqual(warnings[0].context?.ackAttrs, ackNode.attrs)
    assert.equal(warnings[0].context?.ackTag, 'ack')
    assert.equal(warnings[0].context?.nackCode, '420')
    assert.equal(warnings[0].context?.nackCategory, 'client_rejection')
    assert.equal(warnings[0].context?.nackCodeSource, 'error')
    assert.equal(typeof warnings[0].context?.attemptDurationMs, 'number')
    assert.equal(warnings[0].context?.waMessageId, outboundNode.attrs.id)
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

test('message publish NACK logs newsletter 401 and media diagnostics', async () => {
    const warnings: CapturedLog[] = []
    const logger: Logger = {
        ...createNoopLogger(),
        warn: (message, context) => warnings.push({ message, context })
    }
    const client = new WaMessageClient({
        logger,
        sendNode: async () => {},
        query: async () => ({
            tag: 'ack',
            attrs: {
                id: 'newsletter-message-1',
                from: '120363000000000000@newsletter',
                class: 'message',
                error: '401',
                t: '1785528509'
            }
        })
    })
    const node: BinaryNode = {
        tag: 'message',
        attrs: {
            to: '120363000000000000@newsletter',
            id: 'newsletter-message-1',
            type: 'media',
            media_id: 'sensitive-media-handle'
        },
        content: [
            {
                tag: 'plaintext',
                attrs: { mediatype: 'image' },
                content: new Uint8Array([9, 8, 7])
            }
        ]
    }

    await assert.rejects(client.publishNode(node), /error=401/)

    const context = warnings[0].context
    assert.equal(context?.nackCode, '401')
    assert.equal(context?.nackCategory, 'authorization')
    assert.equal(context?.ackFrom, '120363000000000000@newsletter')
    assert.equal(context?.ackTimestamp, '1785528509')
    assert.equal(context?.waMessageId, 'newsletter-message-1')
    assert.equal(context?.outboundMediaIdPresent, true)
    assert.deepEqual(context?.outboundChildTags, ['plaintext'])
    assert.equal(context?.outboundPlaintextMediaType, 'image')
    assert.equal(context?.outboundPlaintextByteLength, 3)
    assert.doesNotMatch(JSON.stringify(context), /\[9,8,7\]|sensitive-media-handle/)
})

test('message publish NACK logs group sender-key topology without ciphertext', async () => {
    const warnings: CapturedLog[] = []
    const logger: Logger = {
        ...createNoopLogger(),
        warn: (message, context) => warnings.push({ message, context })
    }
    const client = new WaMessageClient({
        logger,
        sendNode: async () => {},
        query: async () => ({
            tag: 'ack',
            attrs: { id: 'group-message-1', class: 'message', error: '420' }
        })
    })
    const node: BinaryNode = {
        tag: 'message',
        attrs: {
            to: '120363000000000000@g.us',
            id: 'group-message-1',
            type: 'media',
            phash: '2:group-phash',
            addressing_mode: 'lid'
        },
        content: [
            {
                tag: 'participants',
                attrs: {},
                content: [
                    {
                        tag: 'to',
                        attrs: { jid: '100@lid' },
                        content: [
                            {
                                tag: 'enc',
                                attrs: { type: 'msg', v: '2' },
                                content: new Uint8Array([1, 2])
                            }
                        ]
                    },
                    {
                        tag: 'to',
                        attrs: { jid: '101@lid' },
                        content: [
                            {
                                tag: 'enc',
                                attrs: { type: 'pkmsg', v: '2' },
                                content: new Uint8Array([3, 4, 5])
                            }
                        ]
                    }
                ]
            },
            {
                tag: 'enc',
                attrs: { type: 'skmsg', mediatype: 'image', v: '2' },
                content: new Uint8Array([6, 7, 8, 9])
            },
            { tag: 'device-identity', attrs: {}, content: new Uint8Array([10]) }
        ]
    }

    await assert.rejects(client.publishNode(node), /error=420/)

    const context = warnings[0].context
    assert.equal(context?.nackCode, '420')
    assert.equal(context?.nackCategory, 'client_rejection')
    assert.equal(context?.outboundParticipantCount, 2)
    assert.equal(context?.outboundParticipantMessageCount, 1)
    assert.equal(context?.outboundParticipantPreKeyCount, 1)
    assert.equal(context?.outboundParticipantWithoutCiphertextCount, 0)
    assert.equal(context?.outboundTopLevelEncType, 'skmsg')
    assert.equal(context?.outboundEncryptedMediaType, 'image')
    assert.equal(context?.outboundTopLevelCiphertextByteLength, 4)
    assert.equal(context?.outboundDeviceIdentityPresent, true)
    assert.doesNotMatch(JSON.stringify(context), /\[1,2\]|\[3,4,5\]|\[6,7,8,9\]/)
})

test('message publish uses the operation-scoped logger when provided', async () => {
    const warnings: CapturedLog[] = []
    const operationLogger: Logger = {
        ...createNoopLogger(),
        warn: (message, context) =>
            warnings.push({ message, context: { messageId: 'app-1', ...context } })
    }
    const client = new WaMessageClient({
        logger: createNoopLogger(),
        sendNode: async () => {},
        query: async () => ({
            tag: 'ack',
            attrs: { id: 'wa-1', class: 'message', error: '401' }
        })
    })

    await assert.rejects(
        client.publishNode(
            { tag: 'message', attrs: { id: 'wa-1', to: '123@newsletter', type: 'text' } },
            { logger: operationLogger }
        ),
        /error=401/
    )

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].context?.messageId, 'app-1')
    assert.equal(warnings[0].context?.waMessageId, 'wa-1')
})
