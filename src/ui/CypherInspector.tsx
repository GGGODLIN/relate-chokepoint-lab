import type { ReactNode } from 'react';
import { buildCliReadOnlyCommand, countGraphWrites, formatInt, formatMs, parseParamsText, type QueryRecord } from './model.ts';
import type { CypherExecutionResult } from '../engine/chokepoint-engine.ts';
import type { WorkbenchController, WorkbenchState } from './workbench-controller.ts';

export interface InspectorDraft {
  readonly cypher: string;
  readonly params: string;
}

interface CypherInspectorProps {
  readonly mode: 'cypher' | 'cli';
  readonly state: WorkbenchState;
  readonly controller: WorkbenchController;
  readonly queries: readonly QueryRecord[];
  readonly selectedQuery: QueryRecord | null;
  readonly onSelectQuery: (id: string) => void;
  readonly draft: InspectorDraft | null;
  readonly onDraftChange: (draft: InspectorDraft | null) => void;
}

const MAX_TABLE_ROWS = 60;

function paramsToText(params: Readonly<Record<string, unknown>> | null): string {
  return params === null ? '' : JSON.stringify(params, null, 2);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

function Badge({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5 border border-rule px-1.5 py-0.5">
      <span className="field-label">{label}</span>
      <span className={`tabular text-[11px] ${tone ?? 'text-ink'}`}>{value}</span>
    </span>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function PlanNode({ node, depth }: { readonly node: Record<string, unknown>; readonly depth: number }) {
  const operator = typeof node.operator === 'string' ? node.operator : 'Operator';
  const details = typeof node.details === 'string' ? node.details : '';
  const actual = isRecord(node.actual) ? node.actual : {};
  const rows = typeof actual.rows === 'number' ? actual.rows : null;
  const dbHits = typeof actual.db_hits === 'number' ? actual.db_hits : null;
  const timeMs = typeof actual.time_ms === 'number' ? actual.time_ms : null;
  const children = Array.isArray(node.children) ? node.children.filter(isRecord) : [];
  return (
    <li>
      <div className="flex items-baseline gap-2 py-0.5" style={{ paddingLeft: depth * 14 }}>
        <span className="shrink-0 font-mono text-[11.5px] text-lane">{operator}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint" title={details}>
          {details}
        </span>
        <span className="tabular shrink-0 text-[10.5px] text-ink-dim">
          {rows !== null ? `${formatInt(rows)} rows` : ''}
          {dbHits !== null ? ` · ${formatInt(dbHits)} hits` : ''}
          {timeMs !== null ? ` · ${formatMs(timeMs)}` : ''}
        </span>
      </div>
      {children.length > 0 ? (
        <ul>
          {children.map((child, index) => (
            // Plan children have no stable identity; their position in the tree is the identity.
            // react-doctor-disable-next-line no-array-index-as-key
            <PlanNode key={`${depth}-${index}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PlanTree({ plan }: { readonly plan: unknown }) {
  if (!isRecord(plan) || !isRecord(plan.root)) {
    return null;
  }
  return (
    <div className="mt-3" data-testid="profile-plan">
      <p className="chart-label pb-1">PROFILE plan · actual metrics</p>
      <ul className="border border-rule px-2 py-1">
        <PlanNode node={plan.root} depth={0} />
      </ul>
    </div>
  );
}

function ResultTable({ result }: { readonly result: CypherExecutionResult }) {
  return (
    <div className="mt-3 overflow-x-auto thin-scroll" data-testid="result-table">
      <table className="tabular w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column} className="border-b border-rule-strong px-1.5 py-1 text-left font-medium text-ink-dim">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.slice(0, MAX_TABLE_ROWS).map((row, rowIndex) => (
            // Result rows are positional data without a key column; position is their identity.
            // react-doctor-disable-next-line no-array-index-as-key
            <tr key={rowIndex} className="odd:bg-hull/60">
              {result.columns.map((column) => (
                <td key={column} className="max-w-[220px] truncate px-1.5 py-0.5 text-ink" title={cellText(row[column])}>
                  {cellText(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > MAX_TABLE_ROWS ? (
        <p className="mt-1 text-[10.5px] text-ink-faint">
          Showing {MAX_TABLE_ROWS} of {formatInt(result.rows.length)} rows.
        </p>
      ) : null}
    </div>
  );
}

interface ResultDetailsProps {
  readonly state: WorkbenchState;
  readonly controller: WorkbenchController;
  readonly result: CypherExecutionResult;
}

function ResultDetails({ state, controller, result }: ResultDetailsProps) {
  const { inspector } = state;
  const telemetry = result.telemetry;
  const writes = countGraphWrites(telemetry.stats);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <Badge label="status" value={result.ok ? 'ok' : 'env.error'} tone={result.ok ? 'text-lane' : 'text-alert'} />
        <Badge label="execute_ms" value={formatMs(telemetry.executeMs)} />
        <Badge label="plan_cache" value={telemetry.planCache ?? '—'} />
        <Badge label="rows" value={formatInt(result.rows.length)} />
        {writes > 0 ? <Badge label="writes" value={formatInt(writes)} tone="text-detour" /> : null}
      </div>
      {!result.ok ? (
        <div className="mt-2 border border-alert/70 bg-alert/10 p-2" role="alert" data-testid="inspector-error">
          <p className="field-label text-alert">env.error</p>
          <pre className="tabular mt-1 text-[11.5px] break-words whitespace-pre-wrap text-ink">{result.error}</pre>
        </div>
      ) : null}
      {inspector.wroteGraph ? (
        <div className="mt-2 border border-detour/70 bg-detour/10 p-2 text-[11.5px] text-ink">
          This statement wrote to the tab&apos;s in-memory graph. Every number on screen is now recomputed on the modified
          graph.
          <button type="button" onClick={() => void controller.restoreGraph()} className="ml-2 underline">
            Restore canonical graph
          </button>
        </div>
      ) : null}
      {result.ok && inspector.profile ? <PlanTree plan={telemetry.plan} /> : null}
      {result.ok && result.columns.length > 0 ? <ResultTable result={result} /> : null}
    </div>
  );
}

function ResultView({ state, controller }: { readonly state: WorkbenchState; readonly controller: WorkbenchController }) {
  const { inspector } = state;
  if (inspector.status === 'idle') {
    return <p className="text-[11.5px] text-ink-faint">Edit the query or its params, then Run or PROFILE.</p>;
  }
  if (inspector.status === 'running') {
    return <p className="text-[11.5px] text-detour">Running in the Dedicated Worker…</p>;
  }
  const result = inspector.result;
  if (inspector.transportError !== null || result === null) {
    return (
      <div className="border border-alert/70 bg-alert/10 p-2" role="alert" data-testid="inspector-error">
        <p className="chart-label text-alert">Worker error</p>
        <p className="tabular mt-1 text-[11.5px] break-words text-ink">{inspector.transportError ?? 'No result'}</p>
      </div>
    );
  }
  return <ResultDetails state={state} controller={controller} result={result} />;
}

async function copyText(controller: WorkbenchController, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    controller.pushToast('info', 'Copied to clipboard.');
  } catch {
    controller.pushToast('warn', 'Clipboard unavailable here; select the command and copy it manually.');
  }
}

function CommandCard({
  title,
  command,
  children,
  controller,
  testId,
}: {
  readonly title: string;
  readonly command: string;
  readonly children: ReactNode;
  readonly controller: WorkbenchController;
  readonly testId: string;
}) {
  return (
    <section className="border border-rule bg-abyss/40" data-testid={testId}>
      <div className="flex items-center gap-2 border-b border-rule px-3 py-1.5">
        <h3 className="min-w-0 flex-1 truncate font-mono text-[11px] tracking-[0.12em] text-ink uppercase">{title}</h3>
        <button
          type="button"
          onClick={() => void copyText(controller, command)}
          className="shrink-0 border border-rule-strong px-2 py-0.5 font-mono text-[10.5px] tracking-[0.08em] text-ink-dim uppercase hover:border-lane hover:text-ink"
        >
          Copy
        </button>
      </div>
      <pre className="tabular overflow-x-auto px-3 py-2 text-[11px] leading-relaxed whitespace-pre text-lane thin-scroll">
        {command}
      </pre>
      <div className="px-3 pb-2.5 text-[11px] leading-snug text-ink-faint">{children}</div>
    </section>
  );
}

interface NativeCliPanelProps {
  readonly controller: WorkbenchController;
  readonly cliCommand: string;
  readonly selectedQuery: QueryRecord | null;
}

function NativeCliPanel({ controller, cliCommand, selectedQuery }: NativeCliPanelProps) {
  return (
    <div className="thin-scroll h-full space-y-3 overflow-y-auto p-4">
      <p className="text-[11.5px] leading-snug text-ink-dim">
        The same Relate v1.1.0 engine runs natively against the golden single-file store{' '}
        <span className="tabular text-ink">data/chokepoint.rl</span>. The browser tab never touches that file; it seeds a
        disposable <span className="tabular text-ink">:memory:</span> database instead.
      </p>
      <CommandCard
        title="Replay this query read-only"
        command={cliCommand}
        controller={controller}
        testId="cli-readonly"
      >
        Runs the query currently in the Live Cypher editor{selectedQuery !== null ? ` (${selectedQuery.label})` : ''}{' '}
        with <span className="tabular">--read-only</span>, so the golden <span className="tabular">.rl</span> is opened
        without writing or checkpointing.
      </CommandCard>
      <CommandCard title="Transaction rollback proof" command="npm run verify:rollback" controller={controller} testId="cli-rollback">
        Clones the golden store, then runs <span className="tabular">.begin</span> → delete every Suez and Bab el-Mandeb
        edge → recompute Kaohsiung → Rotterdam → <span className="tabular">.rollback</span>, and checks the SHA-256 of{' '}
        <span className="tabular">data/chokepoint.rl</span> is unchanged. <span className="tabular">.begin</span> and{' '}
        <span className="tabular">.rollback</span> are native CLI session commands, so they are shown here and never
        simulated in the browser.
      </CommandCard>
      <CommandCard
        title="Built-in MCP server"
        command="relate serve --database :memory: --load data/chokepoint.rl --mcp 7475"
        controller={controller}
        testId="cli-mcp"
      >
        Loads the golden store into an in-memory database and serves Relate&apos;s MCP surface on 127.0.0.1:7475 (no
        file lock, nothing written back). Relate v1.1.0 requires <span className="tabular">--database</span>;{' '}
        <span className="tabular">relate serve --load … --mcp 7475</span> alone exits with “serve requires --database”.
      </CommandCard>
    </div>
  );
}

interface LiveCypherPanelProps extends Omit<CypherInspectorProps, 'mode'> {
  readonly cypherText: string;
  readonly paramsText: string;
  readonly paramsValid: boolean;
}

function LiveCypherPanel({
  state,
  controller,
  queries,
  selectedQuery,
  onSelectQuery,
  draft,
  onDraftChange,
  cypherText,
  paramsText,
  paramsValid,
}: LiveCypherPanelProps) {
  const running = state.inspector.status === 'running';
  const ready = state.boot.phase === 'ready';
  return (
    <div className="thin-scroll h-full overflow-y-auto p-4">
      {state.graphMutated ? (
        <div className="mb-3 border border-detour/70 bg-detour/10 p-2 text-[11.5px] text-ink" role="status">
          This tab&apos;s :memory: graph differs from the canonical graph because of a Live Cypher write.
          <button
            type="button"
            disabled={state.restoring}
            onClick={() => void controller.restoreGraph()}
            className="ml-2 underline disabled:opacity-50"
          >
            {state.restoring ? 'Re-seeding…' : 'Restore canonical graph'}
          </button>
        </div>
      ) : null}
      <label className="flex items-center gap-2">
        <span className="chart-label shrink-0">Query</span>
        <select
          value={selectedQuery?.id ?? ''}
          onChange={(event) => onSelectQuery(event.target.value)}
          className="min-w-0 flex-1 border border-rule-strong bg-abyss px-1.5 py-1 text-[12px] text-ink focus:border-lane focus:outline-none"
        >
          {queries.map((query) => (
            <option key={query.id} value={query.id}>
              {query.label}
            </option>
          ))}
        </select>
      </label>
      {selectedQuery !== null ? (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="engine-telemetry">
          <Badge label="execute_ms" value={formatMs(selectedQuery.telemetry?.executeMs ?? null)} />
          <Badge label="plan_cache" value={selectedQuery.telemetry?.planCache ?? 're-run to measure'} />
          <Badge label="rows" value={selectedQuery.rowCount !== null ? formatInt(selectedQuery.rowCount) : '—'} />
        </div>
      ) : null}
      <label className="mt-3 block">
        <span className="chart-label">Cypher 25 · exact text sent to Relate WASM</span>
        <textarea
          value={cypherText}
          spellCheck={false}
          rows={9}
          aria-label="Cypher query"
          onChange={(event) => onDraftChange({ cypher: event.target.value, params: paramsText })}
          className="tabular mt-1 w-full resize-y border border-rule-strong bg-abyss p-2 text-[11.5px] leading-relaxed text-ink focus:border-lane focus:outline-none"
        />
      </label>
      <label className="mt-2 block">
        <span className="chart-label">Params JSON</span>
        <textarea
          value={paramsText}
          spellCheck={false}
          rows={3}
          aria-label="Query parameters as JSON"
          onChange={(event) => onDraftChange({ cypher: cypherText, params: event.target.value })}
          className={`tabular mt-1 w-full resize-y border bg-abyss p-2 text-[11.5px] text-ink focus:outline-none ${
            paramsValid ? 'border-rule-strong focus:border-lane' : 'border-alert'
          }`}
        />
      </label>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!ready || running || cypherText.trim().length === 0}
          onClick={() => void controller.runInspector(cypherText, paramsText, false)}
          className="border border-lane bg-lane/10 px-3 py-1 font-mono text-[11px] tracking-[0.1em] text-lane uppercase hover:bg-lane/20 disabled:opacity-50"
        >
          Run
        </button>
        <button
          type="button"
          disabled={!ready || running || cypherText.trim().length === 0}
          onClick={() => void controller.runInspector(cypherText, paramsText, true)}
          className="border border-rule-strong px-3 py-1 font-mono text-[11px] tracking-[0.1em] text-ink uppercase hover:border-lane disabled:opacity-50"
        >
          Profile
        </button>
        {draft !== null ? (
          <button
            type="button"
            onClick={() => onDraftChange(null)}
            className="ml-auto px-1 font-mono text-[10.5px] tracking-[0.08em] text-ink-faint uppercase hover:text-ink"
          >
            Revert to engine query
          </button>
        ) : null}
      </div>
      <div className="mt-3 border-t border-rule pt-3" data-testid="inspector-result">
        <ResultView state={state} controller={controller} />
      </div>
      <p className="pt-4 text-[10.5px] leading-snug text-ink-faint">
        Runs in this tab&apos;s Dedicated Worker on a disposable :memory: RelateDb (zero OPFS). Explicit transactions
        (.begin / .rollback) belong to the native CLI: see the Native CLI .rl &amp; MCP tab.
      </p>
    </div>
  );
}

export function CypherInspector({
  mode,
  state,
  controller,
  queries,
  selectedQuery,
  onSelectQuery,
  draft,
  onDraftChange,
}: CypherInspectorProps) {
  const cypherText = draft?.cypher ?? selectedQuery?.cypher ?? '';
  const paramsText = draft?.params ?? paramsToText(selectedQuery?.params ?? null);
  const parsedParams = parseParamsText(paramsText);
  if (mode === 'cli') {
    const cliCommand = buildCliReadOnlyCommand(cypherText, parsedParams.ok ? parsedParams.params : null);
    return <NativeCliPanel controller={controller} cliCommand={cliCommand} selectedQuery={selectedQuery} />;
  }
  return (
    <LiveCypherPanel
      state={state}
      controller={controller}
      queries={queries}
      selectedQuery={selectedQuery}
      onSelectQuery={onSelectQuery}
      draft={draft}
      onDraftChange={onDraftChange}
      cypherText={cypherText}
      paramsText={paramsText}
      paramsValid={parsedParams.ok}
    />
  );
}
