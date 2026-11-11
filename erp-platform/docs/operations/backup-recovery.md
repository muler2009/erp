# Backup and recovery
## What is backed up
`infrastructure/backup/backup.sh` writes one directory per run: `public.dump` (platform registry, identity mappings, subscriptions),
one `<schema>.dump` per tenant (all business data), `files.tar.gz` (uploaded files and report outputs) and `SHA256SUMS`.
Per-schema dumps let one tenant be restored without touching others. Dumps use `pg_dump --format=custom`.

## Verified behaviour (executed on PostgreSQL 16)
- Backup of public + two tenant schemas, then `verify-restore.sh`: every schema restored into a scratch database with identical row counts.
- A dump altered by one byte is detected by `SHA256SUMS`; restore and verification refuse it.
- Damaging one tenant's rows then `restore.sh <dir> <schema>` returned that tenant to its backed-up state (10 -> 500 rows) and left the other tenant unchanged.
- A schema name that is not `[a-z_][a-z0-9_]*` is refused.

## Targets (proposed, to be agreed)
| | Target | How it is met |
|---|---|---|
| RPO | 24 h with the shipped nightly CronJob | Lower RPO needs WAL archiving / PITR on the database (managed Postgres or pgBackRest). **Not configured by this repository.** |
| RTO (one tenant) | < 1 h | restore.sh, runbook "Restore one tenant" |
| RTO (everything) | a few hours | runbook "Restore everything" |

## Retention
`RETENTION_DAYS` (default 14) local dumps. Copy off the cluster with `BACKUP_UPLOAD_CMD` (for example `aws s3 sync {dir} s3://bucket/erp/`); keep the off-site copy in another failure domain and encrypt it.
Tenant deletion is a retention process in the application (data kept until `retention_until`), independent of these backups; a deleted tenant stays in older backups until they expire.

## Not covered
Keycloak realm and database backups, Redis (only a task queue: loss means re-run of idle schedules, the outbox is in Postgres), RabbitMQ messages not yet delivered (the outbox re-sends), PITR.
