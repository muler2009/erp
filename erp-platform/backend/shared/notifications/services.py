"""Notification service: in-app rows + optional email, honouring per-user preferences and the tenant switch
`notifications.email_enabled`. Emails are sent after the surrounding transaction commits."""
from django.db import connection, transaction
from django.utils import timezone

from platform_core.organizations import services as org
from platform_core.users.models import TenantMembership
from shared.api.errors import ValidationFailed
from shared.tenancy import current_tenant
from shared.notifications.models import Notification, NotificationPreference


def notify(user_ids, notification_type, title, body="", *, ref_type="", ref_id="", email=False):
    """Create notifications for active members only (others are skipped). Returns the created rows."""
    tenant = current_tenant()
    active = set(
        TenantMembership.objects.filter(tenant=tenant, user_id__in=set(user_ids), status=TenantMembership.Status.ACTIVE).values_list("user_id", flat=True)
    )
    prefs = {p.user_id: p for p in NotificationPreference.objects.filter(user_id__in=active, notification_type=notification_type)}
    email_enabled = bool(org.get_setting("notifications.email_enabled", True))
    created = []
    for user_id in active:
        pref = prefs.get(user_id)
        if pref is not None and not pref.in_app and not (email and pref.email):
            continue
        in_app = pref.in_app if pref is not None else True
        send_email = email and email_enabled and (pref.email if pref is not None else True)
        row = None
        if in_app or send_email:
            row = Notification.objects.create(user_id=user_id, notification_type=notification_type, title=title[:200], body=body, ref_type=ref_type, ref_id=str(ref_id or ""))
            created.append(row)
        if send_email and row is not None:
            schema = tenant.schema_name
            transaction.on_commit(lambda nid=row.id, schema=schema: _enqueue_email(schema, nid))
    return created


def _enqueue_email(schema, notification_id):
    from shared.notifications.tasks import send_notification_email

    send_notification_email.delay(tenant_schema=schema, notification_id=str(notification_id))


def mark_read(user_id, notification_id=None):
    qs = Notification.objects.filter(user_id=user_id, read_at__isnull=True)
    if notification_id is not None:
        qs = qs.filter(pk=notification_id)
    return qs.update(read_at=timezone.now())


def unread_count(user_id):
    return Notification.objects.filter(user_id=user_id, read_at__isnull=True).count()


def set_preference(user_id, notification_type, *, in_app=None, email=None):
    if not notification_type or len(notification_type) > 80:
        raise ValidationFailed("Invalid notification type.", code="invalid_type")
    pref, _ = NotificationPreference.objects.get_or_create(user_id=user_id, notification_type=notification_type)
    if in_app is not None:
        pref.in_app = in_app
    if email is not None:
        pref.email = email
    pref.save()
    return pref
