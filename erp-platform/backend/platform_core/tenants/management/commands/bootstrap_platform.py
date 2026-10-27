"""Create the public platform tenant/domain, the default plan, the superadmin role and the first
platform administrator (with a one-time invite link printed once). Idempotent."""
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from platform_core.audit.services import record_platform_event
from platform_core.catalog import DEFAULT_PLAN_CODE, MODULES
from platform_core.identity.crypto import hash_invite_token, new_invite_token
from platform_core.tenants.models import Domain, Plan, Tenant
from platform_core.users import services
from platform_core.users.models import PlatformAdmin, User


class Command(BaseCommand):
    help = "Bootstrap the platform tenant, default plan and first platform administrator."

    def add_arguments(self, parser):
        parser.add_argument("--admin-email", required=True)
        parser.add_argument("--admin-name", default="Platform Administrator")

    @transaction.atomic
    def handle(self, *args, **opts):
        tenant, _ = Tenant.objects.get_or_create(
            schema_name="public",
            defaults={"name": "Platform", "slug": "platform", "is_platform": True, "status": Tenant.Status.ACTIVE},
        )
        Domain.objects.get_or_create(domain=settings.PLATFORM_HOST, defaults={"tenant": tenant, "is_primary": True})
        Plan.objects.get_or_create(code=DEFAULT_PLAN_CODE, defaults={"name": "Standard", "modules": list(MODULES)})
        role = services.ensure_superadmin_role()

        email = opts["admin_email"].strip().lower()
        if PlatformAdmin.objects.filter(status=PlatformAdmin.Status.ACTIVE).exists():
            raise CommandError("An active platform administrator already exists; use the API to propose more.")
        user = User.objects.filter(email__iexact=email).first() or User.objects.create_user(email, opts["admin_name"])
        admin, _ = PlatformAdmin.objects.get_or_create(user=user, defaults={"status": PlatformAdmin.Status.INVITED})
        admin.roles.set([role])
        token = new_invite_token()
        admin.status = PlatformAdmin.Status.INVITED
        admin.invite_token_hash = hash_invite_token(token)
        admin.invite_expires_at = timezone.now() + timedelta(hours=settings.INVITE_TTL_HOURS)
        admin.save()
        record_platform_event("platform.bootstrapped", target_type="platform_admin", target_id=admin.id, metadata={"email": email})
        self.stdout.write(self.style.SUCCESS("Platform bootstrapped. One-time sign-in link (shown once):"))
        self.stdout.write(f"{settings.PUBLIC_SCHEME}://{settings.PLATFORM_HOST}/auth/login?invite={token}")
