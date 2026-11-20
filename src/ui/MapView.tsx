import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import type { GeoJSON } from 'geojson';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { ChokepointCatalog } from '../contracts/catalog.ts';
import type { PortRecord } from '../engine/chokepoint-engine.ts';
import { normalizeDragBBox, type DragBBoxResult } from '../engine/bbox.ts';
import {
  boxCollection,
  EMPTY_LINES,
  EMPTY_POINTS,
  EMPTY_POLYGONS,
  goldenRouteCollection,
  graticuleCollection,
  heroRouteCollection,
  isolatedPortCollection,
  routeBounds,
  severedEdgeIds,
} from './map-data.ts';
import {
  compareRoutes,
  formatInt,
  formatKm,
  formatSignedInt,
  formatSignedKm,
  formatSignedPct,
  odKey,
  type RouteDelta,
  type RouteStatus,
  type RouteSummary,
} from './model.ts';
import { BFS_APPROXIMATION_NOTE } from './presets.ts';
import type { WorkbenchController, WorkbenchState } from './workbench-controller.ts';

interface MapViewProps {
  readonly catalog: ChokepointCatalog;
  readonly state: WorkbenchState;
  readonly controller: WorkbenchController;
  readonly drawMode: boolean;
  readonly onDrawModeChange: (on: boolean) => void;
}

interface DragRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
const MIN_DRAG_PX = 6;

function buildStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      graticule: { type: 'geojson', data: graticuleCollection(30) },
      land: { type: 'geojson', data: `${DATA_BASE}land.geojson` },
      lanes: { type: 'geojson', data: `${DATA_BASE}marnet.map.geojson` },
      boxes: { type: 'geojson', data: EMPTY_POLYGONS },
      golden: { type: 'geojson', data: EMPTY_LINES },
      hero: { type: 'geojson', data: EMPTY_LINES },
      isolated: { type: 'geojson', data: EMPTY_POINTS },
    },
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': '#07101d' } },
      {
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        paint: {
          'line-color': ['match', ['get', 'kind'], 'equator', '#1d3150', '#122239'],
          'line-width': 1,
        },
      },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#0f1b2e' } },
      { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': '#253c5c', 'line-width': 0.6 } },
      {
        id: 'lanes',
        type: 'line',
        source: 'lanes',
        paint: {
          'line-color': '#1f4067',
          'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1.4],
        },
      },
      {
        id: 'lanes-blocked',
        type: 'line',
        source: 'lanes',
        filter: ['in', ['get', 'passage'], ['literal', []]],
        paint: { 'line-color': '#ef4444', 'line-width': 2.6, 'line-dasharray': [1, 1] },
      },
      {
        id: 'lanes-severed',
        type: 'line',
        source: 'lanes',
        filter: ['in', ['get', 'id'], ['literal', []]],
        paint: { 'line-color': '#ef4444', 'line-width': 1.6, 'line-opacity': 0.9 },
      },
      {
        id: 'boxes-fill',
        type: 'fill',
        source: 'boxes',
        paint: {
          'fill-color': ['match', ['get', 'state'], 'pending', '#f97316', '#ef4444'],
          'fill-opacity': 0.08,
        },
      },
      {
        id: 'boxes-line',
        type: 'line',
        source: 'boxes',
        paint: {
          'line-color': ['match', ['get', 'state'], 'pending', '#f97316', '#ef4444'],
          'line-width': 1.2,
          'line-dasharray': [3, 2],
        },
      },
      {
        id: 'golden',
        type: 'line',
        source: 'golden',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'status'], 'rerouted', '#f97316', 'isolated', '#ef4444', '#38bdf8'],
          'line-opacity': ['match', ['get', 'status'], 'rerouted', 0.6, 0.38],
          'line-width': 1.5,
        },
      },
      {
        id: 'hero-baseline',
        type: 'line',
        source: 'hero',
        filter: ['==', ['get', 'role'], 'baseline'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [2, 1.6] },
      },
      {
        id: 'hero-casing',
        type: 'line',
        source: 'hero',
        filter: ['!=', ['get', 'role'], 'baseline'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#07101d', 'line-width': 7, 'line-opacity': 0.85 },
      },
      {
        id: 'hero-current',
        type: 'line',
        source: 'hero',
        filter: ['!=', ['get', 'role'], 'baseline'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'role'], 'detour', '#f97316', '#38bdf8'],
          'line-width': 3.2,
        },
      },
      {
        id: 'isolated-halo',
        type: 'circle',
        source: 'isolated',
        paint: {
          'circle-color': '#ef4444',
          'circle-opacity': 0.16,
          'circle-radius': ['interpolate', ['linear'], ['get', 'tradeDegree'], 0, 7, 80, 14],
        },
      },
      {
        id: 'isolated',
        type: 'circle',
        source: 'isolated',
        paint: {
          'circle-color': '#ef4444',
          'circle-stroke-color': '#07101d',
          'circle-stroke-width': 1.2,
          'circle-radius': ['interpolate', ['linear'], ['get', 'tradeDegree'], 0, 3, 80, 6.5],
        },
      },
    ],
  };
}

