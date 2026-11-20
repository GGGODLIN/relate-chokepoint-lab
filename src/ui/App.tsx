import { useCallback, useEffect, useState } from 'react';
import type { ChokepointCatalog } from '../contracts/catalog.ts';
import { BlockadePanel } from './BlockadePanel.tsx';
import { CypherInspector, type InspectorDraft } from './CypherInspector.tsx';
import { ImpactPanel } from './ImpactPanel.tsx';
import { MapView } from './MapView.tsx';
import { activePresetId, formatInt, type QueryRecord } from './model.ts';
import { LOADING_MESSAGE, PRESET_CARDS, RELATE_VERSION } from './presets.ts';
import { useWorkbench } from './use-workbench.ts';
import type { Toast, WorkbenchController, WorkbenchState } from './workbench-controller.ts';

interface AppProps {
  readonly controller: WorkbenchController;
  readonly catalog: ChokepointCatalog;
}

type RightTab = 'impact' | 'cypher' | 'cli';

const RIGHT_TABS: readonly { readonly id: RightTab; readonly label: string }[] = [
  { id: 'impact', label: 'Impact' },
  { id: 'cypher', label: 'Live Cypher' },
  { id: 'cli', label: 'Native CLI .rl & MCP' },
];

function availableQueries(state: WorkbenchState): QueryRecord[] {
  const queries = [...(state.evaluation?.queries ?? [])];
  if (state.portQuery !== null) {
    queries.push(state.portQuery);
  }
  return queries;
}

