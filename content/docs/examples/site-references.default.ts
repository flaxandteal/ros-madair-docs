// Selecting Sites by a CLM `reference`. This is the SQL the ros-madair compiler
// emits for the typed predicate
//   Concept { path: "heritage_designation", op: Is, value: <list_item_id> }
// against a model whose references are melted into the per-node concept store
// (`concepts_<graphid>.parquet`, registered as the `concept_index` view). It keys
// on the node (heritage_designation) AND the controlled-list item id ("Scheduled
// Monument"), node-scoped and exact — not a scan of a per-tile column.
//
// This is engine output, not hand-written SQL: the same `compile_query` that
// `ros-madair-duck` runs natively produced it (via ros-madair wasm in the browser).
export const DEFAULT_SQL = `SELECT DISTINCT resource_id
FROM concept_index
WHERE node_id = '15bc97aa-9bf2-5610-9d4f-fcbcffa8524b'   -- heritage_designation
  AND concept_id = 'a7d38e93-1442-590e-b976-70a321a45421';  -- "Scheduled Monument"`;
