import { useMemo, useState, type KeyboardEvent } from 'react';
import type { ChokepointCatalog } from '../contracts/catalog.ts';
import type { PortRecord } from '../engine/chokepoint-engine.ts';
import { formatInt, searchPorts } from './model.ts';
import type { WorkbenchController, WorkbenchState } from './workbench-controller.ts';

interface BlockadePanelProps {
  readonly catalog: ChokepointCatalog;
  readonly state: WorkbenchState;
  readonly controller: WorkbenchController;
  readonly ready: boolean;
  readonly drawMode: boolean;
  readonly onDrawModeChange: (on: boolean) => void;
}

function PanelHeading({ index, title, aside }: { readonly index: string; readonly title: string; readonly aside?: string }) {
  return (
    <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
      <span className="chart-label text-lane">§{index}</span>
      <h2 className="min-w-0 flex-1 truncate font-mono text-[11px] tracking-[0.16em] text-ink uppercase">{title}</h2>
      {aside !== undefined ? <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{aside}</span> : null}
    </div>
  );
}

interface ChipProps {
  readonly label: string;
  readonly note?: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
  readonly disabled: boolean;
}

function Chip({ label, note, removeLabel, onRemove, disabled }: ChipProps) {
  return (
    <span className="flex max-w-full min-w-0 items-center gap-1 border border-alert/50 bg-alert/10 py-0.5 pr-0.5 pl-2 text-[11.5px] text-ink">
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      {note !== undefined ? <span className="tabular shrink-0 text-[10px] text-ink-faint">{note}</span> : null}
      <button
        type="button"
        aria-label={removeLabel}
        disabled={disabled}
        onClick={onRemove}
        className="shrink-0 px-1 leading-none text-ink-dim hover:text-alert disabled:opacity-40"
      >
        ×
      </button>
    </span>
  );
}

