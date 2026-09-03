// Seed query for the tile-store demo. It selects resource ids from the
// HazardFootprint model's tile-row Parquet; the wrapper then hands each id to
// alizarin, which hydrates a rich, typed resource — following its links
// (produced_by_model, scenario) lazily, each one another Parquet read.
//
// Edit it: change the model file, add a WHERE on the tile `data`, join across
// models — whatever returns a `resource_id` column.
export const DEFAULT_SQL = `SELECT DISTINCT resource_id
FROM read_parquet('tiles_db1c639e-5b26-5af7-8107-ec4debde487b.parquet')  -- HazardFootprint
ORDER BY resource_id
LIMIT 10;`;
