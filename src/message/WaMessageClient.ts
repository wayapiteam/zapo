import type { Logger } from '@infra/log/types'
import {
    describeAckNode,
    isAckOrReceiptNode,
    isNegativeAckNode,
    isRetryableNegativeAck
} from '@message/primitives/ack'
import type {
    WaEncryptedMessageInput,
    WaMessageAckMetadata,
    WaMessagePublishNackContentSummary,
    WaMessagePublishNackDiagnostics,
    WaMessagePublishOptions,
    WaMessagePublishResult,
    WaSendReceiptInput
} from '@message/types'
import {
    WA_ADDRESSING_MODES,
    WA_DEFAULTS,
    WA_MESSAGE_TAGS,
    WA_MESSAGE_TYPES,
    WA_NACK_REASONS,
    WA_NODE_TAGS
} from '@protocol/constants'
import { buildReceiptNode } from '@transport/node/builders/global'
import type { BinaryNode } from '@transport/types'
import { delay } from '@util/async'
import { parseOptionalInt, toError } from '@util/primitives'

const WA_RETRYABLE_PUBLISH_ERROR_RE = /timeout|socket|connection|closed/i

interface WaMessageClientOptions {
    readonly logger: Logger
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly defaultAckTimeoutMs?: number
    readonly defaultMaxAttempts?: number
    readonly defaultRetryDelayMs?: number
}

class MessagePublishNackError extends Error {
    public readonly retryable: boolean

    public constructor(message: string, retryable: boolean) {
        super(message)
        this.name = 'MessagePublishNackError'
        this.retryable = retryable
    }
}

function summarizeNodeContent(
    content: BinaryNode['content']
): WaMessagePublishNackContentSummary | undefined {
    if (content === undefined) return undefined
    if (content instanceof Uint8Array) {
        return { kind: 'bytes', byteLength: content.byteLength }
    }
    if (typeof content === 'string') {
        return { kind: 'text', charLength: content.length }
    }
    return content.map((child) => ({
        tag: child.tag,
        attrs: child.attrs,
        content: summarizeNodeContent(child.content)
    }))
}

interface WaOutboundPublishSummary {
    readonly outboundMediaIdPresent: boolean
    readonly outboundChildTags?: readonly string[]
    readonly outboundPlaintextMediaType?: string
    readonly outboundPlaintextByteLength?: number
    readonly outboundParticipantCount?: number
    readonly outboundParticipantMessageCount?: number
    readonly outboundParticipantPreKeyCount?: number
    readonly outboundParticipantWithoutCiphertextCount?: number
    readonly outboundTopLevelEncType?: string
    readonly outboundEncryptedMediaType?: string
    readonly outboundDecryptFail?: string
    readonly outboundTopLevelCiphertextByteLength?: number
    readonly outboundDeviceIdentityPresent?: boolean
    readonly outboundBotParticipantCount?: number
}

function countParticipantNodes(content: BinaryNode['content']): {
    readonly total: number
    readonly message: number
    readonly preKey: number
    readonly withoutCiphertext: number
} {
    if (!Array.isArray(content)) {
        return { total: 0, message: 0, preKey: 0, withoutCiphertext: 0 }
    }

    let total = 0
    let message = 0
    let preKey = 0
    let withoutCiphertext = 0
    for (let i = 0; i < content.length; i += 1) {
        const participant = content[i]
        if (participant.tag !== 'to') continue
        total += 1
        if (!Array.isArray(participant.content)) {
            withoutCiphertext += 1
            continue
        }
        let encType: string | undefined
        for (let childIndex = 0; childIndex < participant.content.length; childIndex += 1) {
            const child = participant.content[childIndex]
            if (child.tag === WA_MESSAGE_TAGS.ENC) {
                encType = child.attrs.type
                break
            }
        }
        if (encType === 'msg') message += 1
        else if (encType === 'pkmsg') preKey += 1
        else withoutCiphertext += 1
    }
    return { total, message, preKey, withoutCiphertext }
}

function classifyNackCode(code?: string): WaMessagePublishNackDiagnostics['nackCategory'] {
    if (!code) return 'other'
    if (code === '401') return 'authorization'
    if (code === String(WA_NACK_REASONS.STALE_GROUP_ADDRESSING_MODE)) {
        return 'stale_group_addressing_mode'
    }
    if (code === '429') return 'rate_limit'
    const numericCode = Number(code)
    if (numericCode >= 400 && numericCode < 500) return 'client_rejection'
    if (numericCode >= 500 && numericCode < 600) return 'server_error'
    return 'other'
}

