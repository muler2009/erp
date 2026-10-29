"""Tenant provisioning saga: idempotent, retryable, observable.

Each step records its own status/attempts/error in ProvisioningStep. A retry resumes at the first step
that has not SUCCEEDED; every step is safe to run again. A tenant is set ACTIVE only by the `activate`
step after all earlier required steps (including a health check) have succeeded.
"""
import logging
import re
from datetime import timedelta

from django.apps import apps
from django.conf import settings
from django.core.mail import send_mail
from django.core.management import call_command
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from django_tenants.utils import schema_context, schema_exists

from platform_core.audit.services import record_platform_event, record_tenant_event
from platform_core.authorization import services as authz
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.catalog import DEFAULT_PLAN_CODE, DEFAULT_TENANT_ROLES, MODULES, OWNER_ROLE
from platform_core.identity.crypto import hash_invite_token, new_invite_token
from platform_core.identity.provisioner import get_provisioner
from platform_core.tenants.models import RESERVED_SLUGS, SLUG_RE, Domain, ModuleEntitlement, Plan, ProvisioningJob, ProvisioningStep, Tenant
from platform_core.users.models import ExternalIdentity, TenantMembership, User
from shared.api.errors import DomainError, ValidationFailed

logger = logging.getLogger(__name__)

# (name, required). A failed required step stops the saga and marks the tenant PROVISIONING_FAILED.
STEPS = [
    ("create_schema", True),
    ("seed_defaults", True),
    ("entitlements", True),
    ("identity_client", True),
    ("admin_identity", True),
    ("admin_role", True),
    ("health_check", True),
    ("activate", True),
    ("notify_admin", False),
]

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ProvisioningError(Exception):
    pass


def schema_name_for(slug):
    return "t_" + slug.replace("-", "_")


def tenant_host(tenant):
    return f"{tenant.slug}.{settings.BASE_DOMAIN}"


# --------------------------------------------------------------------------- request
def request_tenant(*, name, slug, plan_code, admin_email, admin_display_name, requested_by_user_id, idempotency_key, request=None):
    """Validate and register a tenant (status PENDING) and its provisioning job. Idempotent per key."""
    if not idempotency_key:
        raise ValidationFailed("Idempotency-Key header is required.", code="idempotency_key_required")
    slug = (slug or "").strip().lower()  # normalize before any comparison or lookup
    existing = ProvisioningJob.objects.filter(idempotency_key=idempotency_key).select_related("tenant").first()
    if existing:
        if existing.tenant.slug != slug:
            raise DomainError("Idempotency key was already used for a different request.", code="idempotency_key_reused")
        return existing, False

    if not SLUG_RE.match(slug) or "--" in slug:
        raise ValidationFailed("Invalid slug: 3-40 chars, lowercase letters, digits and hyphens, starting with a letter.", code="invalid_slug")
    if slug in RESERVED_SLUGS:
        raise ValidationFailed("This slug is reserved.", code="reserved_slug")
    if not name.strip():
        raise ValidationFailed("Name is required.", code="invalid_name")
    if not _EMAIL_RE.match(admin_email or ""):
        raise ValidationFailed("A valid admin email is required.", code="invalid_email")
    plan = Plan.objects.filter(code=plan_code, is_active=True).first()
    if plan is None:
        raise ValidationFailed("Unknown or inactive plan.", code="unknown_plan")
    if Tenant.objects.filter(slug=slug).exists():
        raise DomainError("A tenant with this slug already exists.", code="slug_taken")

    with transaction.atomic():
        tenant = Tenant.objects.create(name=name.strip(), slug=slug, schema_name=schema_name_for(slug), plan=plan, status=Tenant.Status.PENDING)
        Domain.objects.create(domain=tenant_host(tenant), tenant=tenant, is_primary=True)
        job = ProvisioningJob.objects.create(
            tenant=tenant,
            idempotency_key=idempotency_key,
            requested_by_user_id=requested_by_user_id,
            admin_email=admin_email.strip().lower(),
            admin_display_name=admin_display_name.strip(),
        )
        ProvisioningStep.objects.bulk_create([ProvisioningStep(job=job, name=n, required=r) for n, r in STEPS])
        record_platform_event("tenant.requested", actor_user_id=requested_by_user_id, tenant_id=tenant.id, target_type="tenant", target_id=tenant.id, metadata={"slug": slug, "plan": plan.code}, request=request)
    return job, True


