# Phase 2 status — Shared ERP services

Test run: `cd backend && python -m pytest tests` → **167 passed** (85 from Phase 1 + 82 new). `makemigrations --check` clean.

## Implemented and tested
| Area | What exists | Tests |
|---|---|---|
| Organization (module 1 foundation) | Company, legal entities, branches, business units, departments (tree), teams, positions, cost centers, member profiles, currencies + exchange rates (Decimal), fiscal years/periods with sequential close + veto hook, holidays/business calendar, tenant settings schema | test_organization |
| Number sequences | Template validation, row-locked issuance, yearly/monthly reset, unique issued-number constraint | test_sequences (incl. concurrent issuance) |
| Events | Transactional outbox, relay with backoff and dead-letter, idempotent local consumers, optional RabbitMQ publisher via kombu, correlation IDs | test_events |
| Notifications | In-app + email, per-user preferences, tenant email switch, own-rows-only API | test_notifications |
| Workflow engine | Versioned definitions, sequential stages, ANY_OF/ALL_OF, role/user/department-head/manager approvers, amount thresholds, reject, request changes, resubmit, delegation, escalation (Celery beat), cancel, separation of duties, distinct approvers, append-only action log (DB trigger), one active instance per record, row-locked concurrency | test_workflows (incl. 6-thread race) |
| Files | Extension allowlist + content sniffing, zip-bomb guard, server-generated storage keys, per-file access (owner / files.manage / module-registered check), nosniff attachment downloads, 60 s signed links bound to user+tenant+file, soft delete + retention purge, scanner hook | test_files |
| Tenant migrations | `manage.py migrate_tenants`: per-tenant isolation of failures, MIGRATION_FAILED + audit, auto-repair, non-zero exit | test_migrate_tenants |

## Fixes made while building
Tenant resolution under `schema_context` (`shared.tenancy.current_tenant`); `TenantTask` now restores the caller's schema and no longer trips Celery's signature check.

## Not done / honest limits
- RabbitMQ publishing verified only against kombu's in-memory transport, not a live broker.
- Files: local-disk storage only (adapter hook `FILE_STORAGE_CLASS` exists; no S3 adapter). No antivirus engine (scanner hook only).
- Workflow `submit` is a service call for modules (no HTTP submit by design); no module has registered subjects yet beyond `generic`.
- Approver-less stages after distinct-approver filtering fail the decision with `no_eligible_approvers` (rolled back) rather than stalling.
- Delegation passes the approver's authority to any active member except the requester; no further restriction.
- No frontend (deferred per request); Celery beat schedules not exercised against a live worker.
