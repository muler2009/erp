# Phase 11 — Hardening and production readiness

## Implemented
- Prometheus metrics (`/metrics`, bearer token; request counters/latency by route template; tenant status, outbox backlog/age/dead-letter gauges), multiprocess-safe.
- Security headers, HSTS/SSL redirect/secure cookies behind a proxy; clickjacking middleware (was missing).
- Probes and scrapes answered on any Host (pod IP); readiness reports database (fatal) and broker (degraded only).
- Whole-surface authorization sweeps (anonymous, platform host, role-less member) plus header/metrics/host/readiness tests.
- Query-budget tests and a batch permission helper (KPI list 128 -> 46 queries, executive dashboard 94 -> 52, catalog 26 -> 2).
- Backup, restore and verify-restore scripts (per-schema, checksummed), exercised on PostgreSQL.
- Docker Compose: rabbitmq, beat, health checks; observability overlay (Prometheus, Grafana dashboard, alert rules, postgres exporter).
- Kubernetes reference manifests; CI (lint, tests, migrations check, pip-audit, bandit, gitleaks, Trivy) and a manual deploy workflow with pre-deploy backup and automatic rollback.
- Generated OpenAPI path inventory (docs/api). Runbooks, deployment, backup/recovery, hardening notes.
- Code fixes found on the way: undefined-variable risk in procurement overdue lines; a bandit false positive annotated.

## Tested (executed)
`tests/test_hardening.py` (14), `tests/test_performance.py` (4); backup/restore scripts run by hand (see backup-recovery.md). Full-suite result in the delivery message.

## Not done / not verified
- Kubernetes manifests, Grafana dashboard, Prometheus rules, CI and deploy workflows are validated as YAML/JSON only; none was run against a cluster, Prometheus, Grafana or GitHub.
- Not run here: Docker builds (no Docker), Trivy, pip-audit, gitleaks, load/soak testing, penetration testing.
- No PITR/WAL archiving (RPO 24 h), no Keycloak backup, backup image not built, no object-storage file backend.
- OpenAPI has no request/response bodies; the React frontend is still deferred.
- DRF throttle state is per process unless a shared cache is configured.