# --------------------------------------------------------------------------- runner
def _advisory_key(job):
    return job.id.int % (2**63 - 1)


def _try_lock(job):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [_advisory_key(job)])
        return cursor.fetchone()[0]


def _unlock(job):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_unlock(%s)", [_advisory_key(job)])


def run_provisioning(job_id):
    """Run (or resume) a provisioning job. Safe to call concurrently: only one runner proceeds."""
    job = ProvisioningJob.objects.select_related("tenant", "tenant__plan").filter(id=job_id).first()
    if job is None:
        logger.error("provisioning job not found", extra={"extra_fields": {"job_id": str(job_id)}})
        return None
    connection.set_schema_to_public()
    if not _try_lock(job):
        logger.info("provisioning job already running elsewhere", extra={"extra_fields": {"job_id": str(job.id)}})
        return job
    try:
        return _run_locked(job)
    finally:
        connection.set_schema_to_public()
        _unlock(job)


def _run_locked(job):
    tenant = job.tenant
    if tenant.status in (Tenant.Status.ACTIVE, Tenant.Status.SUSPENDED) and job.status in (
        ProvisioningJob.Status.SUCCEEDED, ProvisioningJob.Status.SUCCEEDED_WITH_WARNINGS
    ):
        return job
    if tenant.status not in (Tenant.Status.PENDING, Tenant.Status.PROVISIONING, Tenant.Status.PROVISIONING_FAILED):
        raise DomainError("Tenant is not in a provisionable state.", code="invalid_state")

    Tenant.objects.filter(pk=tenant.pk).update(status=Tenant.Status.PROVISIONING)
    tenant.refresh_from_db()
    job.status = ProvisioningJob.Status.RUNNING
    job.attempts += 1
    job.last_error = ""
    job.finished_at = None
    job.save(update_fields=["status", "attempts", "last_error", "finished_at"])

    warnings = False
    ordered = {s.name: s for s in job.steps.all()}
    for name, required in STEPS:
        step = ordered[name]
        if step.status == ProvisioningStep.Status.SUCCEEDED:
            continue
        step.attempts += 1
        step.started_at = timezone.now()
        step.error = ""
        step.save(update_fields=["attempts", "started_at", "error"])
        try:
            with transaction.atomic():
                STEP_FUNCS[name](job, tenant)
        except Exception as exc:  # noqa: BLE001 - recorded, logged and surfaced; never swallowed
            connection.set_schema_to_public()
            logger.exception("provisioning step failed", extra={"extra_fields": {"step": name, "tenant": tenant.slug, "job_id": str(job.id)}})
            step.status = ProvisioningStep.Status.FAILED
            step.error = f"{type(exc).__name__}: {exc}"[:2000]
            step.finished_at = timezone.now()
            step.save(update_fields=["status", "error", "finished_at"])
            record_platform_event("tenant.provisioning.step_failed", tenant_id=tenant.id, target_type="tenant", target_id=tenant.id, metadata={"step": name, "error": step.error})
            if required:
                Tenant.objects.filter(pk=tenant.pk).update(status=Tenant.Status.PROVISIONING_FAILED)
                job.status = ProvisioningJob.Status.FAILED
                job.last_error = f"{name}: {step.error}"
                job.finished_at = timezone.now()
                job.save(update_fields=["status", "last_error", "finished_at"])
                return job
            warnings = True
            continue
        step.status = ProvisioningStep.Status.SUCCEEDED
        step.finished_at = timezone.now()
        step.save(update_fields=["status", "finished_at"])

    job.status = ProvisioningJob.Status.SUCCEEDED_WITH_WARNINGS if warnings else ProvisioningJob.Status.SUCCEEDED
    job.finished_at = timezone.now()
    job.save(update_fields=["status", "finished_at"])
    return job