function setSourceData(map: MapLibreMap, id: string, data: GeoJSON): void {
  const source = map.getSource<GeoJSONSource>(id);
  source?.setData(data);
}

export function MapView({ catalog, state, controller, drawMode, onDrawModeChange }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const chokeMarkersRef = useRef(new Map<string, HTMLButtonElement>());
  const endpointMarkersRef = useRef<maplibregl.Marker[]>([]);
  const fittedHeroRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [dragRect, setDragRect] = useState<DragRect | null>(null);

  const portsByCode = useMemo(
    () => new Map<string, PortRecord>(state.ports.map((port) => [port.code, port])),
    [state.ports],
  );

  // Every marker listener is removed in this effect's cleanup via markerClicks; the rule cannot trace array-held handlers.
  // react-doctor-disable-next-line effect-needs-cleanup
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const map = new maplibregl.Map({
      container,
      style: buildStyle(),
      center: [42, 24],
      zoom: 1.3,
      minZoom: 0.5,
      maxZoom: 9,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: true,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    const chokeMarkers = chokeMarkersRef.current;
    const markers: maplibregl.Marker[] = [];
    const markerClicks: [HTMLButtonElement, (event: MouseEvent) => void][] = [];
    for (const passage of catalog.passages) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'choke-marker';
      el.dataset.blocked = 'false';
      el.dataset.passage = passage.id;
      el.title = `${passage.name} (${passage.region}): click to toggle the blockade`;
      el.setAttribute('aria-label', `${passage.name} chokepoint`);
      const cross = document.createElement('span');
      cross.className = 'choke-x';
      el.appendChild(cross);
      const onMarkerClick = (event: MouseEvent) => {
        event.stopPropagation();
        if (controller.getSnapshot().boot.phase === 'ready') {
          controller.togglePassage(passage.id);
        }
      };
      el.addEventListener('click', onMarkerClick);
      markerClicks.push([el, onMarkerClick]);
      markers.push(new maplibregl.Marker({ element: el }).setLngLat([passage.focusLon, passage.focusLat]).addTo(map));
      chokeMarkers.set(passage.id, el);
    }
    const onIsolatedClick = (event: MapLayerMouseEvent) => {
      const code: unknown = event.features?.[0]?.properties?.code;
      if (typeof code === 'string') {
        void controller.focusPort(code);
      }
    };
    const onIsolatedEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onIsolatedLeave = () => {
      map.getCanvas().style.cursor = '';
    };
    const onLoad = () => setMapReady(true);
    map.on('click', 'isolated', onIsolatedClick);
    map.on('mouseenter', 'isolated', onIsolatedEnter);
    map.on('mouseleave', 'isolated', onIsolatedLeave);
    map.on('load', onLoad);
    mapRef.current = map;
    return () => {
      map.off('click', 'isolated', onIsolatedClick);
      map.off('mouseenter', 'isolated', onIsolatedEnter);
      map.off('mouseleave', 'isolated', onIsolatedLeave);
      map.off('load', onLoad);
      for (const [el, onMarkerClick] of markerClicks) {
        el.removeEventListener('click', onMarkerClick);
      }
      for (const marker of markers) {
        marker.remove();
      }
      map.remove();
      mapRef.current = null;
      chokeMarkers.clear();
      endpointMarkersRef.current = [];
      fittedHeroRef.current = null;
      setMapReady(false);
    };
  }, [catalog, controller]);

  useEffect(() => {
    const blocked = new Set(state.scenario.blocked);
    for (const [id, el] of chokeMarkersRef.current) {
      el.dataset.blocked = String(blocked.has(id));
    }
    const map = mapRef.current;
    if (!mapReady || map === null) {
      return;
    }
    const filter: ExpressionSpecification = ['in', ['get', 'passage'], ['literal', [...state.scenario.blocked]]];
    map.setFilter('lanes-blocked', filter);
  }, [mapReady, state.scenario.blocked]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || map === null) {
      return;
    }
    const evaluation = state.evaluation;
    setSourceData(map, 'hero', heroRouteCollection(evaluation));
    setSourceData(map, 'golden', goldenRouteCollection(evaluation));
    setSourceData(map, 'isolated', isolatedPortCollection(evaluation?.isolation.ports ?? []));
    const severed: ExpressionSpecification = ['in', ['get', 'id'], ['literal', severedEdgeIds(evaluation)]];
    map.setFilter('lanes-severed', severed);
  }, [mapReady, state.evaluation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || map === null) {
      return;
    }
    setSourceData(map, 'boxes', boxCollection(state.scenario.boxes, state.pendingBox));
  }, [mapReady, state.scenario.boxes, state.pendingBox]);

  const hero = state.evaluation?.hero ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || map === null) {
      return;
    }
    for (const marker of endpointMarkersRef.current) {
      marker.remove();
    }
    endpointMarkersRef.current = [];
    if (hero === null) {
      return;
    }
    for (const code of [hero.from, hero.to]) {
      const port = portsByCode.get(code);
      if (port === undefined) {
        continue;
      }
      const el = document.createElement('div');
      el.className = 'endpoint-tag';
      el.textContent = port.code;
      endpointMarkersRef.current.push(
        new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([port.lon, port.lat]).addTo(map),
      );
    }
    const key = odKey(hero);
    if (fittedHeroRef.current !== key) {
      fittedHeroRef.current = key;
      const bounds = routeBounds(hero.segments);
      if (bounds !== null) {
        map.fitBounds(
          [
            [bounds[0][0], bounds[0][1]],
            [bounds[1][0], bounds[1][1]],
          ],
          { padding: { top: 90, bottom: 70, left: 330, right: 60 }, maxZoom: 4.2, duration: 900 },
        );
      }
    }
  }, [mapReady, hero, portsByCode]);

  const focusCode = state.portFocus?.code ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || map === null || focusCode === null) {
      return;
    }
    const port = portsByCode.get(focusCode);
    if (port !== undefined) {
      map.flyTo({ center: [port.lon, port.lat], zoom: Math.max(map.getZoom(), 4.4), speed: 1.4 });
    }
  }, [mapReady, focusCode, portsByCode]);

  const finishDrag = useEffectEvent((result: DragBBoxResult) => {
    onDrawModeChange(false);
    void controller.proposeBox(result);
  });
  const cancelDraw = useEffectEvent(() => onDrawModeChange(false));

  useEffect(() => {
    const map = mapRef.current;
    if (!drawMode || map === null) {
      return;
    }
    map.dragPan.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    const canvasContainer = map.getCanvasContainer();
    canvasContainer.style.cursor = 'crosshair';
    let start: { readonly x: number; readonly y: number } | null = null;
    const onDown = (event: MapMouseEvent) => {
      start = { x: event.point.x, y: event.point.y };
      setDragRect({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
    };
    const onMove = (event: MapMouseEvent) => {
      if (start !== null) {
        setDragRect({ x0: start.x, y0: start.y, x1: event.point.x, y1: event.point.y });
      }
    };
    const onUp = (event: MapMouseEvent) => {
      if (start === null) {
        return;
      }
      const startScreen = start;
      const endScreen = { x: event.point.x, y: event.point.y };
      start = null;
      setDragRect(null);
      if (Math.abs(endScreen.x - startScreen.x) < MIN_DRAG_PX || Math.abs(endScreen.y - startScreen.y) < MIN_DRAG_PX) {
        return;
      }
      finishDrag(normalizeDragBBox(startScreen, endScreen, (pt) => map.unproject([pt[0], pt[1]])));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelDraw();
      }
    };
    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      map.off('mousedown', onDown);
      map.off('mousemove', onMove);
      map.off('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
      map.dragPan.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      canvasContainer.style.cursor = '';
      setDragRect(null);
    };
  }, [drawMode]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" data-testid="map" />
      {dragRect !== null ? (
        <div
          className="pointer-events-none absolute border border-dashed border-detour bg-detour/10"
          style={{
            left: Math.min(dragRect.x0, dragRect.x1),
            top: Math.min(dragRect.y0, dragRect.y1),
            width: Math.abs(dragRect.x1 - dragRect.x0),
            height: Math.abs(dragRect.y1 - dragRect.y0),
          }}
        />
      ) : null}
      {drawMode ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <p className="border border-detour/70 bg-deck px-3 py-1.5 font-mono text-[11px] text-ink">
            Drag a box over the sea lanes to sever them · Esc to cancel
          </p>
        </div>
      ) : null}
      <HeroCard catalog={catalog} state={state} portsByCode={portsByCode} />
      <Legend />
      <PortFocusCard state={state} controller={controller} portsByCode={portsByCode} />
    </div>
  );
}

