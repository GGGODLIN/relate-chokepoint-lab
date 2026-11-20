import type { ChokepointCatalog } from '../contracts/catalog.ts';
import {
  compareRoutes,
  formatInt,
  formatKm,
  formatSignedKm,
  formatSignedPct,
  odKey,
  sortIsolatedPorts,
  sortTradeExposure,
} from './model.ts';
import { BFS_APPROXIMATION_NOTE } from './presets.ts';
import type { WorkbenchController, WorkbenchState } from './workbench-controller.ts';

interface ImpactPanelProps {
  readonly catalog: ChokepointCatalog;
  readonly state: WorkbenchState;
  readonly controller: WorkbenchController;
}

function SectionTitle({ title, aside }: { readonly title: string; readonly aside?: string }) {
  return (
    <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-1.5">
      <h2 className="min-w-0 flex-1 truncate font-mono text-[11px] tracking-[0.16em] text-ink uppercase">{title}</h2>
      {aside !== undefined ? <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{aside}</span> : null}
    </div>
  );
}

export function ImpactPanel({ catalog, state, controller }: ImpactPanelProps) {
  const evaluation = state.evaluation;
  if (evaluation === null) {
    return <p className="px-4 py-6 text-[12px] text-ink-faint">Waiting for the first evaluation…</p>;
  }
  const heroKey = odKey(evaluation.scenario.hero);
  const isolated = sortIsolatedPorts(evaluation.isolation.ports);
  const exposure = sortTradeExposure(evaluation.tradeExposure);
  const maxExposure = exposure[0]?.exposedPorts ?? 1;
  const stale = state.busy || state.evaluationError !== null;

  return (
    <div className={`thin-scroll h-full overflow-y-auto pb-4 transition-opacity ${stale ? 'opacity-70' : ''}`}>
      {state.evaluationError !== null ? (
        <div className="mx-4 mt-3 border border-alert/60 bg-alert/10 p-2 text-[11.5px] text-ink">
          Last evaluation failed: <span className="tabular">{state.evaluationError}</span>. Showing the previous result.
          <button type="button" onClick={() => controller.retryEvaluation()} className="ml-2 underline">
            Retry
          </button>
        </div>
      ) : null}
      {state.graphMutated ? (
        <div className="mx-4 mt-3 border border-detour/70 bg-detour/10 p-2 text-[11.5px] text-ink">
          Live Cypher modified this tab&apos;s graph; numbers below reflect the modified graph.
          <button type="button" onClick={() => void controller.restoreGraph()} className="ml-2 underline">
            Restore canonical graph
          </button>
        </div>
      ) : null}

      <SectionTitle title="Golden route board" aside="click to make hero" />
      <ul className="px-2" data-testid="route-board">
        {evaluation.golden.map((golden) => {
          const delta = compareRoutes(golden.baseline, golden.current);
          const isHero = odKey({ from: golden.route.from, to: golden.route.to }) === heroKey;
          return (
            <li key={golden.route.id}>
              <button
                type="button"
                aria-pressed={isHero}
                onClick={() => controller.setHero({ from: golden.route.from, to: golden.route.to })}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-l-2 px-2 py-1.5 text-left transition-colors ${
                  isHero ? 'border-detour bg-hull' : 'border-transparent hover:bg-hull'
                }`}
              >
                <span className="min-w-0 truncate text-[12.5px] text-ink" title={golden.route.label}>
                  {golden.route.label.replace('->', '→')}
                </span>
                <span
                  className={`tabular text-right text-[12px] ${
                    delta.status === 'rerouted' ? 'text-detour' : delta.status === 'isolated' ? 'text-alert' : 'text-ink-dim'
                  }`}
                >
                  {delta.status === 'isolated'
                    ? 'NO ROUTE'
                    : delta.deltaKm !== null && delta.deltaKm !== 0
                      ? formatSignedKm(delta.deltaKm)
                      : 'baseline'}
                </span>
                <span className="tabular min-w-0 truncate text-[10.5px] text-ink-faint">
                  {golden.route.from} → {golden.route.to} ·{' '}
                  {golden.current.totalKm !== null ? formatKm(golden.current.totalKm) : '—'}
                  {golden.current.hops !== null ? ` · ${formatInt(golden.current.hops)} hops` : ''}
                </span>
                <span className="tabular text-right text-[10.5px] text-ink-faint">
                  {delta.deltaPct !== null && delta.deltaPct !== 0 ? formatSignedPct(delta.deltaPct) : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <SectionTitle
        title="Isolated ports"
        aside={`${formatInt(evaluation.isolation.isolatedCount)} of ${formatInt(evaluation.isolation.totalPorts)}`}
      />
      <p className="px-4 pb-1.5 text-[10.5px] leading-snug text-ink-faint">
        Unreachable from {evaluation.isolation.referenceHubCode}
        {evaluation.isolation.fallbackUsed ? ' (fallback hub: the boxes cut off Rotterdam)' : ''} · sorted by trade links ·{' '}
        {BFS_APPROXIMATION_NOTE}
      </p>
      <ul className="max-h-[260px] overflow-y-auto px-2 thin-scroll" data-testid="isolated-list">
        {isolated.length === 0 ? <li className="px-2 py-1 text-[12px] text-ink-faint">No port is cut off.</li> : null}
        {isolated.map((port) => (
          <li key={port.code}>
            <button
              type="button"
              onClick={() => void controller.focusPort(port.code)}
              className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hull"
            >
              <span className="size-2 shrink-0 rounded-full bg-alert" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={`${port.name}, ${port.country}`}>
                {port.name}
                <span className="text-ink-faint"> · {port.country}</span>
              </span>
              <span className="tabular shrink-0 text-[10.5px] text-lane">{port.code}</span>
              <span className="tabular w-14 shrink-0 text-right text-[10.5px] text-ink-dim">
                {formatInt(port.tradeDegree)} links
              </span>
            </button>
          </li>
        ))}
      </ul>

      <SectionTitle title="Trade partners exposed" aside={`${formatInt(exposure.length)} countries`} />
      <ul className="px-4" data-testid="trade-exposure">
        {exposure.length === 0 ? <li className="py-1 text-[12px] text-ink-faint">No trade partner loses a port.</li> : null}
        {exposure.map((row) => (
          <li key={row.countryCode} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2 py-[3px]">
            <span className="tabular text-[10.5px] text-ink-faint">{row.countryCode}</span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] text-ink" title={row.countryName}>
                {row.countryName}
              </span>
              <span className="mt-0.5 block h-[3px] bg-hull" aria-hidden="true">
                <span
                  className="block h-full bg-detour/80"
                  style={{ width: `${Math.max(4, (row.exposedPorts / maxExposure) * 100).toFixed(0)}%` }}
                />
              </span>
            </span>
            <span className="tabular shrink-0 text-right text-[11px] text-ink-dim">
              {formatInt(row.exposedPorts)} {row.exposedPorts === 1 ? 'port' : 'ports'}
            </span>
          </li>
        ))}
      </ul>
      <p className="px-4 pt-3 text-[10.5px] text-ink-faint">
        Evaluated in {Math.round(evaluation.elapsedMs)} ms inside the worker · {catalog.goldenRoutes.length} golden routes ·
        hero + isolation + trade cascade
      </p>
    </div>
  );
}