# --------------------------------------------------------------------------- steps
def step_create_schema(job, tenant):
    tenant.create_schema(check_if_exists=True, verbosity=0)
    # create_schema() returns early when the schema already exists (e.g. a previous attempt died during
    # migrations), so always run the (idempotent) tenant migration explicitly.
    call_command("migrate_schemas", tenant=True, schema_name=tenant.schema_name, interactive=False, verbosity=0)
    connection.set_schema_to_public()


def step_seed_defaults(job, tenant):
    from platform_core.organizations import services as org
    from shared.sequences import services as sequences

    with schema_context(tenant.schema_name):
        authz.seed_roles()
        org.seed_defaults(tenant)
        sequences.seed_default_sequences()
        from modules.finance import services as finance

        finance.seed_defaults()
        from modules.crm import services as crm

        crm.seed_defaults()
        from modules.hr import services as hr

        hr.seed_defaults()
        from modules.hr import attendance as hr_attendance

        hr_attendance.seed_defaults()


def apply_plan_entitlements(tenant, *, enable_new=True):
    entitled = set(tenant.plan.modules) if tenant.plan else set()
    for module in MODULES:
        row, created = ModuleEntitlement.objects.get_or_create(
            tenant=tenant, module=module, defaults={"entitled": module in entitled, "enabled": enable_new and module in entitled}
        )
        if not created:
            row.entitled = module in entitled
            if not row.entitled:
                row.enabled = False
            row.save(update_fields=["entitled", "enabled"])


def step_entitlements(job, tenant):
    apply_plan_entitlements(tenant)


def step_identity_client(job, tenant):
    host = tenant_host(tenant)
    get_provisioner().register_redirect_uris(f"{settings.PUBLIC_SCHEME}://{host}/auth/callback", f"{settings.PUBLIC_SCHEME}://{host}/")


def step_admin_identity(job, tenant):
    provisioner = get_provisioner()
    result = provisioner.ensure_user(job.admin_email, job.admin_display_name)
    issuer = settings.OIDC["ISSUER"]
    identity = ExternalIdentity.objects.select_related("user").filter(issuer=issuer, subject=result.subject).first()
    if identity:
        user = identity.user
    else:
        # An invited address may already be a known User (e.g. a consultant in several tenants).
        user = User.objects.filter(email__iexact=job.admin_email).order_by("created_at").first() or User.objects.create_user(
            job.admin_email, job.admin_display_name
        )
        # Link only when we just created the Keycloak account ourselves; otherwise the person must
        # prove control with the invite token (no linking by email match).
        if result.created and not ExternalIdentity.objects.filter(user=user, issuer=issuer).exists():
            ExternalIdentity.objects.create(user=user, issuer=issuer, subject=result.subject)
    linked = ExternalIdentity.objects.filter(user=user, issuer=issuer).exists()
    membership, _ = TenantMembership.objects.get_or_create(
        user=user, tenant=tenant, defaults={"status": TenantMembership.Status.ACTIVE if linked else TenantMembership.Status.INVITED}
    )
    if membership.status == TenantMembership.Status.INVITED and linked:
        membership.status = TenantMembership.Status.ACTIVE
        membership.save(update_fields=["status"])
    if result.created:
        provisioner.send_required_actions_email(result.subject)


def step_admin_role(job, tenant):
    membership = TenantMembership.objects.get(tenant=tenant, user__email__iexact=job.admin_email)
    with schema_context(tenant.schema_name):
        owner = RoleDefinition.objects.get(name=OWNER_ROLE)
        if not RoleAssignment.objects.filter(user_id=membership.user_id, role=owner, revoked_at__isnull=True).exists():
            RoleAssignment.objects.create(user_id=membership.user_id, role=owner, granted_by=job.requested_by_user_id)