export function BlockadePanel({ catalog, state, controller, ready, drawMode, onDrawModeChange }: BlockadePanelProps) {
  const blocked = new Set(state.scenario.blocked);
  const passageName = new Map(catalog.passages.map((p) => [p.id, p.name]));
  const defaultBlocked = new Set(catalog.passages.filter((p) => p.defaultBlocked).map((p) => p.id));
  const laneCounts = new Map(
    (state.evaluation?.boxMatches ?? []).map((match) => [match.boxId, match.matchedEdgeIds.length]),
  );
  const hasBlockades = state.scenario.blocked.length > 0 || state.scenario.boxes.length > 0;

  return (
    <section className="flex min-h-0 flex-col bg-deck" aria-label="Blockades and routes">
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto pb-4">
        <PanelHeading index="01" title="Chokepoints" aside={`${blocked.size} / ${catalog.passages.length} blocked`} />
        <ul>
          {catalog.passages.map((passage) => {
            const isBlocked = blocked.has(passage.id);
            return (
              <li key={passage.id}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isBlocked}
                  disabled={!ready}
                  onClick={() => controller.togglePassage(passage.id)}
                  title={`${passage.name} · ${passage.region}`}
                  className="flex w-full items-center gap-2.5 px-4 py-[5px] text-left transition-colors hover:bg-hull disabled:opacity-50"
                >
                  <span
                    aria-hidden="true"
                    className={`relative h-3.5 w-6 shrink-0 rounded-full border transition-colors ${
                      isBlocked ? 'border-alert bg-alert/25' : 'border-rule-strong bg-abyss'
                    }`}
                  >
                    <span
                      className={`absolute top-px size-2.5 rounded-full transition-[left] ${
                        isBlocked ? 'left-[11px] bg-alert' : 'left-px bg-ink-faint'
                      }`}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{passage.name}</span>
                  <span className={`tabular shrink-0 text-[10px] tracking-[0.08em] ${isBlocked ? 'text-alert' : 'text-ink-faint'}`}>
                    {isBlocked ? 'BLOCKED' : 'OPEN'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <PanelHeading index="02" title="Active blockades" />
        <div className="flex flex-wrap gap-1.5 px-4" data-testid="blockade-chips">
          {state.scenario.blocked.map((id) => (
            <Chip
              key={id}
              label={passageName.get(id) ?? id}
              note={defaultBlocked.has(id) ? 'default' : undefined}
              removeLabel={`Reopen ${passageName.get(id) ?? id}`}
              onRemove={() => controller.unblockPassage(id)}
              disabled={!ready}
            />
          ))}
          {state.scenario.boxes.map((box, index) => {
            const lanes = laneCounts.get(box.id);
            return (
              <Chip
                key={box.id}
                label={`Box ${index + 1}${box.crossesAntimeridian ? ' · ±180°' : ''}`}
                note={lanes !== undefined ? `${formatInt(lanes)} lanes` : undefined}
                removeLabel={`Remove box ${index + 1}`}
                onRemove={() => controller.removeBox(box.id)}
                disabled={!ready}
              />
            );
          })}
          {!hasBlockades ? <p className="text-[11.5px] text-ink-faint">Every passage is open.</p> : null}
        </div>
        <div className="mt-3 flex gap-2 px-4">
          <button
            type="button"
            aria-pressed={drawMode}
            disabled={!ready || state.pendingBox !== null}
            onClick={() => onDrawModeChange(!drawMode)}
            className={`flex-1 border px-2 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors disabled:opacity-50 ${
              drawMode ? 'border-detour bg-detour/15 text-detour' : 'border-rule-strong text-ink hover:border-detour'
            }`}
          >
            {state.pendingBox !== null ? 'Checking box…' : drawMode ? 'Drawing · Esc' : 'Draw box'}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => controller.resetAll()}
            className="shrink-0 border border-rule-strong px-2 py-1.5 font-mono text-[11px] tracking-[0.1em] text-ink-dim uppercase hover:border-alert hover:text-alert disabled:opacity-50"
          >
            Reset All
          </button>
        </div>
        <p className="mt-1.5 px-4 text-[11px] leading-snug text-ink-faint">
          Drag across the chart to delete every lane inside the box from this tab&apos;s in-memory graph. Boxes wider than
          120° of longitude are flagged.
        </p>

        <PanelHeading index="03" title="Route calculator" aside={`${formatInt(state.ports.length)} ports`} />
        <div className="space-y-2 px-4">
          <PortPicker
            label="From"
            ports={state.ports}
            valueCode={state.scenario.hero.from}
            disabled={!ready}
            onSelect={(code) => controller.setHero({ from: code, to: state.scenario.hero.to })}
          />
          <PortPicker
            label="To"
            ports={state.ports}
            valueCode={state.scenario.hero.to}
            disabled={!ready}
            onSelect={(code) => controller.setHero({ from: state.scenario.hero.from, to: code })}
          />
          <button
            type="button"
            disabled={!ready}
            onClick={() => controller.setHero({ from: state.scenario.hero.to, to: state.scenario.hero.from })}
            className="w-full border border-rule-strong px-2 py-1 font-mono text-[10.5px] tracking-[0.1em] text-ink-dim uppercase hover:text-ink disabled:opacity-50"
          >
            Swap origin ⇄ destination
          </button>
        </div>
      </div>
    </section>
  );
}

interface PortPickerProps {
  readonly label: string;
  readonly ports: readonly PortRecord[];
  readonly valueCode: string;
  readonly disabled: boolean;
  readonly onSelect: (code: string) => void;
}

function PortPicker({ label, ports, valueCode, disabled, onSelect }: PortPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchPorts(ports, query, 8), [ports, query]);
  const selected = ports.find((port) => port.code === valueCode);
  const listId = `port-options-${label.toLowerCase()}`;

  const choose = (code: string) => {
    onSelect(code);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && results[0] !== undefined) {
      event.preventDefault();
      choose(results[0].code);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="relative">
      <label className="flex items-center gap-2">
        <span className="chart-label w-9 shrink-0">{label}</span>
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          disabled={disabled}
          value={open ? query : selected !== undefined ? `${selected.name} · ${selected.code}` : valueCode}
          placeholder="Port code, name or country"
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onBlur={() => setOpen(false)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="tabular min-w-0 flex-1 border border-rule-strong bg-abyss px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:border-lane focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lane disabled:opacity-50"
        />
      </label>
      {open && results.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-11 z-20 mt-0.5 border border-rule-strong bg-deck shadow-lg shadow-black/40"
        >
          {results.map((port) => (
            // Combobox pattern: focus stays in the input (Enter picks the first match), options are click targets.
            <li
              key={port.code}
              role="option"
              aria-selected={port.code === valueCode}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(port.code)}
              className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-[12px] hover:bg-hull"
            >
              <span className="tabular w-12 shrink-0 text-[10.5px] text-lane">{port.code}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{port.name}</span>
              <span className="max-w-[45%] shrink truncate text-[10.5px] text-ink-faint" title={port.country}>
                {port.country}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
