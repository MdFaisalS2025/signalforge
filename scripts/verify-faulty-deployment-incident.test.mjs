import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSinglePartitionHighWatermark, compareExactTraceSets, parseConsumerGroupSummary } from './verify-faulty-deployment-incident.mjs';

test('identical trace sets match regardless of order', () => {
  assert.equal(compareExactTraceSets(['b', 'a', 'c'], ['a', 'c', 'b']).equal, true);
});

test('the six-trace union matches the cumulative deployment result', () => {
  const trigger = ['t1', 't2', 't3'];
  const dedup = ['d1', 'd2', 'd3'];
  const cumulative = ['d3', 't1', 'd1', 't3', 'd2', 't2'];
  assert.equal(compareExactTraceSets(cumulative, [...trigger, ...dedup]).equal, true);
});

test('comparing only the second batch against the cumulative six traces fails', () => {
  const cumulative = ['t1', 't2', 't3', 'd1', 'd2', 'd3'];
  const result = compareExactTraceSets(cumulative, ['d1', 'd2', 'd3']);
  assert.equal(result.equal, false);
  assert.deepEqual(result.onlyActual, ['t1', 't2', 't3']);
  assert.deepEqual(result.onlyExpected, []);
});

test('duplicate IDs do not make unequal sets pass', () => {
  assert.equal(compareExactTraceSets(['a', 'a', 'b'], ['a', 'b']).equal, false);
  assert.equal(compareExactTraceSets(['a', 'b'], ['a', 'b', 'b']).equal, false);
});

// Captured from: rpk topic describe incidents.created.v1 -p (RPK v24.2.7).
const CAPTURED = [
  'PARTITION  LEADER  EPOCH  REPLICAS  LOG-START-OFFSET  HIGH-WATERMARK',
  '0          0       12     [0]       0                 3',
  '',
].join('\n');

test('returns the exact numeric high-watermark for the single partition', () => {
  assert.equal(parseSinglePartitionHighWatermark(CAPTURED), 3);
});

test('rejects output without a HIGH-WATERMARK column', () => {
  const text = CAPTURED.replace('HIGH-WATERMARK', 'HIGH-MARK');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /HIGH-WATERMARK/);
});

test('rejects a non-numeric high-watermark', () => {
  const text = CAPTURED.replace(/0\s+0\s+12\s+\[0\]\s+0\s+3/, '0          0       12     [0]       0                 three');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /not numeric/);
});

test('rejects output with zero partition rows', () => {
  const text = CAPTURED.split('\n')[0];
  assert.throws(() => parseSinglePartitionHighWatermark(text), /expected exactly one partition row, got 0/);
});

test('rejects output with multiple partition rows', () => {
  const text = [CAPTURED.split('\n')[0], '0 0 12 [0] 0 3', '1 0 12 [0] 0 5', ''].join('\n');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /expected exactly one partition row, got 2/);
});

test('rejects a nonzero partition', () => {
  const text = CAPTURED.replace(/^0 /m, '1 ');
  assert.throws(() => parseSinglePartitionHighWatermark(text), /expected partition 0/);
});

// Captured from: rpk group describe collector-go-normalizer -s (RPK v24.2.7). The BALANCER value is empty.
const SUMMARY_EMPTY = [
  'GROUP        collector-go-normalizer',
  'COORDINATOR  0',
  'STATE        Empty',
  'BALANCER     ',
  'MEMBERS      0',
  'TOTAL-LAG    0',
  '',
].join('\n');

test('a Stable group with one member parses to its state and count', () => {
  const text = SUMMARY_EMPTY.replace('Empty', 'Stable').replace('MEMBERS      0', 'MEMBERS      1');
  assert.deepEqual(parseConsumerGroupSummary(text), { state: 'Stable', members: 1 });
});

test('a PreparingRebalance group with several members parses but reports its own state', () => {
  const text = SUMMARY_EMPTY.replace('Empty', 'PreparingRebalance').replace('MEMBERS      0', 'MEMBERS      2');
  assert.deepEqual(parseConsumerGroupSummary(text), { state: 'PreparingRebalance', members: 2 });
});

test('output without a STATE line is rejected with a clear error', () => {
  const text = SUMMARY_EMPTY.replace(/STATE.*\n/, '');
  assert.throws(() => parseConsumerGroupSummary(text), /no STATE line/);
});

test('output without a MEMBERS line is rejected with a clear error', () => {
  const text = SUMMARY_EMPTY.replace(/MEMBERS.*\n/, '');
  assert.throws(() => parseConsumerGroupSummary(text), /no MEMBERS line/);
});

test('a non-numeric member count is rejected', () => {
  const text = SUMMARY_EMPTY.replace('MEMBERS      0', 'MEMBERS      many');
  assert.throws(() => parseConsumerGroupSummary(text), /MEMBERS is not numeric/);
});
