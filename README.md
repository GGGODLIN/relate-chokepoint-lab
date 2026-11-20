# Chokepoint Lab

Global maritime chokepoint blockade simulator powered 100% by **Relate `v1.1.0`** (Cypher 25) across two synchronized surfaces: a zero-install browser WASM workbench (`:memory:` Dedicated Worker) and a single-file native `.rl` store with built-in MCP server.

- **Live Workbench:** [Chokepoint Lab on Vercel](https://relate-chokepoint-lab.vercel.app)
- **Repository:** [GGGODLIN/relate-chokepoint-lab](https://github.com/GGGODLIN/relate-chokepoint-lab)
- **Engine:** Relate `v1.1.0` (`@relate/relate-wasm@1.1.0` + native `relate` CLI/MCP) · Cypher 25

### 15-Second Judge Tour

1. **Open the live workbench** — Relate WASM `v1.1.0` boots inside a Dedicated Web Worker (`:memory:`, zero OPFS, zero backend server, zero third-party map tile requests) and seeds 10,560 waypoints, 758 Tier-1 ports, 175 countries, and 23,986 relationships in under a second.
2. **Trigger a scenario preset** in the top bar:
   - **Suez + Bab el-Mandeb** — isolates **9** Red Sea terminals from Rotterdam (`NLRTM`) and forces Kaohsiung -> Rotterdam (`TWKHH -> NLRTM`) around the Cape of Good Hope (`19,882.1 km` -> `25,943.2 km`, **+6,061.1 km / +30.5%**).
   - **Strait of Hormuz** — isolates **20** Persian Gulf terminals (led by Jebel Ali `AEJEA`, Abu Dhabi `AEAUH`, Hamad `QAHMD`) and surfaces top exposed trading partner countries via `(:Port)-[:TRADES_WITH]->(:Country)`.
   - **Gibraltar + Suez** — seals both Mediterranean gateways, isolating **103** Mediterranean and Black Sea terminals.
3. **Combine arbitrary closures or draw a custom blockade box** — toggle any of the 13 maritime chokepoints or drag a custom bounding box on the map (evaluated by Relate's `POINT INDEX` + `point.withinBBox()`).
4. **Inspect and profile live Cypher** — open the **Live Cypher** tab to view, edit, and `PROFILE` the exact Cypher 25 statements sent to Relate WASM, or open **Native CLI `.rl` & MCP** to copy matching `--read-only`, `.begin`/`.rollback`, and `relate serve --mcp` commands against `data/chokepoint.rl`.

---

## Mode

**Hybrid single-engine** — one canonical global maritime graph executed by the same Relate `v1.1.0` Cypher 25 engine across three interfaces:

| Surface | Runtime | Store | Role |
|---|---|---|---|
| **Browser Workbench** | `@relate/relate-wasm@1.1.0` in Dedicated Web Worker | Disposable `:memory:` seeded from `public/data/graph.wasm.json` | Zero-install interactive map, preset/custom blockades, editable Live Cypher + `PROFILE` |
| **Native CLI** | `relate` `v1.1.0` binary | Persistent single-file `data/chokepoint.rl` (2.8 MB, non-LFS, SHA-256 verified) | Read-only analytical queries (`--read-only`), parity verification, transactional `.begin`/`.rollback` what-if proofs on `relate clone` |
| **Built-in MCP Server** | `relate serve --database :memory: --load data/chokepoint.rl --mcp 7475` | Ephemeral `:memory:` read-only load (source `.rl` released immediately) | Agent-accessible `read_cypher` and `get_schema` tools over Streamable HTTP (or `stdio`) |

---

## Why Relate

Simulating maritime chokepoint disruptions is inherently a **combinatorial graph reachability and multi-hop impact problem**:

- **Static lookup tables and RAG fail combinatorially:** 13 toggleable chokepoints produce $2^{13} = 8,192$ passage-closure combinations before adding arbitrary user-drawn spatial blockade zones. Precomputing every route and basin-isolation set does not scale, and RAG cannot compute graph connectivity.
- **Recursive SQL CTEs struggle on dense maritime meshes:** Expressing bidirectional shortest paths across 10,560 waypoints and 17,559 sea edges with cycle prevention and spatial bounding-box pruning in SQL is verbose and slow compared to native `shortestPath()` + `POINT INDEX`.
- **Why Relate `v1.1.0` specifically fits this workload** (grounded in empirical benchmarks on this graph):
  1. **14 static relationship types unlock bidirectional BFS:** Modeling open ocean (`:SEA_OPEN`) and each chokepoint (`:PASSAGE_*`) as distinct relationship types lets every blockade scenario compile to a static relationship-type disjunction (`shortestPath((a)-[:SEA_OPEN|PASSAGE_...*]-(b))`) with zero edge-property `WHERE` predicates inside the variable-length pattern. On Relate `v1.1.0`, this stays on the fast bidirectional BFS path (~5 ms per point-to-point route and ~67–78 ms for full 1-to-ALL 758-port isolation on native CLI), avoiding the DFS fallback triggered by edge-filter `WHERE` clauses.
  2. **Bit-for-bit Native <-> WASM parity (`diffCount: 0`):** `npm run verify:parity` executes the same Cypher 25 queries against native `data/chokepoint.rl` (`--read-only`) and in-memory `@relate/relate-wasm` and asserts zero mismatches across counts, all 20 golden-route evaluations (5 routes x 4 scenarios), all 3 preset isolation port lists, and Strait of Hormuz trade-partner rankings.
  3. **Native transactional what-if rollback:** `npm run verify:rollback` clones `data/chokepoint.rl` with `relate clone`, runs `.begin` -> `DELETE` all 6 Suez + Bab el-Mandeb corridor edges -> recomputes `TWKHH -> NLRTM` (`19,882.1 km` -> `25,943.2 km`) -> `.rollback`, and confirms both the baseline route (`126 hops / 19,882.1 km`) and all 6 corridor edges are restored while the golden `.rl` SHA-256 stays unchanged.
  4. **Embedded spatial index + zero-server deployment:** `CREATE POINT INDEX` on `:WP(loc)` and `:Port(loc)` powers `point.withinBBox()` custom blockade zones directly inside the browser worker — no PostGIS server, no cloud database, and no API keys required.

---

## Graph model

### Topology & Dual-Surface Projection

```text
                        (:Country)
                     {code, name}  [175]
                            ^
                            | :TRADES_WITH [6,427]
                            |
                         (:Port)
             {code, name, country, lon, lat, loc,
              snapWpId, snapDistKm, wpDistKm,
              tradeDegree, rank, isCuratedHub}  [758]
                            |
           :SEA_OPEN {id, km, kind: 'port_link'} [758]
                            v
  (:WP) <---- :SEA_OPEN {id, km, kind: 'lane'} [16,717] ----> (:WP)
{id, lon,   <---- :PASSAGE_<NAME> {id, km, kind: 'lane'} ----> {id, lon,
 lat, loc}                  [13 types, 84 edges]                lat, loc}
  [10,560]

  Canonical ETL (src/etl/build-graph.ts)
    |-- data/chokepoint.rl           (2.8 MB native Relate store -> CLI & MCP)
    |-- public/data/graph.wasm.json  (1.6 MB tuple payload -> WASM :memory:)
    +-- public/data/marnet.map.geojson (3.8 MB lane geometry -> MapLibre)
```

> **Design note on port links:** Port-to-waypoint attachment edges (`758`) are stored using relationship type `:SEA_OPEN` with `{kind: 'port_link'}` rather than a separate relationship label. That keeps `shortestPath((a)-[:SEA_OPEN|PASSAGE_...*]-(b))` uniform across `:Port` endpoints and `:WP` sea-lane hops while still letting custom spatial box queries match only sea lanes (`MATCH (w)-[r {kind: 'lane'}]-(w2:WP)`).

### Verified Graph Inventory (`build-receipt.json` & `verifyParity`)

| Entity | Count | Details |
|---|---:|---|
| `:WP` nodes | 10,560 | 6,551 marnet anchors + 4,009 resampled synthetic waypoints (`~250 km` step) |
| `:Port` nodes | 758 | Curated Tier-1 terminals snapped within 100 km (max snap distance `98.542 km`) |
| `:Country` nodes | 175 | Cleaned ISO/partner country entities linked from ports |
| **Total nodes** | **11,493** | Single connected maritime component (`connected_components: 1`) |
| `:SEA_OPEN` edges | 17,475 | 16,717 open-sea lanes (`kind: 'lane'`) + 758 port links (`kind: 'port_link'`) |
| `:PASSAGE_*` edges (13 types) | 84 | Bab el-Mandeb (1), Bering (7), Bosphorus (6), Magellan/Cape Horn (6), Dardanelles (5), Gibraltar (3), Malacca (1), Northwest (12, default blocked), Hormuz (4), Panama (10), Cape of Good Hope (23), Suez (5), Sunda (1) |
| `:TRADES_WITH` edges | 6,427 | Directed `(:Port)-[:TRADES_WITH]->(:Country)` trade exposure links |
| **Total relationships** | **23,986** | 17,559 routing edges (`14` static maritime types) + 6,427 trade edges |

### Schema Indexes (5 Online)

```cypher
CREATE INDEX wp_id_idx IF NOT EXISTS FOR (w:WP) ON (w.id);
CREATE INDEX port_code_idx IF NOT EXISTS FOR (p:Port) ON (p.code);
CREATE INDEX country_code_idx IF NOT EXISTS FOR (c:Country) ON (c.code);
CREATE POINT INDEX wp_loc_idx IF NOT EXISTS FOR (w:WP) ON (w.loc);
CREATE POINT INDEX port_loc_idx IF NOT EXISTS FOR (p:Port) ON (p.loc);
```

### Verified Relate `v1.1.0` Scenario Baselines (`npm run verify:parity`, `diffCount: 0`)

All distances and hop counts below are produced identically by both native `relate v1.1.0` (`data/chokepoint.rl`) and `@relate/relate-wasm@1.1.0` (`:memory:`):

| Preset (plus default Northwest Passage closed) | Isolated Ports (from `NLRTM`, of 758) | Sample Isolated Terminals |
|---|---:|---|
| **Suez + Bab el-Mandeb** | 9 | `SAJED`, `SAKAC`, `JOAQB`, `EGAIS`, `ERMSW` |
| **Strait of Hormuz** | 20 | `AEJEA`, `AEAUH`, `QAHMD`, `SAJUB`, `IQUQR` |
| **Gibraltar + Suez** | 103 | `ESVLC`, `ESALG`, `ITGOA`, `EGPSD`, `ITGIT` |

| Golden Corridor | Open Baseline (hops / km) | Suez + Bab el-Mandeb Blocked (hops / km) | Detour Delta | Hormuz / Gibraltar+Suez |
|---|---:|---:|---:|---|
| `TWKHH -> NLRTM` (Kaohsiung -> Rotterdam) | 126 / 19,882.1 km | 133 / 25,943.2 km | +7 hops / +6,061.1 km (+30.5%) | Open / Cape detour |
| `SGSIN -> NLRTM` (Singapore -> Rotterdam) | 111 / 16,241.3 km | 119 / 23,143.9 km | +8 hops / +6,902.6 km (+42.5%) | Open / Cape detour |
| `AEJEA -> ITGOA` (Jebel Ali -> Genova) | 63 / 8,314.8 km | 104 / 20,814.4 km | +41 hops / +12,499.6 km (+150.3%) | Isolated / Isolated |
| `CNSHA -> USLAX` (Shanghai -> Los Angeles) | 51 / 11,502.5 km | 51 / 11,502.5 km | 0 km | Open / Open |
| `CNSHA -> USNYC` (Shanghai -> New York) | 120 / 21,524.0 km | 120 / 21,524.0 km | 0 km | Open / Open |

---

## Setup

### 1. Zero-Install Browser Workbench

Open the [Chokepoint Lab Live Workbench](https://relate-chokepoint-lab.vercel.app) in any modern desktop browser. No local setup, `.env` files, or API keys are required.

### 2. Local Development & Automated Tests

Requires Node.js `>= 22`.

```bash
git clone https://github.com/GGGODLIN/relate-chokepoint-lab.git
cd relate-chokepoint-lab
npm ci
npm run dev
```

Run typechecking, unit/integration tests, and production bundle verification:

```bash
npm run typecheck
npm test
npm run build
```

### 3. Native Relate CLI (`v1.1.0+`) — Read-Only Queries, Parity & Rollback

With the `relate` `v1.1.0+` binary on your `PATH` (or via `RELATE_BIN=/path/to/relate`):

```bash
# Verify the golden single-file store checksum
shasum -a 256 -c data/chokepoint.rl.sha256

# Run a read-only route query directly against data/chokepoint.rl
relate --database data/chokepoint.rl --read-only --mode envelope \
  --param 'from="TWKHH"' --param 'to="NLRTM"' \
  -c "MATCH (a:Port {code: \$from}), (b:Port {code: \$to})
      OPTIONAL MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_BABALMANDAB|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_ORMUZ|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUEZ|PASSAGE_SUNDA*]-(b))
      RETURN a.code AS fromCode, b.code AS toCode, length(p) AS hops,
             round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) AS totalKm"

# Cross-verify Native CLI (.rl) vs Browser WASM (:memory:) parity (asserts diffCount: 0)
npm run verify:parity

# Run the 3-stage transactional .begin / DELETE / .rollback proof on a temporary relate clone
npm run verify:rollback
```

### 4. Built-In Relate MCP Server (`relate serve`)

Launch Relate's built-in Streamable HTTP MCP server against `data/chokepoint.rl` loaded read-only into `:memory:` (releases the `.rl` file immediately, holds no lock, and rejects all write/DDL statements):

```bash
relate serve --database :memory: --load data/chokepoint.rl --mcp 7475
```

On startup, `relate serve` binds `http://127.0.0.1:7475/mcp` (`serverInfo: relate-mcp v1.1.0`, protocol `2025-03-26`), prints an ephemeral Basic-auth credential `relate:<token>`, and exposes two strictly read-only MCP tools:
- `read_cypher` (`{ statement: string, parameters?: object }`)
- `get_schema` (`{ sample_size?: integer }`)

For local MCP hosts that connect via **stdio** (no auth token required, launches and shuts down with the client), configure:

```json
{
  "mcpServers": {
    "chokepoint-lab": {
      "command": "relate",
      "args": [
        "serve",
        "--database",
        ":memory:",
        "--load",
        "data/chokepoint.rl",
        "--mcp",
        "stdio"
      ]
    }
  }
}
```

For Streamable HTTP MCP clients targeting the running port-7475 server (replace `<BASE64_OF_relate:TOKEN>` with the Base64-encoded `relate:<token>` printed at startup, or pass `--auth none` on loopback):

```json
{
  "mcpServers": {
    "chokepoint-lab-http": {
      "type": "http",
      "url": "http://127.0.0.1:7475/mcp",
      "headers": {
        "Authorization": "Basic <BASE64_OF_relate:TOKEN>"
      }
    }
  }
}
```

#### Verified Live MCP Agent Prompts (`relate serve --database :memory: --load data/chokepoint.rl --mcp 7475`)

**Prompt 1 — Red Sea closure (`Suez + Bab el-Mandeb`, plus default Northwest Passage): reroute `TWKHH -> NLRTM` and count isolated terminals from `NLRTM`**

1. Reroute (`read_cypher`, `parameters: {"from": "TWKHH", "to": "NLRTM"}`):
   ```cypher
   MATCH (a:Port {code: $from}), (b:Port {code: $to})
   OPTIONAL MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_ORMUZ|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUNDA*]-(b))
   RETURN a.code AS fromCode, b.code AS toCode, length(p) AS hops,
          round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) AS totalKm
   ```
   Verified output (`execute_ms: 5.08 ms`):
   ```json
   [{"fromCode": "TWKHH", "toCode": "NLRTM", "hops": 133, "totalKm": 25943.2}]
   ```

2. Isolated terminals (`read_cypher`, `parameters: {"refHub": "NLRTM"}`):
   ```cypher
   MATCH (hub:Port {code: $refHub})
   OPTIONAL MATCH p = shortestPath((hub)-[:SEA_OPEN|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_ORMUZ|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUNDA*]-(p2:Port))
   WHERE p2 <> hub
   WITH hub, collect(p2.code) + [hub.code] AS reachableCodes
   MATCH (isolated:Port)
   WHERE NOT isolated.code IN reachableCodes
   RETURN count(isolated) AS isolatedCount, collect(isolated.code) AS isolatedCodes
   ```
   Verified output (`execute_ms: 78.19 ms`):
   ```json
   [{"isolatedCount": 9, "isolatedCodes": ["SAJED", "SAKAC", "JOAQB", "EGAIS", "ERMSW", "SDPZU", "EGSCN", "YEHOD", "EGSOK"]}]
   ```

**Prompt 2 — Strait of Hormuz blockade (plus default Northwest Passage): top 5 exposed trading partner countries via `(:Port)-[:TRADES_WITH]->(:Country)`**

`read_cypher` (`parameters: {"refHub": "NLRTM"}`):
```cypher
MATCH (hub:Port {code: $refHub})
OPTIONAL MATCH p = shortestPath((hub)-[:SEA_OPEN|PASSAGE_BABALMANDAB|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUEZ|PASSAGE_SUNDA*]-(p2:Port))
WHERE p2 <> hub
WITH hub, collect(p2.code) + [hub.code] AS reachableCodes
MATCH (isolated:Port)-[:TRADES_WITH]->(c:Country)
WHERE NOT isolated.code IN reachableCodes
RETURN c.code AS countryCode, c.name AS countryName, count(DISTINCT isolated) AS exposedPorts
ORDER BY exposedPorts DESC, c.code ASC
LIMIT 5
```
Verified output (`execute_ms: 67.18 ms`):

| Country Code | Country Name | Exposed Isolated Ports |
|---|---|---:|
| `AE` | United Arab Emirates | 11 |
| `IN` | India | 8 |
| `PK` | Pakistan | 7 |
| `BH` | Bahrain | 6 |
| `SG` | Singapore | 6 |

After running the live MCP session, `data/chokepoint.rl` remains byte-for-byte unchanged (`776fa235cacefa6f551cbb4925fa640342d1814db9b993e9175f7aa50866c282`).

---

## Data path

All artifacts flow deterministically and unidirectionally from pinned open geospatial inputs via `npm run build:graph` (`scripts/build-graph.mjs` -> `src/etl/build-graph.ts`) and `npm run build:land` (`scripts/build-land.mjs`):

1. **Pinned raw inputs:**
   - `data/raw/marnet_searoute.geojson` (729 KB) — 4,108 LineStrings + 2 MultiLineString parts (`4,110` flattened maritime segments).
   - `data/raw/ports.geojson` (721 KB) — 3,962 raw ports, filtered to 803 Tier-1 terminals.
   - `contracts/chokepoint-catalog.json` — canonical passage definitions, presets, curated hub ports, and golden routes.
2. **Deterministic graph construction (`src/etl/build-graph.ts`):**
   - Drops 3 degenerate self-loops, preserves 1,085 T-junction vertices, and patches 2 South Africa bypass features (`706`, `4107`) so every passage cut has `bypassLeaks: 0`.
   - Resamples long sea segments to `~250 km` equidistant steps (`6,551` anchor + `4,009` synthetic = `10,560` `:WP` nodes), aligning unweighted BFS hop count with physical sailing distance.
   - Snaps Tier-1 ports within `100 km` to the main maritime component (`758` snapped, max `98.542 km`; 40 inland/far dropped, 5 duplicate LOCODEs resolved).
   - Enforces build-time invariants: `connected_components: 1`, `ports_on_non_main: 0`, `duplicate_port_ids: 0`, `uncleaned_country_names: 0`, `cut_audit_clean: true`, `unintended_local_bypasses: 0`.
3. **Emitted artifacts:**
   - `data/chokepoint.rl` (2.8 MB regular Git file, **not Git LFS**) + `data/chokepoint.rl.sha256` (`776fa235cacefa6f551cbb4925fa640342d1814db9b993e9175f7aa50866c282`) — seeded into native Relate via `UNWIND` batches (`chunkSize = 5,000`) and verified against `data/build-receipt.json`.
   - `public/data/graph.wasm.json` (1.6 MB) — compact tuple projection seeded into browser `@relate/relate-wasm` (`:memory:`) using the identical `generateSeedBatches()` Cypher pipeline.
   - `public/data/marnet.map.geojson` (3.8 MB) — full-resolution sea-lane linework for MapLibre rendering.
   - `public/data/land.geojson` (880 KB) — Natural Earth 1:50m land polygons quantized to `0.01°` (~1.1 km) by `scripts/build-land.mjs` so the workbench renders offline with zero external map tile requests.

### Why Relate Engine Distance Is Authoritative Over ETL JS BFS

`data/build-receipt.json` records a JS BFS sanity baseline computed during ETL (`twkhh-nlrtm` open: `126 hops / 19,340.5 km`; Suez + Bab el-Mandeb blocked: `133 hops / 26,433.7 km`). Because an unweighted `~250 km` mesh has multiple distinct paths tied for the exact same minimum hop count, different BFS traversal orders select different equal-hop tie-breaks. Both native Relate `v1.1.0` (`data/chokepoint.rl`) and browser `@relate/relate-wasm@1.1.0` deterministically select the exact same path (`126 hops / 19,882.1 km` open -> `133 hops / 25,943.2 km` blocked, `+6,061.1 km` / `+30.5%`). `verifyParity` enforces exact hop and isolation equality against the build receipt and exact `totalKm` equality between native Relate and Relate WASM (`diffCount: 0`), treating the Relate engine's kilometers as authoritative everywhere in the UI and documentation.

---

## Capabilities, Datasets & AI Disclosure

### Routing Approximation Scope

- **~250 km topological equidistant BFS approximation:** Every route is computed 100% inside Relate `v1.1.0` using unweighted `shortestPath()` over `~250 km` resampled sea-lane edges, then summed over each traversed edge's Haversine `r.km`. It is designed for rapid macroscopic corridor and connectivity disruption analysis — not nautical navigation, vessel draft/canal beam constraints, ice-class routing, or real-time AIS/schedule optimization.
- **Arctic default:** `PASSAGE_NORTHWEST` is blocked by default to reflect routine non-icebreaker commercial shipping; users can explicitly reopen it from the passage panel.
- **Browser custom blockades & Live Cypher writes:** Drawing a custom blockade box or executing a write query in Live Cypher mutates only the current browser tab's disposable `:memory:` Relate instance (zero OPFS) and can be reset to the canonical graph with one click; `data/chokepoint.rl` is never touched by the browser.

### Datasets & Licenses

| Asset / Dependency | Source | License |
|---|---|---|
| `data/raw/marnet_searoute.geojson`, `data/raw/ports.geojson` | [`searoute-py`](https://github.com/genthalili/searoute-py) (Eurostat / Marnet) | Apache License 2.0 (see [`NOTICE`](/NOTICE)) |
| `public/data/land.geojson` | [Natural Earth 1:50m Land Polygons](https://www.naturalearthdata.com/about/terms-of-use/) | Public Domain (see [`NOTICE`](/NOTICE)) |
| `relate` CLI & `@relate/relate-wasm@1.1.0` | Relate by Neo4j | Apache License 2.0 (binary) |
| Chokepoint Lab application, ETL & tests | This repository | MIT License (see [`LICENSE`](/LICENSE)) |

### AI Disclosure

This project was developed with AI coding assistance (Claude Code) for architecture iteration, TypeScript ETL/engine/UI implementation, automated test authoring, and documentation drafting. Every architectural assumption and published metric — including Relate `v1.1.0` static relationship-type disjunction planning, Native <-> WASM parity (`diffCount: 0`), 3-stage `.begin`/`.rollback` checksum preservation, and live `relate serve --mcp` tool transcripts — was empirically executed and verified against real Relate `v1.1.0` binaries and the automated Vitest suite.