function summarizeOutboundNode(node: BinaryNode): WaOutboundPublishSummary {
    const content = node.content
    if (!Array.isArray(content)) {
        return { outboundMediaIdPresent: node.attrs.media_id !== undefined }
    }

    const childTags = new Array<string>(content.length)
    let plaintextMediaType: string | undefined
    let plaintextByteLength: number | undefined
    let participantCount: number | undefined
    let participantMessageCount: number | undefined
    let participantPreKeyCount: number | undefined
    let participantWithoutCiphertextCount: number | undefined
    let topLevelEncType: string | undefined
    let encryptedMediaType: string | undefined
    let decryptFail: string | undefined
    let topLevelCiphertextByteLength: number | undefined
    let deviceIdentityPresent = false
    let botParticipantCount: number | undefined
    for (let i = 0; i < content.length; i += 1) {
        const child = content[i]
        childTags[i] = child.tag
        if (child.tag === WA_NODE_TAGS.PLAINTEXT) {
            plaintextMediaType = child.attrs.mediatype
            if (child.content instanceof Uint8Array) {
                plaintextByteLength = child.content.byteLength
            }
        } else if (child.tag === WA_NODE_TAGS.PARTICIPANTS) {
            const counts = countParticipantNodes(child.content)
            participantCount = counts.total
            participantMessageCount = counts.message
            participantPreKeyCount = counts.preKey
            participantWithoutCiphertextCount = counts.withoutCiphertext
        } else if (child.tag === WA_MESSAGE_TAGS.ENC) {
            topLevelEncType = child.attrs.type
            encryptedMediaType = child.attrs.mediatype
            decryptFail = child.attrs['decrypt-fail']
            if (child.content instanceof Uint8Array) {
                topLevelCiphertextByteLength = child.content.byteLength
            }
        } else if (child.tag === WA_NODE_TAGS.DEVICE_IDENTITY) {
            deviceIdentityPresent = true
        } else if (child.tag === WA_NODE_TAGS.BOT) {
            botParticipantCount = countParticipantNodes(child.content).total
        }
    }

    return {
        outboundMediaIdPresent: node.attrs.media_id !== undefined,
        outboundChildTags: childTags,
        outboundPlaintextMediaType: plaintextMediaType,
        outboundPlaintextByteLength: plaintextByteLength,
        outboundParticipantCount: participantCount,
        outboundParticipantMessageCount: participantMessageCount,
        outboundParticipantPreKeyCount: participantPreKeyCount,
        outboundParticipantWithoutCiphertextCount: participantWithoutCiphertextCount,
        outboundTopLevelEncType: topLevelEncType,
        outboundEncryptedMediaType: encryptedMediaType,
        outboundDecryptFail: decryptFail,
        outboundTopLevelCiphertextByteLength: topLevelCiphertextByteLength,
        outboundDeviceIdentityPresent: deviceIdentityPresent,
        outboundBotParticipantCount: botParticipantCount
    }
}

/**
 * Low-level message-publishing client. Sends pre-built message/receipt nodes,
 * handles ack timeouts and retry on negative-ack failures, and is the
 * transport hook used by {@link WaMessageCoordinator}.
 */
export class WaMessageClient {
    private readonly logger: WaMessageClientOptions['logger']
    private readonly sendNode: WaMessageClientOptions['sendNode']
    private readonly query: WaMessageClientOptions['query']
    private readonly defaultAckTimeoutMs: number
    private readonly defaultMaxAttempts: number
    private readonly defaultRetryDelayMs: number

    public constructor(options: WaMessageClientOptions) {
        this.logger = options.logger
        this.sendNode = options.sendNode
        this.query = options.query
        this.defaultAckTimeoutMs = options.defaultAckTimeoutMs ?? WA_DEFAULTS.MESSAGE_ACK_TIMEOUT_MS
        this.defaultMaxAttempts = options.defaultMaxAttempts ?? WA_DEFAULTS.MESSAGE_MAX_ATTEMPTS
        this.defaultRetryDelayMs = options.defaultRetryDelayMs ?? WA_DEFAULTS.MESSAGE_RETRY_DELAY_MS
    }