const STATUS_TAG: Record<RouteStatus, { readonly label: string; readonly className: string }> = {
  rerouted: { label: 'Rerouted', className: 'border-detour text-detour' },
  unchanged: { label: 'Baseline path', className: 'border-lane text-lane' },
  isolated: { label: 'No sea route', className: 'border-alert text-alert' },
  unknown: { label: 'Baseline n/a', className: 'border-rule-strong text-ink-faint' },
};

interface HeroCardProps {
  readonly catalog: ChokepointCatalog;
  readonly state: WorkbenchState;
  readonly portsByCode: ReadonlyMap<string, PortRecord>;
}

function HeroCard({ catalog, state, portsByCode }: HeroCardProps) {
  const evaluation = state.evaluation;
  if (evaluation === null) {
    return null;
  }
  const { hero, heroBaseline } = evaluation;
  const delta = compareRoutes(heroBaseline, hero);
  const fromPort = portsByCode.get(hero.from);
  const toPort = portsByCode.get(hero.to);
  const golden = catalog.goldenRoutes.find((route) => route.from === hero.from && route.to === hero.to);
  const tag = STATUS_TAG[delta.status];
  return (
    <section
      aria-label="Hero route"
      data-testid="hero-card"
      className="absolute top-3 left-3 z-10 w-[300px] border border-rule-strong bg-deck/95 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="chart-label">Hero route{golden !== undefined ? ' · golden' : ''}</span>
        <span className={`border px-1.5 py-px font-mono text-[10px] tracking-[0.1em] uppercase ${tag.className}`}>
          {tag.label}
        </span>
      </div>
      <p className="mt-1.5 truncate text-[14px] font-medium text-ink" title={`${fromPort?.name ?? hero.from} → ${toPort?.name ?? hero.to}`}>
        {fromPort?.name ?? hero.from} → {toPort?.name ?? hero.to}
      </p>
      <p className="tabular truncate text-[11px] text-ink-faint">
        {hero.from} · {fromPort?.country ?? '—'} → {hero.to} · {toPort?.country ?? '—'}
      </p>
      {delta.status === 'isolated' ? (
        <p className="mt-3 text-[12px] text-alert">
          No sea route under this blockade: {hero.to} is unreachable from {hero.from}.
        </p>
      ) : (
        <HeroMetrics hero={hero} heroBaseline={heroBaseline} delta={delta} />
      )}
      <p className="mt-3 border-t border-rule pt-2 text-[10px] leading-snug text-ink-faint">{BFS_APPROXIMATION_NOTE}</p>
    </section>
  );
}

