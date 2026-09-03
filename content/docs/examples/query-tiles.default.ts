// The seed query for the live editor. Kept in its own import-light module so the
// editable card can display it without pulling duckdb-wasm into the page shell;
// duckdb loads only when Run is clicked.
//
// Concept ⋈ Bbox ⋈ Range — the same shape ros-madair-query compiles a typed
// Query into, as straight SQL over the tile-row Parquet columns:
//   Concept: DescendantOrSelfOf('Settlement') via the catalog's DFS interval
//   Bbox:    the promoted geo_* columns (row-group min/max = the zone-map)
//   Range:   q_ordered (days-from-epoch) >= 1900-01-01
export const DEFAULT_SQL = `SELECT t.descriptor_name                       AS place,
       cat.label                               AS type,
       (DATE '1970-01-01' + t.q_ordered::INT)  AS established,
       t.data                                  AS data
FROM read_parquet('tiles_place.parquet')       AS t
JOIN read_parquet('concept_catalog.parquet')   AS anc ON anc.label = 'Settlement'
JOIN read_parquet('concept_catalog.parquet')   AS cat ON cat.concept_id = t.concept_id
WHERE cat.dfs_enter BETWEEN anc.dfs_enter AND anc.dfs_leave
  AND t.geo_min_lng >= 80.20 AND t.geo_max_lng <= 80.30
  AND t.q_ordered >= (DATE '1900-01-01' - DATE '1970-01-01')
ORDER BY established DESC
LIMIT 12;`;
