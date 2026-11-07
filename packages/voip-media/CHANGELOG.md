# @zapo-js/voip-media

## 0.3.0

### Minor Changes

- 1ebadd9: Carry group-call media: a relay the server moves the call to, a decoder per sender, and per-participant keys and attribution.

    The media plan gains a `group` section listing every sender with its SSRCs, receive keying material and roster pid. The plane keys SRTP and SRTCP per sender, decodes each one on its own MLow decoder, mixes them for playout, and drops packets from SSRCs the plan doesn't list. Relays come in generations: a newer one is dialled at once, even with legs open. The send stays on the newest generation unless peer media keeps arriving only on an older one, and an older generation is retired once authenticated peer media arrives on the newer one. A relay that only re-issues its credentials is rebound in place, on the same socket or connection. WARP-framed downlink packets are unwrapped, PT 122 audio is decoded as plain MLow on the PT 120 timeline, and the allocate can carry a self-only stream descriptor and an optional video subscription. Reactions, inbound video and a new `sender_media` event name the sender they came from, and a remote host announces what it supports through a `host` event, keeping wire version 1.

- caeace8: Narrow the public surface to what a media host uses, and cut the per-packet cost of receiving and sending.

    **Breaking.** These exports are gone; the call plane, the web host and the remote-media protocol keep working without them:
    - app data: `decodeAppDataPayload`, `encodeReactionPayload`, `WaAppDataStream`, `WaAppDataPayload`, `WaAppDataStreamOptions`
    - SRTP: `randomInt`, `SRTCP_AUTH_TAG_LEN`, `SrtcpContext`, `SrtcpSession`, `SRTP_MAX_RECV_CONTEXTS`, `SrtpError`, `SrtpSession`, `SRTP_AUTH_TAG_LEN`, `SRTP_LABEL`, `SRTP_RECV_AUTH_TAG_LEN`, `SRTP_SEND_AUTH_TAG_LEN`
    - RTP and RTCP: `RtpHeader`, `RtpPacket`, `RtpSession`, `WA_RTP_EXTENSION_PROFILE`, `PayloadType`, `buildFullIntraRequest`, `buildPictureLossIndication`, `buildReceiverEstimatedMaxBitrate`, `buildSenderReportWithSdes`, `nextAudioReceiverEstimate`, `nextReceiverMaxBitrate`, `RTCP_CNAME_LENGTH`, `RtpStreamReception`, `SenderReportSchedule`, `WA_FAST_REMB_ELEMENT_LENGTH`, `WA_FAST_REMB_EXTENSION_ID`, `writeFastRembExtension`
    - H.264: `H264Depacketizer`, `H264AccessUnit`, `packetizeH264AnnexB` (`isH264KeyFrame` stays)
    - MLow: `MLOW_ENCODER_CTL`, `MLowCodec`, `MLowCodecOptions`, `MLowCodecStats`, `MLowEncoderTunables`
    - clock and buffering: `WaJitterBuffer` (`WaJitterBufferStats` stays), `HostCaptureTimeMapper`, `MEDIA_CLOCK_ORIGIN_LEAD_MS`, `WaMediaClock`
    - relay: `isRtcpPacket`, `isRtpPacket`, `isStunPacket`, `TRUE_WEB_CLIENT_RELAY_PORT`, `WaSctpRelay`, `WaSctpRelayOptions`

    For code that still reaches the SRTP classes: `unprotect` on `SrtpSession` and `SrtcpSession` returns `null` for a replayed or duplicate packet instead of throwing, `SrtpError['type']` is now only `'packet_too_short' | 'auth_failed'`, and `SrtpSession.setSendAuthKeying` is removed.

    `Logger.level` is optional: a logger without it is treated as emitting every level. The new `isLogLevelEnabled(logger, level)` and the `LogLevel` type are exported, and per-packet trace logs are only built when `trace` is enabled.

    `WaCallAudioSink.pushCapture` and `WaCallVideoSink.sendVideoFrame` may reuse the buffer they are handed once the call returns: copy `samples` or `data` to keep them.

    Receiving costs less: the SRTP replay window no longer uses `BigInt`, session keys are derived once per keying instead of once per SSRC, the browser crypto caches its HMAC and AES key state, PT 121 audio is parsed once, the H.264 depacketizer copies a frame once when it completes, and a group call's mixer skips senders with nothing queued. Sending an H.264 frame scans it once. ICE-disconnect timers and relay-opened data channels are released when a relay leg closes.

## 0.2.0

### Minor Changes