    /**
     * Publishes a `<message>` stanza and awaits its ack/receipt, retrying on
     * retryable negative-ack errors up to `maxAttempts`. Returns the ack
     * metadata extracted from the server response.
     */
    public async publishNode(
        node: BinaryNode,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        if (node.tag !== WA_MESSAGE_TAGS.MESSAGE) {
            throw new Error(`invalid node tag for message publish: ${node.tag}`)
        }

        const ackTimeoutMs = options.ackTimeoutMs ?? this.defaultAckTimeoutMs
        const maxAttempts = options.maxAttempts ?? this.defaultMaxAttempts
        const retryDelayMs = options.retryDelayMs ?? this.defaultRetryDelayMs
        const logger = options.logger ?? this.logger
        if (ackTimeoutMs < 1 || maxAttempts < 1 || retryDelayMs < 0) {
            throw new Error('invalid message publish options')
        }

        let lastError: Error | null = null
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const attemptStartedAt = Date.now()
            let nackLogContext: WaMessagePublishNackDiagnostics | null = null
            try {
                logger.debug('message publish attempt', {
                    attempt,
                    maxAttempts,
                    to: node.attrs.to,
                    type: node.attrs.type,
                    id: node.attrs.id
                })
                const ackNode = await this.query(node, ackTimeoutMs)
                const id = ackNode.attrs.id
                if (!id) {
                    throw new Error('message publish ack node missing id')
                }
                if (!isAckOrReceiptNode(ackNode)) {
                    throw new Error(`unexpected publish response: ${describeAckNode(ackNode)}`)
                }
                if (isNegativeAckNode(ackNode)) {
                    const message = `negative publish ack: ${describeAckNode(ackNode)}`
                    const retryable = isRetryableNegativeAck(ackNode)
                    const nackCodeSource = ackNode.attrs.error
                        ? 'error'
                        : ackNode.attrs.code
                          ? 'code'
                          : undefined
                    const nackCode = nackCodeSource ? ackNode.attrs[nackCodeSource] : undefined
                    nackLogContext = {
                        attempt,
                        maxAttempts,
                        nackRetryable: retryable,
                        message,
                        nackCode,
                        nackCategory: classifyNackCode(nackCode),
                        nackCodeSource,
                        attemptDurationMs: Date.now() - attemptStartedAt,
                        ackTag: ackNode.tag,
                        ackAttrs: ackNode.attrs,
                        ackContent: summarizeNodeContent(ackNode.content),
                        ackFrom: ackNode.attrs.from,
                        ackTimestamp: ackNode.attrs.t,
                        waMessageId: node.attrs.id,
                        outboundTo: node.attrs.to,
                        outboundId: node.attrs.id,
                        outboundType: node.attrs.type,
                        outboundEdit: node.attrs.edit,
                        outboundParticipant: node.attrs.participant,
                        outboundPhash: node.attrs.phash,
                        outboundAddressingMode: node.attrs.addressing_mode,
                        ...summarizeOutboundNode(node)
                    }
                    throw new MessagePublishNackError(message, retryable)
                }
                if (attempt > 1) {
                    logger.info('message publish acknowledged after retry', {
                        id,
                        tag: ackNode.tag,
                        type: ackNode.attrs.type,
                        phash: ackNode.attrs.phash,
                        addressingMode: ackNode.attrs.addressing_mode,
                        attempts: attempt
                    })
                } else {
                    logger.trace('message publish acknowledged', {
                        id,
                        tag: ackNode.tag,
                        type: ackNode.attrs.type,
                        phash: ackNode.attrs.phash,
                        addressingMode: ackNode.attrs.addressing_mode
                    })
                }
                return {
                    id,
                    attempts: attempt,
                    ackNode,
                    ack: this.extractAckMetadata(ackNode)
                }
            } catch (error) {
                lastError = toError(error)
                const nackError = error instanceof MessagePublishNackError ? error : null
                const nackRetryable = nackError?.retryable ?? false
                const logContext = nackLogContext ?? {
                    attempt,
                    maxAttempts,
                    nackRetryable,
                    message: lastError.message
                }
                const canRetry =
                    attempt < maxAttempts &&
                    (this.isRetryablePublishError(lastError) || nackRetryable)
                if (canRetry) {
                    logger.debug('message publish attempt failed, will retry', logContext)
                    await delay(retryDelayMs * attempt)
                    continue
                }
                logger.warn('message publish attempt failed', logContext)
                throw lastError
            }
        }

