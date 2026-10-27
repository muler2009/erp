"""Resolve an authenticated OIDC identity to an application user and verify it may enter this host.

Linking an external identity to a User happens in exactly two ways: provisioning created a brand-new
Keycloak account for it, or the holder presents a valid one-time invite token. Never by email match.
"""
from django.utils import timezone

from platform_core.audit.services import record_platform_event, record_tenant_event
from platform_core.identity.crypto import hash_invite_token
from platform_core.users.models import ExternalIdentity, PlatformAdmin, TenantMembership


class LoginDenied(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _find_identity(claims):
    return ExternalIdentity.objects.select_related("user").filter(issuer=claims["iss"], subject=claims["sub"]).first()


def _link(user, claims):
    if ExternalIdentity.objects.filter(user=user, issuer=claims["iss"]).exists():
        raise LoginDenied("account_already_linked")  # an invite cannot re-point an already-linked user
    return ExternalIdentity.objects.create(user=user, issuer=claims["iss"], subject=claims["sub"])


def _valid_invite(model, token, **filters):
    if not token:
        return None
    candidate = model.objects.select_related("user").filter(invite_token_hash=hash_invite_token(token), **filters).first()
    if candidate and candidate.invite_expires_at and candidate.invite_expires_at > timezone.now():
        return candidate
    return None


def resolve_login(*, claims, tenant, invite_token=None, request=None):
    """Return the User allowed to sign in to `tenant` (platform tenant = platform console)."""
    identity = _find_identity(claims)
    if tenant.is_platform:
        return _resolve_platform(identity, claims, invite_token, request)
    return _resolve_tenant(identity, claims, tenant, invite_token, request)


def _resolve_tenant(identity, claims, tenant, invite_token, request):
    if identity is not None:
        user = identity.user
        if not user.is_active:
            raise LoginDenied("user_inactive")
        membership = TenantMembership.objects.filter(user=user, tenant=tenant).first()
        if membership is None:
            raise LoginDenied("not_a_tenant_member")
        if membership.status == TenantMembership.Status.ACTIVE:
            return user
        if membership.status == TenantMembership.Status.INVITED:
            invited = _valid_invite(TenantMembership, invite_token, id=membership.id, status=TenantMembership.Status.INVITED)
            if invited:
                _activate(invited, tenant, request)
                return user
        raise LoginDenied("membership_not_active")

    invited = _valid_invite(TenantMembership, invite_token, tenant=tenant, status=TenantMembership.Status.INVITED)
    if invited is None:
        raise LoginDenied("unknown_identity_requires_invite")
    if not invited.user.is_active:
        raise LoginDenied("user_inactive")
    _link(invited.user, claims)
    _activate(invited, tenant, request)
    return invited.user


def _activate(membership, tenant, request):
    membership.status = TenantMembership.Status.ACTIVE
    membership.invite_token_hash = ""
    membership.invite_expires_at = None
    membership.save(update_fields=["status", "invite_token_hash", "invite_expires_at"])
    record_tenant_event(tenant, "membership.activated", actor_user_id=membership.user_id, target_type="membership", target_id=membership.id, request=request)


def _resolve_platform(identity, claims, invite_token, request):
    if identity is not None:
        admin = PlatformAdmin.objects.filter(user=identity.user).first()
        if admin is None or not identity.user.is_active:
            raise LoginDenied("not_a_platform_admin")
        if admin.status == PlatformAdmin.Status.ACTIVE:
            return identity.user
        if admin.status == PlatformAdmin.Status.INVITED:
            invited = _valid_invite(PlatformAdmin, invite_token, id=admin.id, status=PlatformAdmin.Status.INVITED)
            if invited:
                _activate_admin(invited, request)
                return identity.user
        raise LoginDenied("platform_admin_not_active")

    invited = _valid_invite(PlatformAdmin, invite_token, status=PlatformAdmin.Status.INVITED)
    if invited is None or not invited.user.is_active:
        raise LoginDenied("unknown_identity_requires_invite")
    _link(invited.user, claims)
    _activate_admin(invited, request)
    return invited.user


def _activate_admin(admin, request):
    admin.status = PlatformAdmin.Status.ACTIVE
    admin.invite_token_hash = ""
    admin.invite_expires_at = None
    admin.save(update_fields=["status", "invite_token_hash", "invite_expires_at"])
    record_platform_event("platform_admin.activated", actor_user_id=admin.user_id, target_type="platform_admin", target_id=admin.id, request=request)
