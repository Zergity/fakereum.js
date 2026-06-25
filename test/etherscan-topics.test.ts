import { describe, expect, it } from 'vitest'
import { completeTopicOperators, topicOrGroups } from '../src/etherscan'
import { logMatches, parseLogFilter } from '../src/sandbox'
import type { Hex } from '../src/lib/hex'
import type { StoredLog } from '../src/types'

// cafe… as a 32-byte address-padded topic, and three unrelated fillers.
const V = '0x000000000000000000000000cafe567980b368f045f97d89b247e7fdfd130bf3' as Hex
const OTHER = '0x0000000000000000000000000e4831319a50228b9e450861297ab92dee15b44f' as Hex
const ZERO = ('0x' + '0'.repeat(64)) as Hex
const SIG_A = '0xad05b4d6e93e902856d1a65a7cb9b0d22f5a8e0bf540c2006e88f586ac265cf1' as Hex
const SIG_B = '0xaa2d0f620000000000000000000000000000000000000000000000000000aaaa' as Hex

function log(topics: Hex[]): StoredLog {
  return {
    address: '0xae57db431009c391d5819aeb48541628d132df1a' as Hex,
    topics,
    data: '0x' as Hex,
    blockNumber: '0x1c6f37a6' as Hex,
    blockHash: ('0x' + '1'.repeat(64)) as Hex,
    transactionHash: ('0x' + '2'.repeat(64)) as Hex,
    transactionIndex: '0x0' as Hex,
    logIndex: '0x0' as Hex,
    removed: false,
  }
}

// The three sandbox logs from the bug report: each carries V in a *different*
// indexed position, so no single log has V in more than one of {1,2,3}.
const LOG_POS1 = log([SIG_A, V, OTHER, OTHER]) // matches topic1
const LOG_POS2 = log([SIG_A, OTHER, V, OTHER]) // matches topic2
const LOG_POS3 = log([SIG_B, OTHER, ZERO, V]) // matches topic3
const ALL = [LOG_POS1, LOG_POS2, LOG_POS3]

// Mirror sandbox_do.ts:etherscanFilterObj — the conversion under test.
function etherscanFilter(qs: string) {
  const params = new URLSearchParams(qs)
  const obj: Record<string, unknown> = { fromBlock: '0x0', toBlock: 'latest' }
  const topics: (string | null)[] = []
  for (let i = 0; i < 4; i++) topics.push(params.get('topic' + i) ?? null)
  if (topics.some((t) => t !== null)) {
    obj['topics'] = topics
    obj['topicGroups'] = topicOrGroups(params)
  }
  return parseLogFilter([obj])
}

function matched(qs: string): StoredLog[] {
  const f = etherscanFilter(qs)
  return ALL.filter((l) => logMatches(f, l))
}

describe('topicOrGroups', () => {
  it('groups two OR-connected positions', () => {
    const p = new URLSearchParams(`topic1=${V}&topic2=${V}&topic1_2_opr=or`)
    expect(topicOrGroups(p)).toEqual([[1, 2]])
  })

  it('merges a chained 3-way OR via transitive closure (only 1_2 + 2_3 given)', () => {
    const p = new URLSearchParams(
      `topic1=${V}&topic2=${V}&topic3=${V}&topic1_2_opr=or&topic2_3_opr=or`,
    )
    expect(topicOrGroups(p)).toEqual([[1, 2, 3]])
  })

  it('keeps AND positions as separate singleton groups', () => {
    const p = new URLSearchParams(
      `topic1=${V}&topic2=${V}&topic3=${V}&topic1_2_opr=or&topic2_3_opr=and`,
    )
    // 1~2 OR-joined; 3 stands alone -> (pos1 OR pos2) AND pos3.
    expect(topicOrGroups(p)).toEqual([[1, 2], [3]])
  })

  it('returns a singleton for a lone topic', () => {
    expect(topicOrGroups(new URLSearchParams(`topic1=${V}`))).toEqual([[1]])
  })

  it('is empty when no topic is present', () => {
    expect(topicOrGroups(new URLSearchParams(`address=0xabc`))).toEqual([])
  })
})

describe('getLogs sandbox matching honors topicI_J_opr=or', () => {
  it('2-topic OR returns the union of positions 1 and 2', () => {
    const got = matched(`topic1=${V}&topic2=${V}&topic1_2_opr=or`)
    expect(got).toEqual([LOG_POS1, LOG_POS2])
  })

  it('3-topic OR returns the union of positions 1, 2 and 3 (the bug)', () => {
    // Before the fix this ANDed the positions and returned [] — fewer than the
    // 2-topic result, which is impossible for a strictly wider OR.
    const got = matched(`topic1=${V}&topic2=${V}&topic3=${V}&topic1_2_opr=or&topic2_3_opr=or`)
    expect(got).toEqual([LOG_POS1, LOG_POS2, LOG_POS3])
  })

  it('a wider OR is always a superset of a narrower OR', () => {
    const two = matched(`topic1=${V}&topic2=${V}&topic1_2_opr=or`)
    const three = matched(`topic1=${V}&topic2=${V}&topic3=${V}&topic1_2_opr=or&topic2_3_opr=or`)
    expect(two.every((l) => three.includes(l))).toBe(true)
    expect(three.length).toBeGreaterThanOrEqual(two.length)
  })

  it('still ANDs positions when no OR operator is given', () => {
    // No _opr -> each position its own group -> AND. No log has V in both 1 and 2.
    expect(matched(`topic1=${V}&topic2=${V}`)).toEqual([])
  })

  it('mixed OR/AND: (pos1 OR pos2) AND pos3 matches only logs satisfying both', () => {
    // LOG_POS3 has pos3=V but neither pos1 nor pos2 = V -> excluded.
    // No log has (pos1 or pos2)=V AND pos3=V, so the result is empty.
    const got = matched(`topic1=${V}&topic2=${V}&topic3=${V}&topic1_2_opr=or&topic2_3_opr=and`)
    expect(got).toEqual([])
  })
})

describe('completeTopicOperators still derives the closure (upstream path)', () => {
  it('fills the missing 1_3 operator as or', () => {
    const p = new URLSearchParams(
      `topic1=${V}&topic2=${V}&topic3=${V}&topic1_2_opr=or&topic2_3_opr=or`,
    )
    completeTopicOperators(p)
    expect(p.get('topic1_3_opr')).toBe('or')
    expect(p.get('topic1_2_opr')).toBe('or')
    expect(p.get('topic2_3_opr')).toBe('or')
  })
})
