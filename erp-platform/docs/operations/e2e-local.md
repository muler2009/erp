# Real-browser end-to-end pass (local, no Docker)

This repeats the pass run on 2026-11-15: a real Keycloak, the real Django backend with a provisioned tenant, the Vite
frontend, and a headless Chromium signing in through the browser (authorization code with PKCE).

## Set-up
1. Download Keycloak 26 (the GitHub release tarball), copy `infrastructure/keycloak/erp-realm.json` to `data/import/`,
   then `KC_BOOTSTRAP_ADMIN_USERNAME=admin KC_BOOTSTRAP_ADMIN_PASSWORD=admin bin/kc.sh start-dev --import-realm`.
2. Read the `erp-bff` and `erp-identity-admin` client secrets and the client UUIDs (`kcadm.sh get clients -r erp`) and
   fill them into a copy of `infrastructure/e2e/e2e.env.example`. Never commit the filled copy.
3. Backend: create an empty database, `source` the env file, `manage.py migrate_schemas --shared`,
   `manage.py bootstrap_platform --admin-email you@example.com`, then provision a tenant (`request_tenant` and
   `run_provisioning` from a `manage.py shell`), and `manage.py runserver 0.0.0.0:8000`.
4. In Keycloak give the tenant admin a password (a real deployment uses the set-up email) and add the dev redirect URIs
   with the Vite port (`http://<slug>.erp.localhost:5173/signin-callback`, plus web origin and post-logout URI).
5. Frontend: `ERP_BACKEND_URL=http://localhost:8000 npx vite --port 5173`.
6. Run the smoke walk: `E2E_USER=... E2E_PASSWORD=... python3 infrastructure/e2e/smoke.py 0 16` (use batches of about
   16 routes; one long session crashed Chromium). It signs in once and loads every route, reporting page errors and
   failed API calls.

`*.localhost` resolves to the loopback address in Chromium, so no hosts-file edits are needed.
