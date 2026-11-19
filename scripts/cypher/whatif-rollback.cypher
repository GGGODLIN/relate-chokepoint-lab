// Stage 1: Baseline route (Kaohsiung -> Rotterdam, Northwest Passage blocked by default)
MATCH (a:Port {code: 'TWKHH'}), (b:Port {code: 'NLRTM'})
OPTIONAL MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_BABALMANDAB|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_ORMUZ|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUEZ|PASSAGE_SUNDA*]-(b))
RETURN '1_baseline' AS stage,
       a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) AS totalKm;

MATCH ()-[r:PASSAGE_SUEZ|PASSAGE_BABALMANDAB]->()
WITH count(r) AS corridorEdges
RETURN '1_baseline_edges' AS stage, corridorEdges;

// Stage 2: Open explicit transaction, delete Red Sea chokepoint edges, and recompute detour
.begin
MATCH ()-[r:PASSAGE_SUEZ|PASSAGE_BABALMANDAB]-()
DELETE r;

MATCH ()-[r:PASSAGE_SUEZ|PASSAGE_BABALMANDAB]->()
WITH count(r) AS corridorEdges
RETURN '2_blocked_edges' AS stage, corridorEdges;

MATCH (a:Port {code: 'TWKHH'}), (b:Port {code: 'NLRTM'})
OPTIONAL MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_BABALMANDAB|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_ORMUZ|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUEZ|PASSAGE_SUNDA*]-(b))
RETURN '2_blocked_in_tx' AS stage,
       a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) AS totalKm;

// Stage 3: Roll back transaction and confirm baseline route + edges are fully restored
.rollback
MATCH ()-[r:PASSAGE_SUEZ|PASSAGE_BABALMANDAB]->()
WITH count(r) AS corridorEdges
RETURN '3_after_rollback_edges' AS stage, corridorEdges;

MATCH (a:Port {code: 'TWKHH'}), (b:Port {code: 'NLRTM'})
OPTIONAL MATCH p = shortestPath((a)-[:SEA_OPEN|PASSAGE_BABALMANDAB|PASSAGE_BERING|PASSAGE_BOSPORUS|PASSAGE_CHILI|PASSAGE_DARDANELLES|PASSAGE_GIBRALTAR|PASSAGE_MALACCA|PASSAGE_ORMUZ|PASSAGE_PANAMA|PASSAGE_SOUTH_AFRICA|PASSAGE_SUEZ|PASSAGE_SUNDA*]-(b))
RETURN '3_after_rollback' AS stage,
       a.code AS fromCode,
       b.code AS toCode,
       length(p) AS hops,
       round(reduce(km = 0.0, r IN relationships(p) | km + r.km), 1) AS totalKm;