export function App({ controller, catalog }: AppProps) {
  const state = useWorkbench(controller);
  const [drawMode, setDrawMode] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>('impact');
  const [selectedQueryId, setSelectedQueryId] = useState('hero-route');
  const [draft, setDraft] = useState<InspectorDraft | null>(null);
  const dismissToast = useCallback((id: number) => controller.dismissToast(id), [controller]);
  const ready = state.boot.phase === 'ready';
  const presetId = activePresetId(catalog, state.scenario);
  const queries = availableQueries(state);
  const selectedQuery = queries.find((q) => q.id === selectedQueryId) ?? queries[0] ?? null;

  const selectQuery = (id: string) => {
    setSelectedQueryId(id);
    setDraft(null);
  };

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <TopBar
        state={state}
        presetId={presetId}
        ready={ready}
        onPreset={(id) => controller.selectPreset(id)}
      />
      <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)_400px] 2xl:grid-cols-[320px_minmax(0,1fr)_420px]">
        <BlockadePanel
          catalog={catalog}
          state={state}
          controller={controller}
          ready={ready}
          drawMode={drawMode}
          onDrawModeChange={setDrawMode}
        />
        <main className="relative min-h-0 min-w-0 border-x border-rule">
          <MapView
            catalog={catalog}
            state={state}
            controller={controller}
            drawMode={drawMode}
            onDrawModeChange={setDrawMode}
          />
          <Toasts toasts={state.toasts} onDismiss={dismissToast} />
          {!ready ? <LoadingCard state={state} /> : null}
        </main>
        <aside className="flex min-h-0 min-w-0 flex-col bg-deck" aria-label="Analysis">
          <div role="tablist" aria-label="Analysis views" className="flex shrink-0 border-b border-rule">
            {RIGHT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={rightTab === tab.id}
                onClick={() => setRightTab(tab.id)}
                className={`shrink-0 px-3 py-2.5 font-mono text-[11.5px] tracking-[0.02em] whitespace-nowrap transition-colors ${
                  rightTab === tab.id
                    ? 'border-b-2 border-lane text-ink'
                    : 'border-b-2 border-transparent text-ink-faint hover:text-ink-dim'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {rightTab === 'impact' ? (
              <ImpactPanel catalog={catalog} state={state} controller={controller} />
            ) : (
              <CypherInspector
                mode={rightTab}
                state={state}
                controller={controller}
                queries={queries}
                selectedQuery={selectedQuery}
                onSelectQuery={selectQuery}
                draft={draft}
                onDraftChange={setDraft}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

interface TopBarProps {
  readonly state: WorkbenchState;
  readonly presetId: string | null;
  readonly ready: boolean;
  readonly onPreset: (presetId: string) => void;
}

function TopBar({ state, presetId, ready, onPreset }: TopBarProps) {
  const bootMs = state.boot.telemetry?.bootMs ?? null;
  const working = state.busy || state.pendingBox !== null;
  return (
    <header className="flex items-stretch gap-4 border-b border-rule bg-deck px-4 py-2">
      <div className="flex shrink-0 flex-col justify-center">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="#38bdf8" strokeWidth="1.5" />
            <path d="M5 5l6 6M11 5l-6 6" stroke="#ef4444" strokeWidth="1.5" />
          </svg>
          <h1 className="font-mono text-[13px] font-medium tracking-[0.24em] text-ink">CHOKEPOINT LAB</h1>
        </div>
        <span className="chart-label mt-1">Relate v{RELATE_VERSION} · Cypher 25</span>
      </div>
      <nav aria-label="Scenario presets" className="flex min-w-0 flex-1 gap-2">
        {PRESET_CARDS.map((card, index) => {
          const active = presetId === card.presetId;
          return (
            <button
              key={card.presetId}
              type="button"
              aria-pressed={active}
              disabled={!ready}
              onClick={() => onPreset(card.presetId)}
              style={{ animationDelay: `${index * 70}ms` }}
              className={`reveal grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border px-3 py-1.5 text-left transition-colors disabled:opacity-50 ${
                active ? 'border-detour bg-detour/10' : 'border-rule bg-hull hover:border-rule-strong'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{card.title}</span>
                <span className="tabular block truncate text-[11px] text-ink-dim">{card.detail}</span>
              </span>
              <span className="flex flex-col items-end leading-none">
                <span className="tabular text-[18px] text-alert">{formatInt(card.isolatedCount)}</span>
                <span className="tabular mt-1 text-[10px] text-ink-faint">isolated</span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="flex shrink-0 flex-col items-end justify-center">
        <span className="tabular text-[11px] text-ink-dim">WASM v{RELATE_VERSION} · Dedicated Worker · :memory:</span>
        <span className="tabular mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint" aria-live="polite">
          <span
            className={`inline-block size-1.5 rounded-full ${
              !ready ? 'bg-ink-faint' : working ? 'animate-pulse bg-detour' : 'bg-lane'
            }`}
          />
          {!ready
            ? 'booting'
            : working
              ? 'computing in worker…'
              : `seeded in ${bootMs === null ? '—' : formatInt(bootMs)} ms · idle`}
        </span>
      </div>
    </header>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function LoadingCard({ state }: { readonly state: WorkbenchState }) {
  const { boot } = state;
  const fraction =
    boot.totalBytes !== null ? Math.min(1, boot.loadedBytes / boot.totalBytes) : boot.phase === 'downloading' ? 0 : 1;
  const steps: readonly { readonly label: string; readonly status: 'done' | 'active' | 'todo'; readonly detail: string }[] = [
    {
      label: 'Download canonical graph payload',
      status: boot.phase === 'downloading' ? 'active' : 'done',
      detail:
        boot.totalBytes !== null
          ? `${formatMegabytes(boot.loadedBytes)} / ${formatMegabytes(boot.totalBytes)}`
          : formatMegabytes(boot.loadedBytes),
    },
    {
      label: 'Seed :memory: RelateDb inside the worker',
      status: boot.phase === 'seeding' ? 'active' : boot.phase === 'downloading' ? 'todo' : 'done',
      detail:
        boot.telemetry !== null
          ? `${formatInt(boot.telemetry.counts.waypoints)} waypoints · ${formatInt(boot.telemetry.counts.maritimeEdges)} lanes · ${formatInt(boot.telemetry.bootMs)} ms`
          : 'UNWIND batches, zero OPFS',
    },
    {
      label: 'Compute golden-route baselines',
      status: boot.phase === 'baselines' ? 'active' : boot.phase === 'ready' ? 'done' : 'todo',
      detail: '5 shortestPath queries',
    },
  ];
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-abyss/70">
      <div role="status" className="w-[440px] max-w-[90%] border border-rule-strong bg-deck p-5">
        <p className="tabular text-[13px] text-ink">{LOADING_MESSAGE}</p>
        <div className="mt-3 h-1 w-full bg-hull" aria-hidden="true">
          <div className="h-full bg-lane transition-[width]" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
        </div>
        <ol className="mt-4 space-y-2">
          {steps.map((step) => (
            <li key={step.label} className="flex items-baseline gap-2 text-[12px]">
              <span
                className={`tabular w-10 shrink-0 text-[10px] uppercase ${
                  step.status === 'done' ? 'text-lane' : step.status === 'active' ? 'text-detour' : 'text-ink-faint'
                }`}
              >
                {step.status === 'done' ? 'done' : step.status === 'active' ? 'run' : 'wait'}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-dim">{step.label}</span>
              <span className="tabular shrink-0 text-[11px] text-ink-faint">{step.detail}</span>
            </li>
          ))}
        </ol>
        {boot.phase === 'failed' ? (
          <div className="mt-4 border border-alert/60 bg-alert/10 p-3 text-[12px] text-ink">
            <p className="font-medium text-alert">Engine failed to start</p>
            <p className="tabular mt-1 break-words text-ink-dim">{boot.error}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 border border-rule-strong px-2 py-1 font-mono text-[11px] uppercase"
            >
              Reload
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const TOAST_TONE: Record<Toast['tone'], string> = {
  info: 'border-lane/60 text-ink',
  warn: 'border-detour/70 text-ink',
  error: 'border-alert/80 text-ink',
};

function ToastItem({ toast, onDismiss }: { readonly toast: Toast; readonly onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 7000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);
  return (
    <div role="status" className={`reveal flex items-start gap-3 border bg-deck px-3 py-2 text-[12px] ${TOAST_TONE[toast.tone]}`}>
      <span className="chart-label shrink-0 pt-0.5">{toast.tone}</span>
      <p className="min-w-0 flex-1">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-ink-faint hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}

function Toasts({ toasts, onDismiss }: { readonly toasts: readonly Toast[]; readonly onDismiss: (id: number) => void }) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
      <div className="pointer-events-auto flex w-[460px] max-w-[92%] flex-col gap-2" data-testid="toasts">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
