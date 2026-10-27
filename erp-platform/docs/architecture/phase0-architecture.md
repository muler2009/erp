# ERP Platform: Phase 0 Architecture

Status: **proposal for approval**. No application code. Greenfield (no existing repository found).
Each major decision lists: recommendation, alternatives, trade-offs, security implications.

---

## 0. Key Decisions Summary

| # | Decision | Recommendation |
|---|----------|----------------|
| D1 | Deployment shape | Modular monolith (one Django project, 14 bounded-context apps), separate Celery workers |
| D2 | Tenancy | django-tenants, schema per tenant, shared `public` schema for registry |
| D3 | Identity | Single Keycloak realm, OIDC, identity key `(iss, sub)` |
| D4 | Browser auth | BFF pattern: Django performs the code+PKCE flow, HttpOnly session cookie, tokens never reach JS |
| D5 | Authorization | Django-authoritative RBAC + scopes + object rules; Keycloak only authenticates (plus coarse platform flag) |
| D6 | Cross-module integration | In-process service interfaces + domain events; transactional outbox to RabbitMQ only for async/external consumers |
| D7 | Workflow | One generic workflow engine (GenericFK targets) in `shared/workflows` |
| D8 | Money | `Decimal` (NUMERIC(19,4)) with explicit currency; FX rate captured per transaction |
| D9 | Tenant deletion | Soft state machine with retention window, then export + purge |

---

## 1. System Architecture

```
                        Internet
                           │
                     ┌─────▼─────┐
                     │  Nginx /  │  TLS, rate limit, host routing
                     │  Ingress  │  acme.erp.com, platform.erp.com
                     └──┬─────┬──┘
            static SPA  │     │ /api, /auth (BFF)
              ┌─────────▼┐   ┌▼──────────────────────────────┐
              │ React SPA│   │ Django (ASGI)                  │
              │ (Vite)   │   │  TenantMainMiddleware          │
              └──────────┘   │  BFF session + OIDC client     │
                             │  AuthN → Membership → Entitle  │
                             │  → RBAC → Object → Workflow    │
                             │  ┌──────── modules ─────────┐  │
                             │  │ platform/*  shared/*     │  │
                             │  │ modules/finance … (14)   │  │
                             │  └──────────────────────────┘  │
                             └──┬────────┬─────────┬─────────┬┘
                                │        │         │         │
                    ┌───────────▼┐  ┌────▼───┐ ┌───▼────┐ ┌──▼────────┐
                    │ PostgreSQL │  │ Redis  │ │RabbitMQ│ │ Object    │
                    │ public +   │  │cache,  │ │domain  │ │ storage   │
                    │ tenant_*   │  │sessions│ │events  │ │ (S3/MinIO)│
                    └────────────┘  │celery  │ └───┬────┘ └───────────┘
                                    └────────┘     │
                             ┌─────────────────────▼───────┐
                             │ Celery workers (tenant-aware)│
                             │ outbox relay, reports, etc.  │
                             └─────────────────────────────┘
        Keycloak ◄── OIDC (browser redirect via BFF), JWKS, admin API (identity service only)
        Prometheus/Grafana/OTel collector ◄── all components
```

