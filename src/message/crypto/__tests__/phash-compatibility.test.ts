import assert from 'node:assert/strict'
import test from 'node:test'

import { sha256 } from '@crypto/core'
import { computePhashV2 } from '@message/crypto/phash'
import { bytesToBase64, TEXT_ENCODER } from '@util/bytes'

function referencePhash(canonical: readonly string[]): string {
    if (canonical.length === 0) return '2:'
    const digest = sha256(TEXT_ENCODER.encode([...canonical].sort().join('')))
    return `2:${bytesToBase64(digest.subarray(0, 6))}`
}

test('phash preserves legacy canonicalization, duplicates and the caller array', () => {
    const input = [
        '5511@c.us',
        '5511.0:2@s.whatsapp.net',
        '900:3@lid',
        '5511:0@s.whatsapp.net',
        '900:3@lid'
    ]
    const before = [...input]
    const canonical = [
        '5511.0:0@s.whatsapp.net',
        '5511.0:2@s.whatsapp.net',
        '900.0:3@lid',
        '5511.0:0@s.whatsapp.net',
        '900.0:3@lid'
    ]
    assert.equal(computePhashV2(input, 4_096), referencePhash(canonical))
    assert.equal(computePhashV2([...input].reverse(), 4_096), referencePhash(canonical))
    assert.deepEqual(input, before)
})

test('phash matches the reference through repeated growth and shrinking calls', () => {
    for (const count of [0, 1, 16, 2_048, 4_096, 3, 127, 2_049, 1]) {
        const input = Array.from({ length: count }, (_, index) => `55${index}:2@c.us`)
        const canonical = Array.from(
            { length: count },
            (_, index) => `55${index}.0:2@s.whatsapp.net`
        )
        assert.equal(computePhashV2(input, 4_096), referencePhash(canonical), `size ${count}`)
    }
})

test('phash accepts the exact explicit limit and rejects the next device', () => {
    const input = ['5511@c.us', '5512@c.us']
    assert.match(computePhashV2(input, 2), /^2:/)
    assert.throws(() => computePhashV2([...input, '5513@c.us'], 2), /exceeds maxParticipants 2/)
})

for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity, 16_385]) {
    test(`phash rejects invalid explicit limit ${String(limit)} even for an empty list`, () => {
        assert.throws(() => computePhashV2([], limit), /phash maxParticipants must be an integer/)
    })
}

test('phash allows the legacy maximum when explicitly configured', () => {
    assert.match(computePhashV2(['5511@c.us'], 16_384), /^2:/)
})
