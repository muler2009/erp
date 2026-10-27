# Phase 1 status report

## Selected versions (installed and exercised in this repo)
Python 3.13, Django 5.2.18 (LTS), DRF 3.16.1, django-tenants 4.0.1, psycopg 3.3.6, PostgreSQL 16.15, Celery 5.6.3,
PyJWT 2.15.1, cryptography 50.0.2, drf-spectacular 0.30.0, pytest 9.1.1 / pytest-django 4.14.0.
(Phase 0 proposed Python 3.12; 3.13 is what the build environment provides and all dependencies ran on it.)

## Implemented and tested (85 automated tests, all passing against a real PostgreSQL 16)
- Public/tenant schema split per the Phase 0 design; host-based tenant resolution; unknown host -> 404; client tenant headers ignored.
- Tenant provisioning saga: 9 recorded steps, idempotent request (Idempotency-Key), resumable retry, advisory-lock single runner,
  tenant never ACTIVE unless a health check passes, failures visible via API.
- Lifecycle: suspend (READ_ONLY/BLOCKED), reactivate, deactivate, deletion request with retention window and recovery
  (no data is destroyed). Hard suspension and deactivation revoke sessions.
- OIDC BFF: code + PKCE(S256), state/nonce, one-shot login state, signature/issuer/audience/expiry/alg allow-list validation,
  JWKS rotation, server-side encrypted token storage, refresh, logout, CSRF, Bearer JWT path, open-redirect protection.
- Identity: (issuer, subject) mapping; linking only by one-time hashed invite token or a freshly created Keycloak account (never by email).
- RBAC: permission catalog, system roles, scoped and time-boxed assignments, delegation ceiling, last-owner protection,
  platform permissions impossible in tenant schemas (service layer + DB check), 5-step pipeline (+ extension point for object rules).
- Platform: explicit-permission superadmin (no bypass), MFA gate, four-eyes admin creation, break-glass tenant access
  (justification, ticket, approval by a different admin, <=4h, audited in both trails, DB check on self-approval), entitlements.
- Audit: append-only platform and tenant trails (model + PostgreSQL triggers).
- Tenant-aware Celery base task; isolation tested at API, ORM, Celery and DB levels.

## NOT done / not verified
- **KeycloakAdminClient has never run against a live Keycloak**; it is tested only through a fake. The OIDC flow is likewise tested
  against an in-process fake IdP. First integration run against real Keycloak 26 may need adjustments (e.g. `amr` mapper, client UUID).
- Docker Compose, Dockerfile, nginx, Keycloak realm JSON and the CI workflow were written but **not executed**.
- No frontend yet (Phase 1 scope here is backend). No RabbitMQ/outbox, WebSockets, Prometheus/Grafana, OTel tracing,
  Kubernetes manifests, backup/restore scripts (designed in Phase 0, scheduled for later phases).
- Final tenant purge (export + two-admin approval) and drift reconciliation job are not implemented.
- Session revocation scans all sessions (O(n)); acceptable for now, needs a tenant/user index at scale.
- Tenant-schema migration fan-out status (`MIGRATION_FAILED` handling) exists as a state, but no automated fan-out command tracks it yet.
- Object-level and workflow-state authorization rules are an empty registry until business modules exist (Phase 2+).
- Defaults chosen for unanswered questions: subdomain-per-tenant, jurisdiction-neutral, local/Docker hosting.
