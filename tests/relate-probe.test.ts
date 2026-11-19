import { describe, expect, it } from 'vitest';
import { RelateDb } from '@relate/relate-wasm';
import {
  initRelateWasmNode,
  parseRelateEnvelope,
  probeRelateWasm,
  RelateEnvelopeError,
} from '../src/engine/probe.js';

describe('@relate/relate-wasm@1.1.0 runtime probe and envelope parser', () => {
  it('loads pinned 1.1.0 WASM in Node, builds a POINT INDEX, and runs static rel-type shortestPath', () => {
    const result = probeRelateWasm();

    expect(result.wasmPackageVersion).toBe('1.1.0');
    expect(result.indexEnvelope.error).toBeNull();
    expect(result.indexEnvelope.stats.indexes_added).toBe(1);

    expect(result.openRouteEnvelope.error).toBeNull();
    expect(result.openRouteEnvelope.columns).toEqual(['fromCode', 'toCode', 'hops', 'totalKm']);
    expect(result.openRouteEnvelope.rows).toEqual([
      { fromCode: 'TWKHH', toCode: 'NLRTM', hops: 2, totalKm: 15700 },
    ]);
    expect(typeof result.openRouteEnvelope.executeMs).toBe('number');

    expect(result.blockedRouteEnvelope.error).toBeNull();
    expect(result.blockedRouteEnvelope.rows).toEqual([
      { fromCode: 'TWKHH', toCode: 'NLRTM', hops: 3, totalKm: 24000 },
    ]);
  });

  it('surfaces real WASM Cypher syntax errors through envelope.error without swallowing them', () => {
    initRelateWasmNode();
    const db = new RelateDb();
    try {
      const okEnvelope = parseRelateEnvelope(db.execute('RETURN 42 AS answer', null));
      expect(okEnvelope.error).toBeNull();
      expect(okEnvelope.rows).toEqual([{ answer: 42 }]);

      const errEnvelope = parseRelateEnvelope(db.execute('MATCH (n RETURN n', null));
      expect(errEnvelope.error).toMatch(/syntax error/i);
      expect(errEnvelope.rows).toEqual([]);
    } finally {
      db.free();
    }
  });

  it('normalizes native CLI envelope format and rejects malformed JSON envelopes', () => {
    const nativeSuccessJson = JSON.stringify({
      columns: ['fromCode', 'hops'],
      columnTypes: ['STRING', 'INTEGER'],
      rows: [{ fromCode: 'TWKHH', hops: 2 }],
      notifications: [],
      planCache: 'hit',
      timings: { elapsed_ms: 4.2, execute_ms: 3.1 },
      truncated: false,
    });
    const parsedSuccess = parseRelateEnvelope(nativeSuccessJson);
    expect(parsedSuccess.error).toBeNull();
    expect(parsedSuccess.rows).toEqual([{ fromCode: 'TWKHH', hops: 2 }]);
    expect(parsedSuccess.executeMs).toBe(3.1);
    expect(parsedSuccess.planCache).toBe('hit');

    const nativeErrorJson = JSON.stringify({
      error: {
        code: 'validation_error',
        exit_code: 6,
        kind: 'syntax',
        message: 'syntax error: InvalidRelationshipPattern',
      },
    });
    const parsedError = parseRelateEnvelope(nativeErrorJson);
    expect(parsedError.error).toBe('syntax error: InvalidRelationshipPattern');
    expect(parsedError.rows).toEqual([]);

    expect(() => parseRelateEnvelope('{not-json')).toThrow(RelateEnvelopeError);
    expect(() => parseRelateEnvelope(JSON.stringify({ rows: [] }))).toThrow(RelateEnvelopeError);
  });
});
