// Selecting by a CLM reference. The promoted `concept_id` column carries each
// tile's reference key — the controlled-list item id (`list_item_id`) — so this
// filters Sites whose `heritage_designation` reference is "Scheduled Monument",
// by that item's id (not its label). This is exactly a
// `Concept { path: "heritage_designation", op: Is, value: <list_item_id> }`
// predicate, compiled to SQL over the zone-mapped column.
export const DEFAULT_SQL = `SELECT DISTINCT resource_id
FROM read_parquet('tiles_64368e71-abbc-53ba-9bd8-87e2500f8e65.parquet')  -- Site
WHERE concept_id = 'a7d38e93-1442-590e-b976-70a321a45421'   -- heritage_designation = "Scheduled Monument"
ORDER BY resource_id;`;
