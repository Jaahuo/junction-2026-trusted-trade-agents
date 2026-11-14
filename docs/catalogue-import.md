# Catalogue PostgreSQL cutover

## Storage and scope

The catalogue owns its Drizzle tables and generated migrations under `contexts/catalog/`.
PostgreSQL stores complete product objects, source order, enrichment rows, the supplied schema and import identity.
The search index remains a projection. It does not define which source fields survive import.
Search, ranking, quantities, facts and REST/MCP response schemas stay unchanged.

Runtime consumers use PostgreSQL only. Migration, startup, reset and first request never import source files.
There is no source-file fallback or recurring synchronization.
Builds and CI use invented products. Neither API nor OpenWebUI images contain challenge source files.
OpenWebUI retains its image-based asset delivery and separate persistent chat volume.

## Source inventory

Keep these files in a private directory outside every Git worktree:

| File                                             | Purpose                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `valio_aimo_junction26_product_data.json`        | Complete product records, including fields outside the current search projection |
| `valio_aimo_junction26_product_data_schema.json` | Supplied validation schema and provenance                                        |
| `valio_aimo_junction26_delivery_reliability.csv` | Historical delivered-to-ordered ratio                                            |
| `valio_aimo_junction26_carbon_footprint.csv`     | Product-group average kg CO2-eq/kg                                               |
| `demo-products.json` (optional)                  | Demo product ids, quantities, observation time and scenario state                |

The latest user-supplied product JSON and CSVs matched the original tracked checksums during this cutover.
The source bundle contained 17,546 products, 4,425 reliability rows and 11,033 carbon rows.
No source rows or field values belong in tracked tests, seeds, issue bodies or PR evidence.
Use fictional fixtures for permanent regression tests.

| Former consumer                                 | PostgreSQL replacement                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Catalogue file adapter and its route/load tests | Database loader, unchanged pure projection, fictional imported fixtures                     |
| Order-history seed                              | Imported demo metadata passed by reset orchestration                                        |
| Demo smoke and scenario 3 scripts               | Imported demo metadata from the selected database                                           |
| Demo-data checker                               | Database products and enrichments; targeted live price/availability requests remain bounded |
| Local and hosted reset                          | Preserve catalogue tables and migration ledger; reset other contexts                        |
| Deploy script, cloud-init and deployment tests  | Image-only API deployment without rsync, data permissions or source bind mounts             |
| CI API image smoke                              | Explicit fictional import into disposable PostgreSQL, then search/facts through the image   |

The supplied schema had no executable consumer before this cutover. The importer now validates against it.
The Docker build context excludes the original source basenames as well as `data/`.
The historical secret-scan exception remains relevant because history is not rewritten.

## Migration and import order

Production import requires separate operator approval. The commands below are not authorization to run it.
Use an approved checkout, an explicit target database and the preserved source bundle.
Keep database credentials in the operator environment, never in command history or a PR.

1. Preserve the original source directory and record SHA-256 values before removing or changing files.
2. Back up the target database and verify that its restore procedure works on a disposable database.
3. Check the selected database identity. For local work, run `bun scripts/runtime.ts status` in the task worktree.
4. Obtain approval before selecting a hosted target or running its import.
5. Run the explicit importer from the repository root. Set `DATABASE_URL` for an explicitly selected target.

   ```sh
   bun scripts/catalog-import.ts --source /absolute/private/catalogue-directory
   ```

6. Retain the import report with checksums and counts in a private operational record.
7. Repeat the same command with unchanged inputs. It must report an identical import without changing stored data.
8. Verify full product objects and every enrichment row against the preserved source bundle on a disposable target.
9. Exercise `/api/catalog/search` and `/api/catalog/facts`. Compare results with the pre-cutover baseline, not health alone.
10. After import verification, deploy the PostgreSQL-only image without a data mount.
11. Verify search, facts and demo metadata-driven reset on the selected release before opening access.

The importer applies catalogue migrations before writing data. Existing file-backed releases ignore the new tables.
This permits an approved import before changing the running API image.
Automatic deployment never imports the catalogue. Plan the approved import before merging or deploying this cutover.
An empty catalogue returns the existing upstream-error envelope rather than a fabricated empty success.

## Validation and import identity

All required files must exist and validate before the importer writes catalogue rows.
The source directory must be outside Git. Inputs must remain inside that directory after symlink resolution.
The importer validates the supplied schema, product identities, searchable fields, CSV headers and numeric ranges.
It retains unknown product fields, enrichment source cells, source order and missing enrichment values.
It does not silently skip rejected products or overwrite conflicting identities.

Checksums cover source bytes, including the optional demo document or its absence.
All catalogue rows and the manifest commit in one transaction.
An advisory lock prevents concurrent writers from publishing partial imports.
An identical repeated import is safe. Changed inputs are a conflict, not an update request.
There is no force, replace or merge mode.

Local and hosted demo resets retain catalogue data and the catalogue migration ledger.
They read optional imported demo metadata and pass it to the order-history seed.
Without that metadata, the seed warns and adds no history. Demo scripts fail rather than choose invented products.
Dropping a worktree database still deletes its imported catalogue.

### Select the demo database

Demo scripts implicitly use only this worktree's owned database and exact API port.
An inherited `DATABASE_URL` does not prove explicit selection for another application.
For another target, use `--database-env NAME` to name an environment variable that holds its database URL.
This applies to the checker, smoke script and scenario 3 script.
Keep that credential outside command arguments and tracked files.
With `demo-smoke.ts`, also pass `--no-reset`. Reset the selected target separately, with its required approval.
Another worktree's loopback port is also a different target.

## Verification evidence

Permanent tests use fictional source bundles and disposable local PostgreSQL databases.
They cover complete nested fields, enrichments, schema and metadata, repeated imports, conflicts, failed writes and lock contention.
Search/facts and quantity regressions use the database-backed adapter.
Reset tests must retain catalogue data and its ledger across repeated resets.

Before release, record the actual repository gate result and independent migration review on the final PR head.
Run the built API image against a disposable imported database with no source files or data mounts.
Check search and facts through HTTP. Inspect the image/container for source files and mounts.
A successful build or `/api/health` response alone does not prove a working catalogue.

## Recovery and rollback

A validation error leaves catalogue data unchanged. Correct the private input and retry only if no import exists.
A failed write rolls back the complete import transaction. Retry the identical bundle after fixing the database cause.
After an interrupted client, inspect the manifest before retrying. The transaction either committed or rolled back.
Do not delete a committed manifest to bypass a conflict.

A conflict after a successful import requires investigation. Preserve both bundles and their reports.
There is no in-place dataset replacement in this release.
Recover into a new disposable database first. An operator must approve any hosted restore or replacement database cutover.
Restore transactional data and signing configuration consistently with the catalogue snapshot.
A database restore can lose orders created after that snapshot.

A code rollback does not reverse migrations or restore data.
Prefer a retained database-compatible image. A pre-cutover file-backed image cannot run under the new mount-free deployment unchanged.
Restoring that older deployment needs an approved service configuration rollback and its preserved private source directory.
Keep legacy production source files untouched until a separate cleanup approval.
Do not rewrite Git history or make the repository public as part of this cutover.
