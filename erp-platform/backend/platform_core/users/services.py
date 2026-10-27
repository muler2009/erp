"""Application services for user/membership administration, platform administrators and break-glass access."""
import re
from datetime import timedelta

from django.conf import settings
from django.core.mail import send_mail
from django.db import transaction
from django.utils import timezone
from django_tenants.utils import schema_context

from platform_core.audit.services import record_platform_event, record_tenant_event
from platform_core.authorization import services as authz
from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.catalog import OWNER_ROLE, PLATFORM_PERMISSION_CODES
from platform_core.identity.crypto import hash_invite_token, new_invite_token
from platform_core.tenants.models import Tenant
from platform_core.users.models import PlatformAdmin, PlatformRole, TenantAccessGrant, TenantMembership, User
from shared.api.errors import DomainError, ValidationFailed

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _login_link(host, token):
    return f"{settings.PUBLIC_SCHEME}://{host}/auth/login?invite={token}"


def _primary_host(tenant):
    domain = tenant.domains.filter(is_primary=True).first()
    return domain.domain if domain else f"{tenant.slug}.{settings.BASE_DOMAIN}"


# ----------------------------------------------------------------------------- tenant users
@transaction.atomic
def invite_user(tenant, actor_user_id, *, email, display_name, role_ids, request=None):
    """Invite (or re-invite) a user into `tenant`. Runs on the tenant host (current schema = tenant)."""
    if not _EMAIL_RE.match(email or ""):
        raise ValidationFailed("A valid email is required.", code="invalid_email")
    email = email.strip().lower()
    roles = list(RoleDefinition.objects.filter(id__in=role_ids))
    if len(roles) != len(set(role_ids)):
        raise ValidationFailed("Unknown role id.", code="unknown_role")
    for role in roles:  # delegation ceiling is enforced before anything is created
        authz.assert_delegation_ceiling(actor_user_id, role)

    user = User.objects.filter(email__iexact=email).order_by("created_at").first() or User.objects.create_user(email, display_name.strip())
    membership, created = TenantMembership.objects.get_or_create(user=user, tenant=tenant)
    if membership.status == TenantMembership.Status.ACTIVE:
        raise DomainError("This user is already an active member.", code="already_member")
    if membership.status == TenantMembership.Status.DEACTIVATED:
        raise DomainError("This membership is deactivated; reactivate it instead.", code="membership_deactivated")

    token = new_invite_token()
    membership.status = TenantMembership.Status.INVITED
    membership.invite_token_hash = hash_invite_token(token)
    membership.invite_expires_at = timezone.now() + timedelta(hours=settings.INVITE_TTL_HOURS)
    membership.save(update_fields=["status", "invite_token_hash", "invite_expires_at"])
    for role in roles:
        authz.assign_role(actor_user_id, user.id, role)
    if created:
        from shared.events import services as events

        events.emit("tenant.user.created", {"user_id": str(user.id), "email": email}, dedup_key=f"user-created-{tenant.id}-{user.id}")
    record_tenant_event(tenant, "user.invited", actor_user_id=actor_user_id, target_type="membership", target_id=membership.id, metadata={"email": email, "roles": [r.name for r in roles]}, request=request)
    transaction.on_commit(
        lambda: send_mail(
            subject=f"You have been invited to {tenant.name}",
            message=f"Sign in to accept your invitation:\n{_login_link(_primary_host(tenant), token)}\n",
            from_email=None,
            recipient_list=[email],
        )
    )
    return membership


