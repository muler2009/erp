# Deployment
## Local (Docker Compose)
    cp .env.example .env            # set secrets; ERP_METRICS_TOKEN=$(openssl rand -hex 32)
    docker compose up --build       # postgres, redis, rabbitmq, keycloak, backend, worker, beat, nginx
    docker compose exec backend python manage.py migrate_schemas --shared
    docker compose exec backend python manage.py bootstrap_platform --admin-email you@example.com
    # optional metrics stack
    printf %s "$ERP_METRICS_TOKEN" > .metrics_token
    docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d     # Prometheus :9090, Grafana :3000 (localhost only)
Run exactly one `beat`. The compose file is a development stack; production uses the Kubernetes manifests.

## Kubernetes
`infrastructure/kubernetes/base.yaml` is a reference set: namespace, config, backend (3 replicas, rolling, probes, PDB, HPA 3-12),
worker, beat (1 replica, Recreate), migration Job, ingress, NetworkPolicies, files PVC and the nightly backup CronJob.
Pods run as non-root, read-only root filesystem, all capabilities dropped. Before use:
1. Replace image names, hostnames and storage classes. Provide `erp-secrets` (DJANGO_SECRET_KEY, ERP_TOKEN_ENCRYPTION_KEY, DB_NAME/USER/PASSWORD, OIDC_CLIENT_SECRET, KEYCLOAK_ADMIN_CLIENT_SECRET, ERP_METRICS_TOKEN, EVENT_BROKER_URL) from your secret manager. **Secrets are never in git.**
2. The files PVC needs ReadWriteMany (or switch file storage to object storage: not implemented).
3. Build the backup image (postgres-client plus `infrastructure/backup`): not included.
4. The manifests were validated as YAML only; they have not been applied to a cluster.

## Release procedure (CI/CD)
`ci.yml`: lint (correctness rules), tests with PostgreSQL, `makemigrations --check`, pip-audit, bandit, gitleaks, image build with Trivy (CRITICAL/HIGH fail the build), push on main.
`deploy.yml` (manual, per environment, production behind reviewer approval): backup -> migration Job -> rollout -> automatic `rollout undo` on failure.
Migrations: additive first (add column/table), deploy code, remove later (two releases), because old and new pods overlap during a rolling update. Migrations are forward-only; the rollback for data is a restore.

## Configuration that matters in production
`DJANGO_DEBUG=false`, `ERP_BEHIND_PROXY=true` (enables HSTS one year incl. subdomains, SSL redirect, secure cookies; probes are exempt), `DJANGO_ALLOWED_HOSTS`, `ERP_BASE_DOMAIN`, `PROMETHEUS_MULTIPROC_DIR` (several gunicorn workers), `ERP_THROTTLE_USER/ANON`. HSTS preload is deliberately not enabled (irreversible); enable it only after deciding to.
`manage.py check --deploy` reports only that preload warning.
