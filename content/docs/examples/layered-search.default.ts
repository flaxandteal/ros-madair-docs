// Two layers, one search. The base layer is the emitted Site tiles; the overlay
// is a sparse second Parquet that re-designates two Sites' heritage_designation.
// This composes them at query time — overlay tiles WIN per (resource, nodegroup),
// the base fills in everything the overlay doesn't touch — then filters. The
// `layer` column shows which layer supplied each surviving tile.
//
// Scheduled Monument, base-only: {Baile an Iarthair, Ceantar Theas, Mí Locha}.
// With the overlay: Cé an Rí appears (re-designated TO Scheduled) and Ceantar
// Theas drops (re-designated AWAY) — in a single search.
export const DEFAULT_SQL = `WITH layered AS (
  SELECT resource_id, descriptor_name, concept_id, concept_label, layer FROM (
    SELECT resource_id, descriptor_name, concept_id, concept_label, nodegroup_id,
           1 AS rank, 'base' AS layer
    FROM read_parquet('base_sites.parquet')
    WHERE nodegroup_id = '15bc97aa-9bf2-5610-9d4f-fcbcffa8524b'   -- heritage_designation
    UNION ALL
    SELECT resource_id, descriptor_name, concept_id, concept_label, nodegroup_id,
           2 AS rank, 'overlay' AS layer
    FROM read_parquet('overlay_sites.parquet')
    WHERE nodegroup_id = '15bc97aa-9bf2-5610-9d4f-fcbcffa8524b'
  )
  -- overlay (rank 2) wins over base (rank 1) for the same resource + nodegroup
  QUALIFY row_number() OVER (PARTITION BY resource_id, nodegroup_id ORDER BY rank DESC) = 1
)
SELECT descriptor_name AS site, concept_label AS designation, layer
FROM layered
WHERE concept_id = 'a7d38e93-1442-590e-b976-70a321a45421'   -- Scheduled Monument
ORDER BY layer DESC, site;`;
