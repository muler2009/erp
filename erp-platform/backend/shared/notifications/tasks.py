from celery import shared_task
from django.core.mail import send_mail
from django.utils import timezone

from platform_core.users.models import User
from shared.celery import TenantTask
from shared.notifications.models import Notification


@shared_task(name="notifications.send_email", base=TenantTask, bind=True, max_retries=3, default_retry_delay=60)
def send_notification_email(self, notification_id):
    notification = Notification.objects.filter(pk=notification_id).first()
    if notification is None or notification.emailed_at is not None:
        return False  # idempotent: already sent or removed
    user = User.objects.filter(pk=notification.user_id, is_active=True).first()
    if user is None:
        return False
    try:
        send_mail(subject=notification.title, message=notification.body or notification.title, from_email=None, recipient_list=[user.email], fail_silently=False)
    except Exception as exc:  # noqa: BLE001 - retried with backoff; final failure stays visible in worker logs
        raise self.retry(exc=exc)
    Notification.objects.filter(pk=notification.pk).update(emailed_at=timezone.now())
    return True