@transaction.atomic
def set_membership_status(tenant, actor_user_id, membership, *, active, request=None):
    if membership.tenant_id != tenant.id:
        raise DomainError("Membership not found.", code="not_found", status_code=404)
    if active:
        if membership.status != TenantMembership.Status.DEACTIVATED:
            raise DomainError("Only deactivated memberships can be reactivated.", code="invalid_state_transition")
        membership.status = TenantMembership.Status.ACTIVE
    else:
        if membership.status == TenantMembership.Status.DEACTIVATED:
            return membership
        if membership.user_id == actor_user_id:
            raise DomainError("You cannot deactivate yourself.", code="self_deactivation_forbidden")
        owner_assignments = RoleAssignment.objects.filter(user_id=membership.user_id, role__name=OWNER_ROLE, revoked_at__isnull=True)
        if owner_assignments.exists() and not (authz.active_owner_ids() - {membership.user_id}):
            raise DomainError("The last Tenant Owner cannot be deactivated.", code="last_owner_protected")
        membership.status = TenantMembership.Status.DEACTIVATED
        membership.invite_token_hash = ""
    membership.save(update_fields=["status", "invite_token_hash"] if not active else ["status"])
    record_tenant_event(tenant, "membership.activated" if active else "membership.deactivated", actor_user_id=actor_user_id, target_type="membership", target_id=membership.id, request=request)
    if not active:
        _revoke_user_sessions_for_tenant(membership.user_id, tenant)
    return membership


def _revoke_user_sessions_for_tenant(user_id, tenant):
    from django.contrib.sessions.models import Session

    for session in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        data = session.get_decoded()
        if str(data.get("_auth_user_id")) == str(user_id) and (data.get("auth_ctx") or {}).get("tenant_id") == str(tenant.id):
            session.delete()


# ----------------------------------------------------------------------------- platform admins
def ensure_superadmin_role():
    role, _ = PlatformRole.objects.get_or_create(name="platform_superadmin", defaults={"permissions": list(PLATFORM_PERMISSION_CODES)})
    # The role is an explicit list (no wildcard); keep it in sync with the catalog.
    if sorted(role.permissions) != sorted(PLATFORM_PERMISSION_CODES):
        role.permissions = list(PLATFORM_PERMISSION_CODES)
        role.save(update_fields=["permissions"])
    return role


@transaction.atomic
def propose_platform_admin(proposer, *, email, display_name, role_names, request=None):
    if not _EMAIL_RE.match(email or ""):
        raise ValidationFailed("A valid email is required.", code="invalid_email")
    roles = list(PlatformRole.objects.filter(name__in=role_names))
    if not roles or len(roles) != len(set(role_names)):
        raise ValidationFailed("Unknown platform role.", code="unknown_role")
    email = email.strip().lower()
    user = User.objects.filter(email__iexact=email).order_by("created_at").first() or User.objects.create_user(email, display_name.strip())
    if PlatformAdmin.objects.filter(user=user).exists():
        raise DomainError("This user is already a platform administrator or has a pending proposal.", code="already_exists")
    admin = PlatformAdmin.objects.create(user=user, proposed_by=proposer, status=PlatformAdmin.Status.PENDING_APPROVAL)
    admin.roles.set(roles)
    record_platform_event("platform_admin.proposed", actor_user_id=proposer.user_id, target_type="platform_admin", target_id=admin.id, metadata={"email": email, "roles": role_names}, request=request)
    return admin


@transaction.atomic
def approve_platform_admin(approver, admin, *, request=None):
    admin = PlatformAdmin.objects.select_for_update().get(pk=admin.pk)
    if admin.status != PlatformAdmin.Status.PENDING_APPROVAL:
        raise DomainError("Proposal is not pending approval.", code="invalid_state_transition")
    if admin.proposed_by_id == approver.id or admin.user_id == approver.user_id:
        raise DomainError("A platform administrator cannot approve their own proposal.", code="four_eyes_required", status_code=403)
    token = new_invite_token()
    admin.status = PlatformAdmin.Status.INVITED
    admin.approved_by = approver
    admin.invite_token_hash = hash_invite_token(token)
    admin.invite_expires_at = timezone.now() + timedelta(hours=settings.INVITE_TTL_HOURS)
    admin.save(update_fields=["status", "approved_by", "invite_token_hash", "invite_expires_at"])
    record_platform_event("platform_admin.approved", actor_user_id=approver.user_id, target_type="platform_admin", target_id=admin.id, request=request)
    email = admin.user.email
    transaction.on_commit(
        lambda: send_mail(
            subject="You have been invited as an ERP platform administrator",
            message=f"Sign in to the platform console to accept:\n{_login_link(settings.PLATFORM_HOST, token)}\n",
            from_email=None,
            recipient_list=[email],
        )
    )
    return admin


