# Threats covered by automated tests (Phase 1)
Cross-tenant IDOR; forged tenant headers; session/cookie replay across tenants; bearer token for wrong tenant; wrong audience,
issuer, expired, foreign-key, HS256 alg-confusion and unknown-kid tokens; state/nonce replay; open redirect; email-match
account takeover; expired/reused invite tokens; CSRF on session writes; privilege escalation via delegation, self-grant, platform
permissions in tenants, last-owner removal; platform-admin overreach (MFA, four-eyes, break-glass, expiry); audit tampering;
search_path leakage after request/task/exception; concurrent provisioning runners.
Not yet covered: duplicate financial operations, concurrent approvals, malicious file imports, unauthorized file access (modules not built).

## Update (Phase 11)
Added: whole-surface authorization sweeps, security headers, metrics endpoint authentication, probe host handling. Remaining from the list above
are now covered by module tests: duplicate financial operations and concurrent approvals (finance, workflow tests), file access checks and
content sniffing (files tests), formula-injection in exports (analytics tests). See `phase11-hardening.md`.
