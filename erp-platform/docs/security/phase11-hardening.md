# Phase 11 security hardening
## Added
- **Headers**: nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP same-origin, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and `Cache-Control: no-store` on API/auth responses. **Finding fixed:** `X_FRAME_OPTIONS` had been set but the middleware that applies it was missing, so clickjacking protection was not active until now.
- **Transport**: HSTS, SSL redirect and secure cookies when `ERP_BEHIND_PROXY=true` and not DEBUG.
- **Probes and scrapes on any Host**: kubelet and Prometheus call the pod IP, which tenant routing rejects (404). `/healthz`, `/readyz`, `/metrics` are answered before tenant routing; they carry no tenant data and `/metrics` needs a bearer token (constant-time compare, 404 when unset). Nothing else answers on an unknown host (tested).
- **Metrics hygiene**: route templates as labels (ids never become label values); security events counted.
- **Edge**: nginx hides version, limits body size, rate-limits `/auth` and `/api`, overwrites forwarded headers, refuses `/metrics`; ingress and NetworkPolicies equivalent.
- **Static checks in CI**: correctness lint (found a latent undefined variable in procurement overdue lines, fixed), pip-audit, bandit (medium+), gitleaks, Trivy.

## Automated tests (tests/test_hardening.py)
1. Every tenant route (~hundreds) x GET/POST/PATCH/DELETE as an anonymous caller: only 401/403/404/405 (the OIDC flow and probes are the declared public set).
2. Every platform-host route, same check.
3. An active member holding **no role** calls every route: no 5xx, and the only 2xx/400/409 answers are an explicit allow-list of self-service endpoints (own profile, notifications, files, approval inbox/tasks), each scoped to the caller in its view.
4. Cookies of one tenant are useless on another tenant's host; unknown hosts 404; forged tenant headers ignored.
5. Metrics authentication, no id label cardinality, probes by pod IP, readiness fails when the database is down, correlation-id handling, headers.
A new endpoint added without authorization fails (1)-(3) even if its author wrote no test.

## Not done / residual risk
- No external penetration test, no fuzzing of file-upload parsers beyond existing content-sniffing tests, no dependency pinning with hashes.
- DRF throttling uses the default cache (per process unless Redis is configured as cache): effective limits multiply by replica count; nginx/ingress limits are the real edge control.
- Secrets management is by convention (env/secret manager); no automatic rotation.
- OpenAPI bodies undocumented (see docs/api/README.md).
