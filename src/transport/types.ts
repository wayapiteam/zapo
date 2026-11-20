import type { Agent as HttpAgent } from 'node:http'
import type { Agent as HttpsAgent } from 'node:https'

import type { SignalKeyPair } from '@crypto/curves/types'
import type { WaLoginPayloadConfig, WaRegistrationPayloadConfig } from '@transport/noise/types'
import type { WaNoiseRootCa } from '@transport/noise/WaNoiseCert'

export interface WaProxyDispatcher {
    dispatch(...args: readonly unknown[]): unknown
}

export type WaProxyAgent = HttpAgent | HttpsAgent

export type WaProxyTransport = WaProxyDispatcher | WaProxyAgent

export interface BinaryNode {
    readonly tag: string
    readonly attrs: Readonly<Record<string, string>>
    readonly content?: Uint8Array | string | readonly BinaryNode[]
}

/** Ordinary stanza work, admitted to the bounded handler queue after preparation. */
export type WaPreparedStanzaHandler = () => void | Promise<void>

/**
 * Prepares one decoded Noise frame without awaiting ordinary handler work.
 * Return `null` when consumed/dropped, or a callback for bounded ordinary dispatch.
 * Check `isCurrent()` after asynchronous decoding and before resolving pending work.
 * The callback is checked again against its connection generation before execution.
 * A reset discards queued callbacks, not already-running work. Callbacks must bound
 * their own I/O; an earlier generation's running callbacks may finish after reconnect.
 * Report expanded stanza bytes through `onDecodedByteLength` when decoding compressed
 * input, so ordinary work is charged for the decoded body rather than compressed wire size.
 */
export type WaStanzaPreparer = (
    frame: Uint8Array,
    isCurrent: () => boolean,
    onDecodedByteLength: (byteLength: number) => void
) => Promise<WaPreparedStanzaHandler | null>

export interface SocketOpenInfo {
    readonly openedAt: number
}

export interface SocketCloseInfo {
    readonly code: number
    readonly reason: string
    readonly wasClean: boolean
}

export interface WaSocketConfig {
    /** Single WebSocket URL. Mutually exclusive with {@link urls}; the URL list takes precedence when both are set. */
    readonly url?: string
    /** Failover URL list – tried in order until one connects. Overrides {@link url}. */
    readonly urls?: readonly string[]
    /** WebSocket sub-protocols to advertise. Defaults to none. */
    readonly protocols?: readonly string[]
    /** Extra HTTP headers sent with the WebSocket upgrade. */
    readonly headers?: Readonly<Record<string, string>>
    /** undici-style proxy dispatcher (preferred when the runtime supports it). */
    readonly dispatcher?: WaProxyDispatcher
    /** Node `http.Agent`-style proxy (fallback when `dispatcher` is unavailable). */
    readonly agent?: WaProxyAgent
    /** Idle timeout (ms) – if no frame arrives in this window the socket is closed. */
    readonly timeoutIntervalMs?: number
    /** Override the `RawWebSocket` constructor (e.g. {@link WaMobileTcpSocketCtor} for the mobile TCP transport). */
    readonly rawWebSocketConstructor?: RawWebSocketConstructor
}

export interface WaSocketHandlers {
    readonly onOpen?: (info: SocketOpenInfo) => void | Promise<void>
    readonly onClose?: (info: SocketCloseInfo) => void | Promise<void>
    readonly onError?: (error: Error) => void | Promise<void>
    readonly onMessage?: (payload: Uint8Array) => void | Promise<void>
}

export interface WaCommsConfig extends WaSocketConfig {
    /** Maximum time (ms) the initial WebSocket open is allowed to take. */
    readonly connectTimeoutMs?: number
    /** Base delay (ms) between reconnect attempts after a close. */
    readonly reconnectIntervalMs?: number
    /** Max number of reconnect attempts before giving up. Default: unbounded. */
    readonly maxReconnectAttempts?: number
    /** Noise handshake configuration (credentials, login payload, root CA, ...). */
    readonly noise: WaNoiseConfig
}

export interface WaCommsState {
    readonly started: boolean
    readonly connected: boolean
    readonly handlingRequests: boolean
    readonly reconnectAttempts: number
}

export interface WaNoiseConfig {
    readonly clientStaticKeyPair: SignalKeyPair
    readonly isRegistered: boolean
    readonly loginPayload?: Uint8Array | (() => Uint8Array | Promise<Uint8Array>)
    readonly registrationPayload?: Uint8Array | (() => Uint8Array | Promise<Uint8Array>)
    readonly loginPayloadConfig?: WaLoginPayloadConfig
    readonly registrationPayloadConfig?: WaRegistrationPayloadConfig
    readonly serverStaticKey?: Uint8Array
    readonly routingInfo?: Uint8Array
    readonly protocolHeader?: Uint8Array
    readonly verifyCertificateChain?: boolean
    readonly trustedRootCa?: WaNoiseRootCa
}

export interface WebSocketEventLike {
    readonly code?: number
    readonly reason?: string
    readonly wasClean?: boolean
    readonly data?: unknown
}

export interface RawWebSocket {
    binaryType: string
    readyState: number
    onopen: ((event: WebSocketEventLike) => void) | null
    onclose: ((event: WebSocketEventLike) => void) | null
    onerror: ((event: WebSocketEventLike) => void) | null
    onmessage: ((event: WebSocketEventLike) => void) | null
    close(code?: number, reason?: string): void
    send(data: string | ArrayBuffer | Uint8Array): void
}

export interface WaRawWebSocketInit {
    readonly protocols?: string | readonly string[]
    readonly headers?: Readonly<Record<string, string>>
    readonly dispatcher?: WaProxyDispatcher
    readonly agent?: WaProxyAgent
}

export type RawWebSocketConstructor = new (
    url: string,
    protocols?: string | readonly string[] | WaRawWebSocketInit,
    options?: {
        headers?: Readonly<Record<string, string>>
        dispatcher?: WaProxyDispatcher
        agent?: WaProxyAgent
    }
) => RawWebSocket