**Decision D1: modular monolith.**
Alternatives: microservices per module; monolith without boundaries.
Trade-offs: one deployable keeps transactions (journal posting, stock moves) in a single DB transaction, which is the hardest part of ERP. Cost: one scaling unit until extraction is needed.
Security: single authorization pipeline, no inter-service trust problem. Boundaries enforced by import-linter rules (modules may import only other modules' `api/` packages).
Extraction triggers: independent scaling (analytics, documents), separate team ownership, or divergent compliance needs.

---

## 2. Responsibility Matrix: Platform Superadmin vs Tenant Admin vs Tenant User

| Capability | Platform Superadmin | Tenant Admin | Tenant User |
|---|---|---|---|
| Create/suspend/deactivate tenants | ✔ (`platform.tenants.*`) | ✘ | ✘ |
| Retry provisioning, view failures | ✔ | ✘ | ✘ |
| Plans & module entitlements | ✔ define/assign | view; enable within entitlement | ✘ |
| Platform settings, integrations | ✔ | ✘ | ✘ |
| Create platform admins | ✔ (`platform.admins.manage`, requires 2nd approval) | ✘ | ✘ |
| Cross-tenant usage metrics (aggregated) | ✔ | ✘ | ✘ |
| Tenant business records | ✘ by default; **break-glass** only (justification, time-boxed, approved, audited) | ✔ per RBAC | ✔ per RBAC and scope |
| Tenant users, invites, activation | ✘ (via break-glass) | ✔ | ✘ |
| Roles & permission assignment | ✘ | ✔ within delegation ceiling | ✘ |
| Org structure, workflows, sequences | ✘ | ✔ | read |
| Tenant audit log | platform events only | ✔ tenant events | own activity |
| Platform audit log | ✔ | ✘ | ✘ |

Rules:
- "Superadmin" is a **named bundle of explicit platform permissions**, not a bypass flag. Every platform endpoint checks a specific permission.
- Platform admins live in the `public` schema (`PlatformAdmin` + `PlatformRoleAssignment`), separate from tenant memberships. Platform endpoints are served only on the platform host, which resolves to the public schema.
- **Delegation ceiling:** a tenant admin can grant only permissions they themselves hold, from the tenant-grantable catalog. Platform permissions are never grantable in tenant scope (enforced in the service layer and by a DB check on the permission's `scope` column).
- Break-glass: `TenantAccessGrant(admin, tenant, reason, ticket, approver, expires_at)`; second-person approval, max 4 h, all reads logged to both audit trails, tenant owner notified.

---

## 3. Keycloak Authentication and Identity Mapping

**Decision D3: one shared realm (`erp`).**
Alternatives: realm per tenant. Rejected initially: realm-per-tenant multiplies admin overhead, JWKS/issuer handling, and cross-tenant users (consultants, auditors) need multiple accounts. Revisit for tenants requiring own IdP federation: handled with Keycloak identity brokering per tenant (organization-level IdP in the shared realm) first, separate realm only for hard requirements.
Security: shared realm means a Keycloak compromise affects all tenants, so the application never treats a valid token as tenant authorization.

**Clients**
- `erp-bff` (confidential, Authorization Code + PKCE S256): used by Django for browser login.
- `erp-api-service` (confidential, client credentials): service-to-service/Celery calls where needed.
- `erp-identity-admin` (confidential, service account with narrow `manage-users`, `view-users` realm-management roles): used **only** by the identity provisioning component, never by other modules.
- No public SPA client (the SPA never holds tokens).

**Login flow (BFF)**
1. SPA loads from `acme.erp.com`. Django resolves tenant from Host (django-tenants domain table).
2. `/auth/login` creates `state`, `nonce`, PKCE verifier (server-side, in session), redirects to Keycloak. Tenant slug is bound to the server session, not a query param.
3. Callback: Django exchanges code, validates ID token (issuer, audience, signature via cached JWKS with rotation on unknown `kid`, `exp`, `nonce`, `azp`).
4. Identity lookup: `ExternalIdentity(issuer, subject) → User` in `public` schema. First login only: link by invite token, not by email match.
5. Membership check in the current tenant: `TenantMembership(user, tenant, status=ACTIVE)`. Fail ⇒ 403, no session data.
6. Session established: opaque session id in HttpOnly, Secure, SameSite=Lax cookie; access/refresh tokens stored server-side (Redis, encrypted), refreshed by the BFF. Session carries `tenant_id` fixed at login; switching tenants = new login/redirect to the other domain after membership check.
7. API requests: cookie + CSRF double-submit header; the authorization pipeline (§6) runs per request.
8. Logout: RP-initiated logout with `id_token_hint`, server session destroyed; back-channel logout endpoint revokes sessions when Keycloak ends them.

**Machine/API clients**: Bearer JWT accepted on a separate path (`/api/v1/` with `Authorization`), validated by the same JWKS validator, `aud` must equal `erp-api`; tenant derived from the domain/membership, never from claims alone.

**Realm policy**: password policy + breach check, MFA required for all platform admins and tenant admins (Keycloak conditional OTP/WebAuthn), access token 5 min, refresh 30 min idle / 8 h max, brute-force detection on.

**Sync**: Keycloak is the credential store; application owns profile/membership. Invite → create Keycloak user (required actions: verify email, set password, configure OTP) → store `(iss, sub)`. Deactivation in app disables membership immediately (authoritative) and disables the Keycloak user only if they have no other active memberships. Reconciliation Celery job detects drift.

---

## 4. django-tenants Schema Strategy

**Public schema (SHARED_APPS)**
`Tenant` (schema_name, slug, status, plan, region, retention fields), `Domain`, `Plan`, `ModuleEntitlement`, `PlatformSetting`, `PlatformAdmin`, `PlatformRole/Permission`, `ExternalIdentity`, `User` (global identity record: id, display name, status), `TenantMembership` (user ↔ tenant, status, role summary pointer), `TenantAccessGrant`, `PlatformAuditEvent`, `ProvisioningJob/Step`, `OutboxEvent` (platform), Celery result tables.

**Tenant schemas (TENANT_APPS)**
Org structure, `RoleDefinition`, `RoleAssignment`, `PermissionGrant`, `ObjectAccessGrant`, all 14 modules' models, workflow definitions and instances, tenant settings/sequences, tenant audit log, tenant outbox, documents metadata, notifications.

Placement decision for `User` and membership: identity and membership live in **public** so login can resolve "who is this and which tenants" before a schema is selected, and so one person can belong to several tenants. Tenant-level *profile in that tenant* (`TenantUserProfile`: employee link, department, title, status) lives in the tenant schema, keyed by `user_id` (UUID value, not FK, to avoid cross-schema constraints; integrity enforced by service layer + reconciliation test).

Cross-schema rules: no FK from tenant → public except via explicit UUID reference columns; no joins across tenants ever; the only public reads in tenant code go through a `platform_api` service.

**Middleware order:** request logging/correlation → `TenantMainMiddleware` (Host → Domain → schema) → session/BFF auth → tenant status gate → authorization pipeline. Unknown host ⇒ 404 on public schema without data. Headers like `X-Tenant-ID` are ignored (and logged as security events if present).

**Celery:** every tenant-scoped task takes `tenant_schema` (validated against registry) and runs inside `schema_context()` with `try/finally` restore; a base task class refuses to run tenant tasks without it; periodic fan-out tasks iterate tenants, each in its own task.

**Migrations:** shared via `migrate_schemas --shared`; tenant migrations run as a controlled fan-out with per-tenant status recorded (`TenantMigrationState`), failures alert and mark tenant `MIGRATION_FAILED` (read-only) rather than silently skipping. Expand/contract migration discipline for zero-downtime.

**Trade-offs of schema-per-tenant vs row-level:** strong isolation and per-tenant backup/restore; costs migration time at scale (hundreds of schemas OK, thousands need parallel/batched migration and possibly sharding by DB). Security: a missing filter cannot leak across tenants; the remaining risk is search_path mishandling, covered by tests (§13).

---

## 5. Tenant Provisioning and Lifecycle

**State machine:** `PENDING → PROVISIONING → ACTIVE ⇄ SUSPENDED → DEACTIVATED → PENDING_DELETION → ARCHIVED/PURGED`; plus `PROVISIONING_FAILED`, `MIGRATION_FAILED`.

**Provisioning saga** (a `ProvisioningJob` with idempotent steps, each step records status, attempt count, error):

1. Validate name/slug/domain uniqueness, reserved names.
2. Create `Tenant(PENDING)` + `Domain` (idempotency key = request key).
3. Create schema + run tenant migrations.
4. Seed reference data (roles, permission catalog sync, default workflows, sequences, currencies, COA template).
5. Apply plan entitlements.
6. Keycloak: find-or-create admin user (by invite id), required actions.
7. Create `User`/`ExternalIdentity` placeholder + `TenantMembership` + Tenant Owner assignment.
8. Health check (schema exists, migrations current, seed counts, admin can resolve).
9. Set `ACTIVE`, write audit event, emit `tenant.provisioned` via outbox, notify admin (invite email).

Failure policy: tenant stays `PROVISIONING_FAILED`, never ACTIVE; retry resumes at the failed step (each step checks "already done"); compensation only for Keycloak user created in this job and an empty schema; visible on the platform dashboard with alerting.

**Suspension:** block writes except configurable allow-list (tenant admin can export, view billing); reads per policy (`SUSPENDED_READONLY` vs `SUSPENDED_BLOCKED`). Enforced in the pipeline gate and by Celery task base class. Sessions revoked on hard suspend.

**Deletion:** deactivate → 30-day (configurable) `PENDING_DELETION` with owner-visible recovery → final encrypted export + archive → schema drop and Keycloak membership cleanup, requiring two platform admins. Backups retained per policy. Backup/restore per tenant via `pg_dump -n schema`; restore into a staging schema then swap.

---

## 6. RBAC and Permission Model

**Authorization pipeline (every protected endpoint, in order):**
1. Authenticated session/token valid
2. Active tenant membership
3. Tenant status permits operation (read vs write)
4. Module entitled and enabled
5. Permission check (`module.resource.action`)
6. Organizational scope (own / department / business unit / cost center / project / tenant)
7. Object-level rule (owner, assignment, explicit grant, record classification)
8. Workflow/business state (e.g. posted entries immutable, SoD)

Implemented as a single `AuthorizationService.authorize(actor, action, resource)` plus DRF permission classes that call it; views cannot opt out (default `DEFAULT_PERMISSION_CLASSES` denies; an unannotated view fails a CI check).

**Model (tenant schema):**
- `Permission` (code, module, scope=`platform|tenant`, description): code-defined catalog, synced by migration.
- `RoleDefinition` (name, is_system, tenant-configurable), `RolePermission`.
- `RoleAssignment(user, role, scope_type, scope_id, valid_from, valid_to, granted_by, delegated_from)`: scope ties a role to department/BU/project/entity.
- `ObjectAccessGrant(user|role, content_type, object_id, permission, expires_at)`.
- `DelegationRule` (delegator, delegate, permissions subset, window): delegation can never exceed delegator's own permissions at evaluation time.
- `SoDRule(permission_a, permission_b, rule)`: e.g. `finance.invoice.create` vs `finance.invoice.approve` on same object; `finance.payment.release` can't be same actor as approver.
- Role inheritance: **off by default**; explicit `parent_role` allowed only for system templates (documented).
- Permission change log: immutable, in tenant audit.

Keycloak roles: only `platform-admin` flag (coarse gate to reach the platform host) and MFA state. All ERP permissions resolved from the DB, cached per request/short TTL in Redis with versioned invalidation on assignment change.

Example: Finance Officer holds `finance.invoice.create`; Finance Manager `finance.invoice.approve`; Finance Controller `finance.payment.release`. SoD rule blocks one person doing create+approve on the same invoice.

Security: privilege-escalation checks (delegation ceiling, last-owner protection, platform permission impossibility), all grants audited, temporary access auto-expires via query-time `valid_to` check (not only a cleanup job).

---

## 7. Database ERD (shared and tenant)

```
PUBLIC
Tenant 1──* Domain
Tenant *──1 Plan 1──* ModuleEntitlement(module)
Tenant 1──* TenantMembership *──1 User 1──* ExternalIdentity(issuer,subject)
User 1──0..1 PlatformAdmin 1──* PlatformRoleAssignment *──1 PlatformRole *──* Permission(scope=platform)
Tenant 1──* ProvisioningJob 1──* ProvisioningStep
Tenant 1──* TenantAccessGrant(platform_admin, approver)
PlatformAuditEvent, PlatformSetting, OutboxEvent

TENANT (per schema)
TenantUserProfile(user_id) *──1 Department/Position
Company 1──* Branch ; Company 1──* LegalEntity ; BusinessUnit ; CostCenter
Department(tree) 1──* Team ; Position
RoleDefinition 1──* RolePermission ; RoleAssignment(user_id, role, scope) ; ObjectAccessGrant ; DelegationRule ; SoDRule
WorkflowDefinition 1──* WorkflowStep ; WorkflowInstance(target GFK) 1──* ApprovalTask 1──* ApprovalAction
FiscalYear 1──* Period ; Currency/ExchangeRate ; NumberSequence
Account(COA tree) ; JournalEntry 1──* JournalLine ; Invoice ; Payment ; BankAccount ...
Partner(customer/supplier) ; Product 1──* Variant ; Warehouse 1──* Location ; StockMove 1──* StockMoveLine ; Lot/Serial
PurchaseOrder 1──* POLine ; SalesOrder 1──* SOLine ; Employee ; PayrollRun 1──* Payslip ; Project 1──* Task ; Asset ; Document 1──* DocumentVersion ; AuditEvent ; OutboxEvent ; Notification
```

Conventions: UUIDv7/UUID PKs, `created_at/by`, `updated_at/by`, `version` (optimistic locking), money as `NUMERIC(19,4)` + `currency` + `base_amount`, CHECK constraints (debit=credit at post, non-negative qty where required), unique `(entity, number)` per sequence, partial indexes for open items, append-only tables protected by DB triggers (journal lines once posted, audit events), partitioning of audit/stock-move/ledger tables by time once volume warrants.

Accounting: `JournalEntry.status DRAFT→POSTED→REVERSED`; post action locks period row (`SELECT … FOR UPDATE`), verifies balance via DB constraint trigger on posted entries; corrections only by reversal entries; closed period blocks posting (service + trigger).
Inventory: stock is the **sum of immutable `StockMove` lines**; `StockQuant` is a derived, lock-protected projection updated in the same transaction; reservations are separate rows.

---

## 8. Fourteen-Module Domain Map

| # | Module | Owns (aggregates) | Publishes events | Consumes / calls |
|---|---|---|---|---|
| 1 | Organization & Admin | Company, Branch, Dept, Team, Position, CostCenter, FiscalYear, Sequences | `org.department.changed` | (foundation: used by all) |
| 2 | Finance | COA, Journals, AP/AR, Invoices, Payments, Periods, Budgets | `finance.invoice.posted`, `finance.payment.completed` | all posting sources |
| 3 | HR & Payroll | Employee, Contract, Attendance, Leave, Payroll | `hr.employee.created`, `hr.payroll.approved` | Org, Finance, Projects (timesheets) |
| 4 | CRM | Lead, Contact, Opportunity, Activity | `crm.opportunity.won` | Sales |
| 5 | Sales | Quotation, SO, Price list, Returns | `sales.order.confirmed` | CRM, Inventory, Finance |
| 6 | Procurement | Supplier, Requisition, RFQ, PO | `procurement.purchase_order.approved` | Inventory, Finance, Workflow |
| 7 | Inventory | Product, Warehouse, StockMove, Lots, Valuation | `inventory.goods_received` | Procurement, Sales, Mfg |
| 8 | Supply Chain | Demand plan, Shipment, Carrier, Delivery | `logistics.delivery.completed` | Sales, Inventory, Procurement |
| 9 | Manufacturing | BOM, Routing, Work center, Production order | `mfg.order.completed` | Inventory, Quality, Finance |
| 10 | Projects | Project, WBS, Task, Budget, Expense | `projects.cost.recorded` | HR, Finance |
| 11 | Assets & Maintenance | Asset, Depreciation, Work order | `assets.depreciation.posted` | Finance, Procurement |
| 12 | Quality | Plan, Inspection, NCR, CAPA | `quality.ncr.opened` | Mfg, Inventory, Procurement |
| 13 | Documents & Workflow UI | Document, Version, folders (engine itself in `shared/workflows`) | `documents.version.approved` | Workflow |
| 14 | BI & Reporting | Dashboards, KPIs, Report defs, Schedules (read-only over module APIs/read models) | none | all via reporting interfaces |

Boundary contract: each module exposes `modules/<m>/api/` (service interfaces + DTOs + event schemas). No cross-module model imports or ORM joins; enforced by import-linter in CI. Reporting uses read models/views built from events or sanctioned query services, filtered by the same authorization scopes.

---

## 9. Cross-Module Integration Flows

Principle: **same-transaction synchronous service calls** when one business action needs atomic consistency within the monolith (e.g., posting an invoice creates its journal entry); **outbox events** for reactions that may lag, fail independently, or leave the process.

**Procure-to-Pay**
Requisition → [workflow] → RFQ/Quotation → PO → [workflow by amount] → Goods Receipt (Inventory: StockMove + valuation, event `goods_received`) → Supplier Invoice → 3-way match (PO qty/price vs receipt vs invoice, tolerance per tenant) → approval → Finance posts (AP, GRNI clearing) → Payment (SoD, idempotency key) → bank/GL.
Failure recovery: GR and its accrual journal in one transaction; invoice match failure leaves invoice `ON_HOLD` with reasons; payment uses idempotency key and a `PENDING→CONFIRMED` state so retries cannot double-pay.

**Order-to-Cash**
Lead → Opportunity (won) → Quotation → SO (credit check, approval) → Reservation → Delivery (stock issue + COGS entry) → Invoice (AR, tax) → Payment & allocation → GL. Returns create credit notes and return receipts.

**Hire-to-Pay**
Onboarding → Employee/Contract → Attendance/Leave/Timesheets → Payroll run (calculate in draft, rules by jurisdiction config) → approval → lock → Payslips + payment batch + GL accruals; locked run is immutable, corrections via adjustment runs.

**Plan-to-Produce**
Demand/MRP → Production order → Material issue (StockMove) → Execution/WIP → Quality inspection → Finished goods receipt → cost roll-up → Finance entries.

**Project-to-Profitability**
Project/budget → tasks → timesheets (HR cost rate), expenses, PO allocations → cost tracking → revenue (invoices linked to project) → margin → BI.

Every flow: documented states, who owns each transition, an idempotency key on cross-module commands, correlation id propagated through events, compensating actions listed, and a "stuck flow" dashboard fed by outbox/dead-letter state.

---

## 10. Workflow and Approval Architecture

**Decision D7: single engine** in `shared/workflows`; modules register a *workflow subject type* (model, amount field, org context getter, allowed actions, lock rules) and call `WorkflowService.submit(subject)`.

Entities: `WorkflowDefinition(subject_type, version, active, conditions)`, `Stage(order, mode=SEQUENTIAL|PARALLEL, policy=ANY_OF|ALL_OF|QUORUM(n), approver_resolver)`, resolvers: `USER`, `ROLE(+scope)`, `DEPARTMENT_HEAD`, `MANAGER_OF_REQUESTER`, `FIELD_REF`; `Condition` (amount thresholds, currency-normalized); `WorkflowInstance(definition_version snapshot)`, `ApprovalTask`, `ApprovalAction(actor, action, comment, at, ip, e-sign hash)`; `Delegation`, `EscalationRule(after_hours, to)`.

States: `DRAFT → SUBMITTED → IN_REVIEW → APPROVED | REJECTED | CHANGES_REQUESTED → (resubmit) | CANCELLED | ESCALATED(overlay)`.

Guarantees: definition version pinned per instance; subject is locked for edits while in review (changes force resubmission and restart); `SELECT … FOR UPDATE` on the task + unique `(task, actor)` constraint prevents duplicate/concurrent approvals; self-approval and SoD checked at action time; actor must hold both the approver resolution *and* the permission; escalations via Celery beat with idempotent processing; on completion emits `workflow.approval.completed`, and the owning module reacts through a registered callback in the same transaction (state change) plus outbox event (side effects).
Example PO chain (configurable per tenant): Procurement Manager → Finance Manager → Final Approver, with the third stage conditional on amount.

---

## 11. API Architecture

- Base `/api/v1/`; modules under `/api/v1/<module>/…`; platform under `/api/v1/platform/…` (platform host only); auth context `/api/v1/me` (user, tenant, effective permissions, entitled modules).
- Layers: DRF serializer (shape/validation) → thin viewset → **application service** (use case, transaction, authorization call, events) → domain objects/ORM. Serializers never contain business rules.
- Conventions: cursor pagination default, `django-filter`, `?search=`, `?ordering=`, `Idempotency-Key` header required on money/approval/posting commands (stored with request hash + response, 24h+), `ETag/If-Match` or `version` field for optimistic concurrency, workflow actions as explicit command endpoints (`POST /…/{id}/submit|approve|reject`).
- Error envelope: `{ "error": { "code", "message", "details": [{field, code, message}], "correlation_id" } }`; codes stable and documented.
- Rate limiting: per user, per tenant, per IP at Nginx plus DRF throttles; stricter on auth and exports.
- OpenAPI via drf-spectacular, generated in CI, diffed for breaking changes, frontend types generated from it (keeps contracts consistent).
- Security: no tenant id in payloads or headers as authority; response serializers are allow-lists; object lookups always via authorized queryset.

---

## 12. Frontend Routing and State Design

- Single Vite/React/TS app; two route trees: `/platform-admin/*` (served on platform host, separate layout, separate nav, extra MFA-assurance check) and `/app/*` (tenant host).
- `/app/<module>/*` lazy-loaded chunks; route guards use `/me` (entitlements + permissions) to hide menus/actions: usability only.
- State: **RTK Query** for server state (generated from OpenAPI, tag-based invalidation, cache keyed by tenant to prevent bleed on tenant switch: full store reset on logout/tenant change); Redux slices only for UI/session shell state; forms with React Hook Form + Zod (schemas mirror server validation, server is authoritative).
- Shared kit: DataTable (server pagination/filter/sort), FormKit, Dashboard widgets, ApprovalInbox, AuditTimeline, NotificationCenter (WebSocket with auth + tenant-scoped channel), global search, a11y (WCAG 2.1 AA, keyboard nav, ARIA), loading/empty/error patterns.
- Auth: cookie session + CSRF header injected by RTK `fetchBaseQuery`; 401 → redirect to `/auth/login`; no tokens in JS storage.
- Testing: Vitest + Testing Library, Playwright e2e for key flows, axe checks.

---

## 13. Security Threat Model (STRIDE-oriented)

| Threat | Vector | Mitigation | Test |
|---|---|---|---|
| Cross-tenant data access | IDOR, forged `X-Tenant`, URL ids | Host-derived tenant, schema isolation, authorized querysets, headers ignored | API tests with tenant A token on tenant B ids/host |
| search_path leakage | Pooled connection, Celery tasks, exceptions | schema_context finally-restore, task base class, connection reset on request end | task/ORM-level isolation tests, DB-level `current_schema()` assertions |
| Token abuse | Wrong audience/issuer, expired, alg confusion, stolen token | Strict validation, short TTL, BFF cookies, alg allow-list, back-channel logout | negative token tests |
| Privilege escalation | Granting platform perms, delegation beyond ceiling, last-owner removal | Scope column, ceiling check, SoD, audit | escalation test suite |
| Platform admin overreach | Superadmin reading tenant data | No implicit access, break-glass with approval + expiry | access tests |
| Duplicate financial ops | Retries, double click | Idempotency keys, unique constraints, state machine | replay tests |
| Race conditions | Concurrent approvals, stock oversell, period close vs post | Row locks, constraints, optimistic version | concurrency tests |
| Malicious files/imports | Zip bombs, macro docs, CSV injection, path traversal | Size/type sniffing, AV scan (ClamAV), UUID object keys, sandboxed parsers, CSV formula escaping, row limits | upload fuzz tests |
| Unauthorized file access | Guessable URLs | Short-lived signed URLs after authorization check | file auth tests |
| XSS/CSRF/clickjacking | Rich text, cookies | CSP, output encoding, SameSite+CSRF token, frame-ancestors | scanner + tests |
| Provisioning abuse | Tenant name/domain squatting, subdomain takeover | Reserved list, verified domains, DNS validation | provisioning tests |
| Insider tampering | Edit audit/ledger | Append-only triggers, hash chain on audit, restricted DB roles | trigger tests |
| Secrets leakage | Repo/logs | Secret manager/env, scanning in CI, PII log redaction | CI gitleaks |
| DoS | Expensive reports/exports | Rate limits, async exports, query timeouts, quotas per tenant | load tests |

Data protection: encryption in transit (TLS), at rest (disk + field-level encryption for sensitive HR/payroll/bank fields with KMS-managed keys), PII classification, GDPR-style export/erasure workflows (anonymize, retain statutory financial records).

---

## 14. Deployment Architecture

- **Dev:** Docker Compose: nginx, django (ASGI/uvicorn), celery worker + beat, postgres, redis, rabbitmq, keycloak (+ realm import JSON), minio, mailpit, prometheus, grafana, otel-collector.
- **Prod (K8s-ready):** separate deployments for web (ASGI), websocket, celery workers (queues: default, outbox, reports, imports), beat (single replica), migrations as a Job (pre-deploy hook), HPA on CPU/queue depth. Managed PostgreSQL (HA, PITR), Redis HA, RabbitMQ quorum queues, Keycloak clustered with its own DB. Helm chart + environment overlays.
- **Config/secrets:** 12-factor env, secrets from Vault/K8s secrets/external-secrets, never in git.
- **Observability:** JSON logs with `request_id`, `correlation_id`, `tenant`, `user_id`; Prometheus metrics (HTTP, Celery, outbox lag, provisioning failures, per-tenant usage); OpenTelemetry traces; alerts on outbox lag, DLQ depth, migration failures, 5xx, auth failures; `/healthz` and `/readyz` (DB, Redis, broker).
- **Backups/DR:** continuous WAL + daily base backup, per-schema logical dumps for tenant restore, quarterly restore drills, RPO ≤ 5 min, RTO ≤ 1 h targets (to be confirmed), Keycloak DB and realm export included.
- **CI/CD:** lint (ruff, mypy, eslint, tsc), import-linter, unit/integration (with Postgres/Redis/RabbitMQ services), tenant-isolation suite, OpenAPI diff, security scans (bandit, pip-audit, npm audit, trivy, gitleaks), build images, deploy to staging with e2e (Playwright), manual gate to prod, rollback via previous image + expand/contract migrations.

---

## 15. Phased Implementation Plan

| Phase | Scope | Exit criteria (acceptance) |
|---|---|---|
| 0 | This architecture; repo skeleton decisions | Approved doc; versions pinned |
| 1 | Platform foundation: project, tenants, Keycloak BFF login, identity map, platform admin, tenant admin, RBAC core, audit, Docker, CI | Create tenant via API → schema+admin ready; login via Keycloak; cross-tenant isolation tests green; platform admin can't read tenant data without grant |
| 2 | Shared services: org structure, workflow engine, notifications, files, sequences, outbox/events | Generic approval flow works end-to-end on a sample subject; outbox relays with retries/DLQ; sequences concurrency-safe |
| 3 | Finance core | Balanced posting enforced by DB; period close blocks posting; TB/P&L/BS correct on fixtures |
| 4 | Procurement + Inventory | Procure-to-pay with 3-way match through GL; stock = sum of moves; no oversell under concurrency |
| 5 | CRM + Sales | Order-to-cash through AR |
| 6 | HR + Payroll | Payroll run approve/lock/post with configurable rules |
| 7 | Projects + Assets | Project margin; depreciation postings |
| 8 | Supply chain + Manufacturing | MRP → production → costing |
| 9 | Quality + Documents | NCR→CAPA; document revision approval |
| 10 | BI | Permission-aware dashboards, scheduled exports |
| 11 | Hardening | Pen test fixes, load test, DR drill, prod rollout |

Each phase: inspect → plan → vertical slice → migrations → tests run → docs → honest status report (implemented / tested / incomplete).

---

## 16. Acceptance Criteria and Major Risks

**Global acceptance:** every endpoint passes the authorization pipeline test matrix; isolation suite green at API, ORM, Celery and DB levels; financial invariants verified by tests and DB constraints; zero placeholders in production paths; OpenAPI current; runbooks for provisioning failure, migration failure, restore.

| Risk | Impact | Mitigation |
|---|---|---|
| Scope (14 modules) exceeds capacity | Delivery stall | Strict phase gates; thin vertical slices; shared foundations first; module "lite" definitions before depth |
| Schema-per-tenant migration time at scale | Slow deploys | Batched/parallel migrate, expand/contract, tenant canary ring, option to shard DBs |
| Cross-schema identity design (public User vs tenant profile) | Orphans/inconsistency | UUID references, reconciliation job and tests; single `platform_api` for access |
| Keycloak as single point of failure/compromise | Platform-wide outage | HA cluster, short token TTL with cached JWKS, app-side authz, break-glass local admin runbook |
| Workflow generality vs module specifics | Over-abstraction | Subject-type registration contract; start with PO + invoice + leave as proving cases |
| Payroll/tax by jurisdiction | Incorrect statutory results | Rule engine as data with versioning, jurisdiction packs, domain expert review, not hardcoded |
| Outbox/event complexity | Lost or duplicate events | Idempotent consumers, event versioning, DLQ dashboard, use sync calls inside the monolith |
| Reporting performance and permissioning | Slow or leaking reports | Read models, authorization-filtered query services, async exports, per-tenant quotas |
| Inventory valuation / accounting correctness | Financial misstatement | Immutable moves, DB constraints, golden-dataset tests, reviewed by finance SME |
| Frontend/back contract drift | Bugs | Generated OpenAPI types, contract tests in CI |

---

## Version Baseline (to be pinned and verified at Phase 1 kickoff)
Python 3.12, Django 5.2 LTS, DRF 3.16, django-tenants (latest compatible with chosen Django: **to verify**), PostgreSQL 16/17, Redis 7, RabbitMQ 3.13/4.x, Celery 5.4+, Keycloak 26.x, Node 22 LTS, React 18/19, Vite 6/7, Tailwind 3/4, RTK 2.x. I have not checked current releases or django-tenants/Django compatibility yet; I will confirm at Phase 1 start rather than assert them here.

## Open Questions for You (affect Phase 1)
1. Target jurisdiction(s) first (payroll/tax/COA templates)? 
2. Expected tenant count and data volume in year 1 (decides single DB vs sharding plans)?
3. Subdomain-per-tenant (`acme.erp.com`) vs custom domains from day one?
4. Hosting target (cloud provider / on-prem K8s)?
5. Is any existing code from your other platforms (IAM, gateway, QMS) to be reused or migrated, or is this fully separate?
6. Email/SMS provider for invites and notifications?
