# ERP Platform (Phase 1–2: platform foundation)

Multi-tenant ERP foundation: django-tenants (schema per tenant), Keycloak OIDC via a BFF, Django-authoritative RBAC,
tenant provisioning saga, platform superadmin + tenant admin, audit trails. See `docs/architecture/phase0-architecture.md`
for the design and `docs/operations/phase1-status.md` for what is implemented, tested and still open.

## Local setup (without Docker)
    python3 -m venv .venv && . .venv/bin/activate
    pip install -r backend/requirements.txt -r backend/requirements-dev.txt
    # PostgreSQL 16 running locally; then:
    export DJANGO_SETTINGS_MODULE=config.settings_test DB_NAME=erp_dev DB_USER=postgres DB_HOST=localhost DB_PORT=5432
    cd backend && python -m pytest

## Running the stack
    cp .env.example .env   # fill in secrets
    docker compose up --build
    docker compose exec backend python manage.py migrate_schemas --shared
    docker compose exec backend python manage.py bootstrap_platform --admin-email you@example.com
The bootstrap command prints a one-time sign-in link for the first platform administrator.
Tenant hosts are `<slug>.<ERP_BASE_DOMAIN>`; the platform console is `ERP_PLATFORM_HOST`.

## Keycloak requirements
- Realm `erp`; clients `erp-bff` (confidential, code flow + PKCE S256), `erp-identity-admin` (service account limited to
  user + client management). `infrastructure/keycloak/erp-realm.json` is a starting import (secrets must be set).
- Platform administration requires an `amr` claim containing `otp`/`mfa`/`hwk`. Keycloak does not emit `amr` by default:
  add a mapper (or an authentication-method-reference configuration) and require MFA for platform admins. Without it,
  platform logins are refused (fail closed).
- The BFF client needs an audience mapper so `erp-api` appears in access tokens used on the Bearer path.

## Tests
`cd backend && python -m pytest` (85 tests, needs PostgreSQL). `python manage.py makemigrations --check` must be clean.
