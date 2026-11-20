import { EventEmitter } from 'node:events'

import { ConsoleLogger } from '@infra/log/ConsoleLogger'
import type { Logger } from '@infra/log/types'
import { decodeBinaryNodeStanza, encodeBinaryNodeStanza } from '@transport/binary'
import { formatBinaryNodeAsXml } from '@transport/node/xml'
import type { BinaryNode } from '@transport/types'
import type { WaComms } from '@transport/WaComms'
import { toError } from '@util/primitives'

/**
 * Bridges encoded binary stanzas to/from {@link WaComms}: encodes outbound
 * {@link BinaryNode}s into framed bytes, decodes incoming frames back into
 * nodes, and re-emits `node_in`/`node_out`/`frame_in`/`frame_out`/
 * `decode_error` events for debug observers.
 */
export class WaNodeTransport extends EventEmitter {
    private readonly logger: Logger
    private comms: WaComms | null

    public constructor(logger: Logger = new ConsoleLogger('info')) {
        super()
        this.logger = logger
        this.comms = null
    }

    /** Attaches (or detaches with `null`) the {@link WaComms} instance used to write frames. */
    public bindComms(comms: WaComms | null): void {
        this.comms = comms
        this.logger.debug('node transport bindComms', { connected: comms !== null })
    }

    /** Encodes `node` as a stanza frame and writes it through the bound comms. Throws when not connected. */
    public async sendNode(node: BinaryNode): Promise<void> {
        const comms = this.comms
        if (!comms) {
            throw new Error('comms is not connected')
        }
        this.logger.trace('node transport send node', {
            tag: node.tag,
            id: node.attrs.id,
            type: node.attrs.type,
            xml: this.shouldIncludeTraceXml() ? formatBinaryNodeAsXml(node) : undefined
        })
        const frame = encodeBinaryNodeStanza(node)
        this.emit('node_out', node, frame)
        this.emit('frame_out', frame)
        await comms.sendFrame(frame)
    }

    /**
     * Decodes an incoming frame and forwards the resulting {@link BinaryNode}
     * to `onNode`. Stream-end frames are silently dropped; decode errors are
     * logged and surfaced via the `decode_error` event without throwing.
     */
    public async dispatchIncomingFrame(
        frame: Uint8Array,
        onNode: (node: BinaryNode) => Promise<void> | void
    ): Promise<void> {
        const node = await this.decodeIncomingFrame(frame)
        if (node) await onNode(node)
    }

    /**
     * Decodes once before ordinary handler admission, preserving observation events.
     * Returns `null` for stream-end, invalid input or a replaced connection. The optional
     * generation predicate is rechecked after async decompression and before node events.
     * Decode failures keep the existing logged `decode_error` behavior.
     * @param frame Stanza payload after Noise decryption.
     * @param isCurrent Optional connection-generation predicate for obsolete input.
     * @param onDecodedByteLength Receives the expanded body size for queue accounting.
     * @returns A decoded node, or `null` when dropped, invalid or obsolete.
     */
    public async decodeIncomingFrame(
        frame: Uint8Array,
        isCurrent?: () => boolean,
        onDecodedByteLength?: (byteLength: number) => void
    ): Promise<BinaryNode | null> {
        if (isCurrent?.() === false) return null
        this.emit('frame_in', frame)
        let node: BinaryNode
        try {
            node = await decodeBinaryNodeStanza(frame, onDecodedByteLength)
        } catch (error) {
            if (isCurrent?.() === false) return null
            const normalized = toError(error)
            if (normalized.message === 'stream end stanza is not a binary node') {
                return null
            }
            this.logger.warn('failed to decode binary node frame', {
                message: normalized.message
            })
            this.emit('decode_error', normalized, frame)
            return null
        }
        if (isCurrent?.() === false) return null
        this.emit('node_in', node, frame)
        this.logger.trace('node transport node in', {
            tag: node.tag,
            id: node.attrs.id,
            type: node.attrs.type,
            xml: this.shouldIncludeTraceXml() ? formatBinaryNodeAsXml(node) : undefined
        })
        return node
    }

    private shouldIncludeTraceXml(): boolean {
        return this.logger.level === 'trace'
    }
}
