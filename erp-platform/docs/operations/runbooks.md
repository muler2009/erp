# Runbooks
Each alert in `infrastructure/monitoring/alerts.yml` links to a section here. Metrics need the bearer token
(`ERP_METRICS_TOKEN`); every response carries `X-Request-ID`, which is also in the JSON logs (`correlation_id`).

## Backend down
1. `kubectl -n erp get pods -l app=erp-backend` (or `docker compose ps backend`). CrashLoop -> `kubectl logs --previous`.
2. Configuration errors fail fast at start: a missing `DJANGO_SECRET_KEY` / `ERP_TOKEN_ENCRYPTION_KEY` with `DJANGO_DEBUG=false` stops the process by design.
3. `/readyz` returning 503 means the database is unreachable: check Postgres first (the pods are healthy, they are only out of rotation).
4. Recent deploy? `kubectl -n erp rollout undo deploy/erp-backend`.

## High error rate
1. Grafana "Status codes" and "Slowest routes" show which route fails. Search logs for that route's `correlation_id`s.
2. Many 5xx on every route -> database or dependency. Many on one route -> a code defect: roll back, then fix.
3. 423 `tenant_read_only` / 503 `tenant_unavailable` are policy answers for one tenant (see Tenant failed), not platform faults.

## Slow requests
1. Slowest-routes panel. For the route, find the query count: the performance tests (`tests/test_performance.py`) show the budgets for the dashboard pages.
2. `pg_stat_statements` / `pg_stat_activity` for long queries and lock waits. Report endpoints scan whole tenants: check whether someone runs exports or scheduled reports at peak.
3. Scale out: `kubectl -n erp scale deploy/erp-backend --replicas=N` (the HPA does this on CPU).

## Event backlog
Alerts `ErpOutboxBacklog` (oldest pending > 15 min) and `ErpDeadLetteredEvents`.
1. Is `erp-beat` running (exactly one replica)? Is `erp-worker` consuming? `celery -A config inspect ping`.
2. Broker reachable? Local consumers still run without RabbitMQ; only external publication needs it.
3. Dead-lettered events: list them (`GET /api/v1/events?status=DEAD` as a tenant admin with `events.manage`), read `last_error`, fix the cause, then `POST /api/v1/events/<id>/retry`. Consumers are idempotent, so a retry is safe.

## Tenant failed
`erp_tenants{status="PROVISIONING_FAILED"|"MIGRATION_FAILED"}`. A `MIGRATION_FAILED` tenant is read-only (writes get 423) and keeps its data.
1. Platform console -> tenant -> job steps show the failing step and error.
2. Provisioning: `POST /api/v1/platform/tenants/<id>/provision` retries (idempotent). Migration: fix the cause, then `python manage.py migrate_tenants`.
3. If a migration damaged a schema, restore it (Restore one tenant) after suspending the tenant.

## Restore one tenant
Use when one tenant's data is damaged. The other tenants are untouched (one dump per schema).
1. Suspend the tenant: `POST /api/v1/platform/tenants/<id>/lifecycle/suspend` (blocks new business operations).
2. Pick the backup: `ls $BACKUP_DIR`. Prefer one from before the damage.
3. **Rehearse first** in a scratch database: `createdb scratch && restore.sh <dir> <schema> scratch`; inspect.
4. Restore for real: `infrastructure/backup/restore.sh <dir> <schema>` (verifies checksums, replaces the schema in one transaction).
5. Restore files if needed from `files.tar.gz` (uploaded documents and report outputs).
6. Resume the tenant: `.../lifecycle/reactivate`. Events emitted after the backup point are lost; check the outbox and re-run any integration that needs it.
7. Record the incident in the platform audit log (the lifecycle calls already do).

## Restore everything (disaster)
1. New database server, same major version (16). Empty database, then `pg_restore` `public.dump` first, then each tenant dump.
2. `python manage.py migrate_schemas --shared` and `migrate_tenants` (should be a no-op if versions match; if the restored backup is older than the code, this brings it forward).
3. Restore `files.tar.gz` into `FILE_STORAGE_ROOT`. Verify with `verify-restore.sh` semantics (row counts) and `/readyz`.
4. Keycloak is a separate system with its own backup (realm export + its database); users cannot log in without it.

## Backup failed
The CronJob keeps failed Jobs (`kubectl -n erp get jobs`). `verify-restore.sh` exits non-zero when a dump cannot be restored or row counts differ, which fails the Job. A backup that was not verified is not a backup: fix and run `kubectl -n erp create job --from=cronjob/erp-backup manual-1`.

## Unauthorized /metrics scrapes
Repeated 401s on `/metrics`: someone is probing. It is never exposed by the ingress (404 at the edge); check that Prometheus has the right token and that the NetworkPolicy still limits access.

## Rotate secrets
`DJANGO_SECRET_KEY` rotation logs everyone out (sessions). `ERP_TOKEN_ENCRYPTION_KEY` encrypts stored refresh tokens: rotating it invalidates them and users sign in again. `ERP_METRICS_TOKEN`: update the secret and Prometheus' token file together.