        throw lastError ?? new Error('message publish failed')
    }

    /** Builds the encrypted message envelope from `input` and publishes it via {@link publishNode}. */
    public async publishEncrypted(
        input: WaEncryptedMessageInput,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        const node = this.buildEncryptedMessageNode(input)
        return this.publishNode(node, options)
    }

    /** Fire-and-forget variant: sends a `<message>` stanza without awaiting an ack. */
    public async sendMessageNode(node: BinaryNode): Promise<void> {
        if (node.tag !== WA_MESSAGE_TAGS.MESSAGE) {
            throw new Error(`invalid node tag for message send: ${node.tag}`)
        }
        this.logger.debug('message sent without waiting for ack', {
            to: node.attrs.to,
            type: node.attrs.type,
            id: node.attrs.id
        })
        await this.sendNode(node)
    }

    /** Builds and sends an encrypted message envelope without awaiting an ack. */
    public async sendEncrypted(input: WaEncryptedMessageInput): Promise<void> {
        const node = this.buildEncryptedMessageNode(input)
        await this.sendMessageNode(node)
    }

    private buildEncryptedMessageNode(input: WaEncryptedMessageInput): BinaryNode {
        const attrs: Record<string, string> = {
            to: input.to,
            type: input.type ?? 'text'
        }
        if (input.id) {
            attrs.id = input.id
        }
        if (input.edit) {
            attrs.edit = input.edit
        }
        if (input.category) {
            attrs.category = input.category
        }
        if (input.pushPriority) {
            attrs.push_priority = input.pushPriority
        }
        if (input.participant) {
            attrs.participant = input.participant
        }
        if (input.addressingMode) {
            attrs.addressing_mode = input.addressingMode
        }
        if (input.deviceFanout) {
            attrs.device_fanout = input.deviceFanout
        }
        const encAttrs: Record<string, string> = {
            v: WA_MESSAGE_TYPES.ENC_VERSION,
            type: input.encType
        }
        if (input.mediatype) {
            encAttrs.mediatype = input.mediatype
        }
        if (input.encCount !== undefined && input.encCount > 0) {
            encAttrs.count = String(Math.trunc(input.encCount))
        }
        const content: BinaryNode[] = [
            {
                tag: WA_MESSAGE_TAGS.ENC,
                attrs: encAttrs,
                content: input.ciphertext
            }
        ]
        if (input.deviceIdentity) {
            content.push({
                tag: WA_NODE_TAGS.DEVICE_IDENTITY,
                attrs: {},
                content: input.deviceIdentity
            })
        }
        if (input.metaNode) {
            content.push(input.metaNode)
        }
        if (input.privacyTokenNode) {
            content.push(input.privacyTokenNode)
        }
        const node: BinaryNode = {
            tag: WA_MESSAGE_TAGS.MESSAGE,
            attrs,
            content
        }
        return node
    }

    /** Builds and sends a `<receipt>` stanza (delivery/read/played/etc.). */
    public async sendReceipt(input: WaSendReceiptInput): Promise<void> {
        const node = buildReceiptNode({
            kind: 'outbound',
            to: input.to,
            id: input.id,
            type: input.type ?? WA_MESSAGE_TYPES.RECEIPT_TYPE_READ,
            participant: input.participant,
            recipient: input.recipient,
            category: input.category,
            from: input.from,
            t: input.t,
            peerParticipantPn: input.peerParticipantPn,
            listIds: input.listIds,
            content: input.content ? [...input.content] : undefined
        })
        this.logger.debug('sending receipt node', {
            to: node.attrs.to,
            id: node.attrs.id,
            type: node.attrs.type
        })
        await this.sendNode(node)
    }

    private isRetryablePublishError(error: Error): boolean {
        return WA_RETRYABLE_PUBLISH_ERROR_RE.test(error.message)
    }

    private extractAckMetadata(ackNode: BinaryNode): WaMessageAckMetadata {
        const addressingModeRaw = ackNode.attrs.addressing_mode
        const addressingMode =
            addressingModeRaw === WA_ADDRESSING_MODES.PN ||
            addressingModeRaw === WA_ADDRESSING_MODES.LID
                ? addressingModeRaw
                : undefined
        return {
            t: ackNode.attrs.t,
            sync: ackNode.attrs.sync,
            phash: ackNode.attrs.phash,
            refreshLid: ackNode.attrs.refresh_lid === 'true',
            addressingMode,
            count: parseOptionalInt(ackNode.attrs.count),
            error: parseOptionalInt(ackNode.attrs.error)
        }
    }
}