interface HeroMetricsProps {
  readonly hero: RouteSummary;
  readonly heroBaseline: RouteSummary | null;
  readonly delta: RouteDelta;
}

function HeroMetrics({ hero, heroBaseline, delta }: HeroMetricsProps) {
  return (
    <>
    <div className="mt-3 flex items-baseline gap-3">
      <span className={`tabular text-[22px] leading-none ${delta.status === 'rerouted' ? 'text-detour' : 'text-ink'}`} data-testid="hero-delta-km">
        {delta.deltaKm !== null ? formatSignedKm(delta.deltaKm) : '—'}
      </span>
      <span className={`tabular text-[15px] ${delta.status === 'rerouted' ? 'text-detour' : 'text-ink-dim'}`} data-testid="hero-delta-pct">
        {delta.deltaPct !== null ? formatSignedPct(delta.deltaPct) : '—'}
      </span>
    </div>
    <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
      <dt className="text-ink-faint">now</dt>
      <dd className="text-right text-ink">{hero.totalKm !== null ? formatKm(hero.totalKm) : '—'}</dd>
      <dt className="text-ink-faint">baseline</dt>
      <dd className="text-right text-ink-dim">
        {heroBaseline !== null && heroBaseline.totalKm !== null
          ? formatKm(heroBaseline.totalKm)
          : 'n/a while graph is modified'}
      </dd>
      <dt className="text-ink-faint">hops</dt>
      <dd className="text-right text-ink-dim">
        {hero.hops !== null ? formatInt(hero.hops) : '—'}
        {delta.deltaHops !== null && delta.deltaHops !== 0 ? ` (${formatSignedInt(delta.deltaHops)})` : ''}
      </dd>
    </dl>
    </>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 border border-rule bg-deck/90 px-3 py-2 font-mono text-[10px] text-ink-dim">
      <ul className="space-y-1">
        <li className="flex items-center gap-2">
          <svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" stroke="#38bdf8" strokeWidth="2" strokeDasharray="4 3" /></svg>
          baseline (default blockade)
        </li>
        <li className="flex items-center gap-2">
          <svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" stroke="#f97316" strokeWidth="3" /></svg>
          detour under scenario
        </li>
        <li className="flex items-center gap-2">
          <svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" stroke="#38bdf8" strokeOpacity="0.5" strokeWidth="1.5" /></svg>
          other golden routes
        </li>
        <li className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden="true"><circle cx="13" cy="5" r="3.5" fill="#ef4444" /></svg>
          isolated port (click)
        </li>
      </ul>
    </div>
  );
}