def _unapplied_tenant_migrations():
    tenant_labels = {cfg.label for cfg in apps.get_app_configs() if cfg.name in settings.TENANT_APPS}
    executor = MigrationExecutor(connection)
    plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
    return [f"{m.app_label}.{m.name}" for m, _ in plan if m.app_label in tenant_labels]


def step_health_check(job, tenant):
    if not schema_exists(tenant.schema_name):
        raise ProvisioningError("schema missing")
    with schema_context(tenant.schema_name):
        pending = _unapplied_tenant_migrations()
        if pending:
            raise ProvisioningError(f"unapplied tenant migrations: {pending}")
        if RoleDefinition.objects.filter(is_system=True).count() != len(DEFAULT_TENANT_ROLES):
            raise ProvisioningError("system roles not fully seeded")
        owners = authz.active_owner_ids()
    membership = TenantMembership.objects.filter(tenant=tenant, user__email__iexact=job.admin_email).first()
    if membership is None or membership.user_id not in owners:
        raise ProvisioningError("initial tenant owner is not resolvable")
    if ModuleEntitlement.objects.filter(tenant=tenant).count() != len(MODULES):
        raise ProvisioningError("module entitlements incomplete")
    if not Domain.objects.filter(tenant=tenant, is_primary=True).exists():
        raise ProvisioningError("primary domain missing")


def step_activate(job, tenant):
    Tenant.objects.filter(pk=tenant.pk).update(status=Tenant.Status.ACTIVE)
    tenant.status = Tenant.Status.ACTIVE
    record_platform_event("tenant.provisioned", actor_user_id=job.requested_by_user_id, tenant_id=tenant.id, target_type="tenant", target_id=tenant.id, metadata={"job_id": str(job.id), "attempts": job.attempts})
    record_tenant_event(tenant, "tenant.provisioned", actor_user_id=job.requested_by_user_id, target_type="tenant", target_id=tenant.id)
    from shared.events import services as events

    with schema_context(tenant.schema_name):
        events.emit("tenant.provisioned", {"tenant_id": str(tenant.id), "slug": tenant.slug}, dedup_key=f"tenant-provisioned-{tenant.id}")


def step_notify_admin(job, tenant):
    membership = TenantMembership.objects.select_related("user").get(tenant=tenant, user__email__iexact=job.admin_email)
    base = f"{settings.PUBLIC_SCHEME}://{tenant_host(tenant)}/auth/login"
    link = base
    if membership.status == TenantMembership.Status.INVITED:
        token = new_invite_token()  # rotated on every (re)send; only the hash is stored
        membership.invite_token_hash = hash_invite_token(token)
        membership.invite_expires_at = timezone.now() + timedelta(hours=settings.INVITE_TTL_HOURS)
        membership.save(update_fields=["invite_token_hash", "invite_expires_at"])
        link = f"{base}?invite={token}"
    send_mail(
        subject=f"Your {tenant.name} ERP workspace is ready",
        message=f"Hello {membership.user.display_name or ''},\n\nYour workspace is ready. Sign in here:\n{link}\n",
        from_email=None,
        recipient_list=[membership.user.email],
        fail_silently=False,
    )
    record_platform_event("tenant.admin_notified", tenant_id=tenant.id, target_type="tenant", target_id=tenant.id)


STEP_FUNCS = {
    "create_schema": step_create_schema,
    "seed_defaults": step_seed_defaults,
    "entitlements": step_entitlements,
    "identity_client": step_identity_client,
    "admin_identity": step_admin_identity,
    "admin_role": step_admin_role,
    "health_check": step_health_check,
    "activate": step_activate,
    "notify_admin": step_notify_admin,
}