- 04073f8: Pack two 60 ms MLow frames per audio packet when the peer's `voip_settings` allows it (`maxfpp`), as the official clients do, and decode and encode MLow without allocating per frame. PT 121 audio is kept apart from video FEC. An optional MLow Companion model (the NoLACE post-filter, weights supplied by the host) can run on the decoder.
- 961bdaf: Add `setPlayoutMuted`, `setMicrophone` and `setOutput` to `WaWebCallAudio`, and an `output` option to `start`.

    `setPlayoutMuted` silences the speaker through a gain node with a short ramp and keeps pulling playout, so a call comes back from hold in step. `setMicrophone` swaps only the source node, keeping the worklet and the context; a stream the context refuses throws and leaves the current microphone running. `output` picks the output device through the `sinkId` option of the `AudioContext` constructor, or `setSinkId` where the constructor ignores it, and `setOutput` through `setSinkId` (Chrome, Edge), on the context the adapter creates, which it still resumes and still falls back to the device rate with; where the browser has no `setSinkId` they fail with a `NotSupportedError`, except for the default device, `''`, which the context already plays to. A context passed in keeps its own output.

### Patch Changes

- 04073f8: Send a REMB on the peer's audio stream, and keep MLow RED on the layout the official clients accept.

    The peer's audio quality control stayed in its 15 kbps probing state for the whole call, because it only leaves it on a REMB received on the audio stream. `WaCallMediaPlane` now sends one (PSFB 206, FMT 15) once per RTCP interval, from its audio SSRC on the peer's: 24 kbps at first, up to a steady 30 kbps on a clean stream, down on loss to 16 kbps at least. `vid_rc.disable_rtcp_remb` still applies to the video one only.

    With `mlowRed` on, RED stays the copy-first multiframe stamped on the copy, which WA Web takes without any negotiation. The official in-band layout, a compact RFC 2198 of `[0x80 | 10 ms steps back][length]` per copy, a `0x00` primary header, the copies then the frame, stays internal: an official client takes it only on PT 121 and behind its RX gate (`enable_red_pt_support_rx`), which the server sets, and rejects it on PT 120. `MLowCodec.decodeSequenced` reads the copy-first multiframe on either payload type and the in-band layout on PT 121, playing a copy only in the slot of a lost packet.

- 04073f8: Play the peer's audio when it arrives on PT 121.

    A peer with the separate MLow payload type negotiated sends all of its audio on PT 121, plain MLow frames, and the plane discarded it, so the call went mute. A PT 121 packet that parses as MLow now decodes on the same timeline as PT 120, its sequence numbers kept apart, so a slot both payload types carry plays once. `audioRedDiscarded` counts only the PT 121 packets that parse as neither MLow nor in-band RED. `MLowCodec.decodeSequenced` takes an optional `stream` (0 or 1) for the second numbering.

- 04073f8: Report the relays that answer the call's legs.

    `WaCallMediaPlane` takes an `onRelayAnswered(name, rttMs?)` callback, fired the first time each relay answers, with the round trip from the leg's first allocate when one went out. `WaCallMediaReceiver` sends it to signaling as a `relay_answered` event, and its `active` event now carries `reportsRelayAnswers: true` so signaling can tell it from an older host. The wire version stays 1: signaling that predates the event ignores it.

## 0.1.2

### Patch Changes

- 64767d9: Send an H.264 key frame in the shape the official WhatsApp clients use, so a phone that answers our video call renders it.

    `packetizeH264AnnexB` sent the SPS and PPS of a key frame as their own single-NAL packets, which the Android client discards, so it never rendered a frame and kept requesting key frames. A key frame (an IDR behind an SPS) now goes out whole in one STAP-A when it fits a packet, and otherwise as one FU-A typed SPS that carries the rest of the access unit with its inner start codes. Delta frames and access units without an SPS ahead of their IDR are packetized as before.

## 0.1.1

### Patch Changes

- 808f920: Export `dialableRelayEndpoints`, the rule the media plane picks the relays it dials by, so signaling can answer `relaylatency` for exactly the relays the plane dials.
- fa528f1: Follow the peer to another relay, and leave out relays that stop answering.

    When the leg carrying our media dies on one side only, the other side kept sending to the old relay and this side heard nothing for the rest of the call. Our media now moves to the leg the peer's authenticated packets arrive on once the current one has been silent for 400 ms, and a relay that leaves a ping unanswered for four seconds is left out of the election until it answers again. Relays are pinged every five seconds while the call sets up and every second once media flows.

- fa528f1: Redial a silent relay leg once on the other port.

    A leg that does not open within five seconds, opens and hears nothing from its relay within four, or dies before its first answer, is dialled again on the other port (3480 or the one the offer advertises), so a call still connects when the dialled port does not fit the relay. An endpoint that already advertises 3480 has no other port and is not redialled.

- fa528f1: Send call media on one relay leg instead of all of them.

    Every RTP, RTCP and app-data packet went out on every open relay leg, so the peer received each one several times and dropped the copies as SRTP replays, and the uplink cost several times what it should. Only the sending changes: media now goes out through `WaSctpRelay.sendMedia` on a single leg, and the other legs carry only STUN and keepalives outbound. Every leg still receives, and the peer's media arriving on another leg can move our sending there. The call stats add `srtpReplays`, `srtpAuthFailures` and `srtpOtherErrors`, and `srtpErrors` stays their sum.
