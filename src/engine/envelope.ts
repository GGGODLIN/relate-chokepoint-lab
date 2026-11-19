export interface RelateEnvelopeStats {
  readonly nodes_created?: number;
  readonly nodes_deleted?: number;
  readonly relationships_created?: number;
  readonly relationships_deleted?: number;
  readonly properties_set?: number;
  readonly labels_added?: number;
  readonly labels_removed?: number;
  readonly indexes_added?: number;
  readonly indexes_removed?: number;
  readonly constraints_added?: number;
  readonly constraints_removed?: number;
  readonly [key: string]: number | undefined;
}

export interface QueryTelemetry {
  readonly elapsedMs: number | null;
  readonly executeMs: number | null;
  readonly planCache: string | null;
  readonly plan: unknown;
  readonly notifications: readonly unknown[];
  readonly stats: RelateEnvelopeStats;
}

export interface ParsedRelateEnvelope extends QueryTelemetry {
  readonly columns: readonly string[];
  readonly columnTypes: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly error: string | null;
}

export class RelateEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelateEnvelopeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractErrorMessage(rawError: unknown): string | null {
  if (rawError === null || rawError === undefined) {
    return null;
  }
  if (typeof rawError === 'string') {
    return rawError;
  }
  if (isRecord(rawError) && typeof rawError.message === 'string') {
    return rawError.message;
  }
  return JSON.stringify(rawError);
}

export function extractTelemetry(envelope: ParsedRelateEnvelope): QueryTelemetry {
  return {
    elapsedMs: envelope.elapsedMs,
    executeMs: envelope.executeMs,
    planCache: envelope.planCache,
    plan: envelope.plan,
    notifications: envelope.notifications,
    stats: envelope.stats,
  };
}

export function parseRelateEnvelope(rawJson: string): ParsedRelateEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RelateEnvelopeError(`Failed to parse Relate wire envelope JSON: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new RelateEnvelopeError('Relate wire envelope must be a JSON object');
  }

  const error = extractErrorMessage(parsed.error);

  // Native CLI error envelopes omit columns/rows; success envelopes always include both arrays.
  const columns = Array.isArray(parsed.columns)
    ? parsed.columns.map((col) => String(col))
    : error !== null
      ? []
      : null;
  if (columns === null) {
    throw new RelateEnvelopeError('Relate wire envelope is missing columns array');
  }

  const rows = Array.isArray(parsed.rows)
    ? parsed.rows
    : error !== null
      ? []
      : null;
  if (rows === null) {
    throw new RelateEnvelopeError('Relate wire envelope is missing rows array');
  }

  const typedRows: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isRecord(row)) {
      throw new RelateEnvelopeError(`Relate wire envelope rows[${i}] must be an object`);
    }
    typedRows.push(row);
  }

  const columnTypes = Array.isArray(parsed.columnTypes)
    ? parsed.columnTypes.map((t) => String(t))
    : [];

  const timings = isRecord(parsed.timings) ? parsed.timings : null;
  const elapsedMs = readOptionalNumber(parsed.elapsed_ms) ?? readOptionalNumber(timings?.elapsed_ms);
  const executeMs = readOptionalNumber(parsed.execute_ms) ?? readOptionalNumber(timings?.execute_ms);

  const planCache =
    typeof parsed.plan_cache === 'string'
      ? parsed.plan_cache
      : typeof parsed.planCache === 'string'
        ? parsed.planCache
        : null;

  const notifications = Array.isArray(parsed.notifications) ? parsed.notifications : [];
  const stats: RelateEnvelopeStats = isRecord(parsed.stats)
    ? (parsed.stats as RelateEnvelopeStats)
    : {};

  return {
    columns,
    columnTypes,
    rows: typedRows,
    error,
    elapsedMs,
    executeMs,
    planCache,
    plan: parsed.plan ?? null,
    notifications,
    stats,
  };
}