interface PortFocusCardProps {
  readonly state: WorkbenchState;
  readonly controller: WorkbenchController;
  readonly portsByCode: ReadonlyMap<string, PortRecord>;
}

function PortFocusCard({ state, controller, portsByCode }: PortFocusCardProps) {
  const focus = state.portFocus;
  if (focus === null) {
    return null;
  }
  const port = portsByCode.get(focus.code);
  return (
    <section
      aria-label="Port trade partners"
      data-testid="port-focus"
      className="absolute right-12 bottom-3 z-10 flex max-h-[46%] w-[280px] flex-col border border-alert/60 bg-deck/95"
    >
      <div className="flex items-start gap-2 border-b border-rule px-3 py-2">
        <span className="mt-1 size-2 shrink-0 rounded-full bg-alert" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink" title={port?.name ?? focus.code}>
            {port?.name ?? focus.code}
          </p>
          <p className="tabular truncate text-[11px] text-ink-faint">
            {focus.code} · {port?.country ?? '—'} · {port !== undefined ? `${formatInt(port.tradeDegree)} trade links` : ''}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close port details"
          onClick={() => controller.clearPortFocus()}
          className="shrink-0 px-1 text-ink-faint hover:text-ink"
        >
          ×
        </button>
      </div>
      <p className="chart-label px-3 pt-2">Trading countries</p>
      {focus.status === 'loading' ? <p className="px-3 py-2 text-[12px] text-ink-faint">Querying TRADES_WITH…</p> : null}
      {focus.status === 'failed' ? <p className="px-3 py-2 text-[12px] text-alert">{focus.error}</p> : null}
      {focus.status === 'ready' ? (
        <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
          {focus.partners.map((partner) => (
            <li key={partner.countryCode} className="flex items-center gap-2 py-0.5 text-[12px]">
              <span className="tabular w-7 shrink-0 text-[10.5px] text-ink-faint">{partner.countryCode}</span>
              <span className="min-w-0 flex-1 truncate text-ink-dim" title={partner.countryName}>
                {partner.countryName}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
