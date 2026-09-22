# Modular Dungeon import diagnosis and fix plan

Status: implemented and verified on 2026-09-22.

## Verified on 2026-09-22

The game at `http://localhost:18000` visibly has missing wall/floor surfaces and a narrow, detached-looking doorway arch. A fresh browser session boots successfully with no captured warning/error logs. HTTP reads of `app.js` and all six dungeon JSON assets return 200 and match this checkout byte for byte. This is a conversion/assembly problem, not a missing-file or stale-container problem in the current run. The service worker does not cache `/assets/` or `app.js`.

The checkout already contains uncommitted game, weapon, and dungeon changes. Preserve those changes and keep implementation scoped to this repair.

## Causes

### 1. OBJ polygons are truncated during conversion — primary defect

`devtools/dungeon2json.py:65` emits two triangles for a quad and only `(0, 1, 2)` for every other face. Faces with 5–22 vertices therefore lose most of their surface. The source archive actually contains these faces; this is not a hypothetical parser edge case.

| Asset | Source faces with >4 vertices | Current exported triangles | Source sum of (face vertices − 2) |
| --- | ---: | ---: | ---: |
| Wall_Modular | 36 | 1,415 | 1,672 |
| Floor_Modular | 24 | 990 | 1,176 |
| Arch | 102 | 3,840 | 4,484 |
| Crate | 7 | 2,402 | 2,502 |
| Barrel | 26 | 1,242 | 1,384 |
| Cobweb | 0 | 1,108 | 1,108 |

The last column is a triangulation budget, not an unconditional output assertion: collinear/degenerate vertices may legitimately reduce triangle counts. The current converter also drops some degenerate first triangles.

Projection and turn-sign analysis identifies all 36 wall, 24 floor, and 102 arch n-gons as concave. Replacing the current branch with a vertex-zero triangle fan would not reliably preserve those polygons. Use a triangulator that handles concavity and preserves winding/material assignment.

The same truncating code exists in `devtools/obj2json.py:47`; avoid copying it as the repair. Auditing or regenerating unrelated enemy/weapon assets is separate scope.

### 2. The entire arch is fitted to one tile — separate assembly defect

`devtools/dungeon2json.py:19` sets `ARCH_SPAN = 1.0`. The fit at line 80 produces an entire arch only **1 m wide × 3 m tall × 0.2418 m deep**. Its original dimensions are approximately **4.1044 × 4.0101 × 0.9926**.

`client/static/app.js:526` places one complete arch at each `d` tile. The map reserves an `a-d-a` span of **three 1 m client tiles**; ordinary pack walls are only built for `#`, so nothing else fills the two arch flank cells. This produces narrow arches separated from neighboring wall runs. Horizontal and vertical doorway orientation logic is consistent with the map; the imported dimensions are wrong.

### 3. Secondary converter correctness issues

- The converter claims to preserve source normals, but parses `vn` and then discards them, generating flat triangle normals at lines 106–116. This is a shading-policy inconsistency, not the cause of missing surfaces.
- Negative OBJ indices are off by one: indices are adjusted using `len + index` but later accessed with another `−1`. The selected source files contain no negative face indices, so this is a latent defect rather than the cause of this incident.
- The wall is deliberately stretched from roughly `2 × 2 × 0.44` into `1 × 3 × 1`. Keep the current game grid contract for this repair; evaluate its visual proportions separately rather than changing the whole map scale.

## Implementation sequence

1. **Make conversion testable and fix polygon triangulation.** Move CLI execution behind `main()` and accept explicit input/output paths. Project each polygon onto its dominant plane and use robust ear clipping (or a pinned, proven equivalent), handling repeated/collinear vertices and preserving winding. Reject unsupported/invalid polygons with filename and face information rather than silently truncating them. Normalize positive and negative indices consistently. Preserve material boundaries. Retain the existing JSON schema so the client loader need not change.

2. **Define and implement normals deliberately.** Preserve source corner normals where present, applying the inverse transpose of the asset scale and renormalizing. Use geometric normals where source normals are absent. Validate hard edges and remove the misleading docstring if the final artistic decision instead requires explicit flat shading.

3. **Correct the doorway assembly contract.** Fit the complete arch across the three-tile span, keep its top at the 3 m ceiling, and fit depth to the existing 1 m wall band independently of width. Keep one arch per `d`, centered as now, in both orientations. Check the actual jamb/opening geometry at walking height: the central tile must remain clear, and the frame must connect to adjacent wall tiles. Preserve the existing map and collision semantics, including blocked `a` flanks. Resolve any remaining seam with a narrowly scoped connector/fit adjustment, not a map rewrite. Also check floor top elevation and arch-foot contact; the current slab occupies `y=0..0.125` while arches/props begin at `y=0`.

4. **Regenerate the six dungeon JSON assets reproducibly.** Read the selected OBJ/MTL files from the bundled archive, including its hidden `.Updated Modular Dungeon - May 2019/` directory. Record source asset, source polygon counts, output triangle counts, skipped degeneracies, dimensions, and generation command in a small report. Generate into a temporary output directory first, validate, then replace only the dungeon outputs. Repeating the conversion must produce identical files.

5. **Verify geometry before relying on the game smoke test.** Add focused converter fixtures for a concave polygon, both windings, a quad, negative indices, missing normals, and nonuniform scaling. For actual pack faces, verify triangulated area/coverage and winding in the projected plane; count checks alone cannot detect triangles covering the wrong region. Validate finite coordinates, valid indices, normal lengths, material assignment, and asset bounds. Add doorway placement checks for both axes and the complete `a-d-a` extent.

6. **Rebuild and visually verify the running game.** The Docker image copies `client/static`; the compose configuration only bind-mounts maps. Rebuild/recreate the server service after replacing assets, preserving the database. Confirm HTTP responses match the new outputs and reload the page. Inspect walls from both sides, floor tiles from above/oblique angles, both doorway orientations, crate/barrel caps, and room corners. Use a neutral-lit asset inspection scene alongside the normal game view so fog and dithering cannot hide defects. Verify traversal through doors and no runtime/asset warnings. Keep instancing and compare render cost with the baseline, because restoring missing geometry increases the triangle count.

## Acceptance criteria

- Every supported source polygon is fully represented or explicitly reported as invalid/degenerate; no silent first-triangle truncation.
- Walls, floors, crate panels, and barrel caps have no holes introduced by conversion under normal front-face culling.
- Each arch spans the three reserved tiles, joins its neighboring walls, reaches the ceiling, and leaves the center path clear in both orientations.
- Source materials and the chosen normal policy survive conversion; existing weapon changes are preserved.
- Converter checks, doorway checks, existing scene smoke checks, and live visual inspection pass. Mesh/instance counts alone do not establish success.
- The served artifacts are verified against the regenerated files; no database reset is required.

## Verification result

The converter now produces the full source triangulation totals for all six assets with zero skipped degeneracies. Repeated generation directly from `modular-dungeon.zip` is byte-identical. The arch bounds are `3 × 3 × 1` metres. The complete Python suite passes (58 tests), and the browser scene smoke test passes with the expected seven instanced meshes, 71 prop groups, and no runtime/HTTP errors. Live inspection confirmed solid wall/floor surfaces, joined doorway flanks in both viewed orientations, and successful doorway traversal. The rebuilt container's SHA-256 hashes match the generated workspace assets.