# ----------------------------------------------------------------------------- break-glass access
@transaction.atomic
def request_access(admin, tenant, *, reason, ticket_ref, minutes, request=None):
    if tenant.is_platform:
        raise ValidationFailed("Not a customer tenant.", code="invalid_tenant")
    if len((reason or "").strip()) < 20:
        raise ValidationFailed("A justification of at least 20 characters is required.", code="reason_too_short")
    if not (ticket_ref or "").strip():
        raise ValidationFailed("A ticket reference is required.", code="ticket_required")
    if not (1 <= int(minutes) <= settings.BREAK_GLASS_MAX_MINUTES):
        raise ValidationFailed(f"Duration must be 1-{settings.BREAK_GLASS_MAX_MINUTES} minutes.", code="invalid_duration")
    grant = TenantAccessGrant.objects.create(requested_by=admin, tenant=tenant, reason=reason.strip(), ticket_ref=ticket_ref.strip(), requested_minutes=int(minutes))
    record_platform_event("access.requested", actor_user_id=admin.user_id, tenant_id=tenant.id, target_type="access_grant", target_id=grant.id, metadata={"ticket": ticket_ref, "minutes": int(minutes)}, request=request)
    return grant


@transaction.atomic
def decide_access(approver, grant, *, approve, request=None):
    grant = TenantAccessGrant.objects.select_for_update().select_related("tenant").get(pk=grant.pk)
    if grant.status != TenantAccessGrant.Status.REQUESTED:
        raise DomainError("Request was already decided.", code="invalid_state_transition")
    if grant.requested_by_id == approver.id:
        raise DomainError("You cannot approve your own access request.", code="four_eyes_required", status_code=403)
    now = timezone.now()
    grant.approved_by = approver
    grant.approved_at = now
    if approve:
        grant.status = TenantAccessGrant.Status.APPROVED
        grant.expires_at = now + timedelta(minutes=min(grant.requested_minutes, settings.BREAK_GLASS_MAX_MINUTES))
    else:
        grant.status = TenantAccessGrant.Status.DENIED
    grant.save(update_fields=["status", "approved_by", "approved_at", "expires_at"])
    action = "access.approved" if approve else "access.denied"
    record_platform_event(action, actor_user_id=approver.user_id, tenant_id=grant.tenant_id, target_type="access_grant", target_id=grant.id, request=request)
    if approve:  # the tenant must be able to see that the platform was granted access
        record_tenant_event(grant.tenant, "platform_access.granted", actor_user_id=approver.user_id, target_type="access_grant", target_id=grant.id, metadata={"ticket": grant.ticket_ref, "expires_at": grant.expires_at.isoformat(), "requested_by": str(grant.requested_by.user_id)})
    return grant


def active_grant(admin, tenant):
    return TenantAccessGrant.objects.filter(
        requested_by=admin, tenant=tenant, status=TenantAccessGrant.Status.APPROVED, expires_at__gt=timezone.now()
    ).first()


def read_tenant_role_assignments(admin, tenant, grant, *, request=None):
    """Break-glass read of tenant-schema data. Requires an active, approved grant for exactly this
    admin and tenant; the access is audited in both the platform and the tenant trail."""
    if grant is None or grant.tenant_id != tenant.id or grant.requested_by_id != admin.id or grant.expires_at <= timezone.now():
        raise DomainError("No active approved access grant for this tenant.", code="access_grant_required", status_code=403)
    record_platform_event("access.read", actor_user_id=admin.user_id, tenant_id=tenant.id, target_type="role_assignments", metadata={"grant_id": str(grant.id)}, request=request)
    record_tenant_event(tenant, "platform_access.read", actor_user_id=admin.user_id, target_type="role_assignments", metadata={"grant_id": str(grant.id)}, request=request)
    with schema_context(tenant.schema_name):
        rows = list(RoleAssignment.objects.filter(revoked_at__isnull=True).select_related("role").order_by("created_at"))
    return rows  # schema_context has already restored the previous schema
