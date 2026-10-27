import uuid

import pytest
from django.core import mail
from django_tenants.utils import schema_context

from platform_core.organizations import services as org
from shared.notifications import services as notifications
from shared.notifications.models import Notification
from tests.conftest import ACME_HOST, Api, invite_token_from_mail
from platform_core.authorization.models import RoleDefinition
from platform_core.users.models import TenantMembership


@pytest.fixture
def member(world, idp, owner_api, commit, acme):
    from django.core import mail as m

    m.outbox = []
    with commit():
        owner_api.post("/api/v1/users/invite", {"email": "notif@acme.test", "display_name": "Notif", "role_ids": []})
    api = Api(ACME_HOST)
    assert api.login(idp, "notif-sub", invite=invite_token_from_mail()).status_code == 302
    m.outbox = []
    return api, TenantMembership.objects.get(user__email="notif@acme.test").user_id


@pytest.mark.django_db
def test_in_app_notifications_and_email(acme, member, commit):
    api, user_id = member
    with schema_context(acme["schema"]):
        with commit():
            rows = notifications.notify([user_id], "workflow.task", "Approval needed", "PO-1 awaits you", ref_type="po", ref_id="1", email=True)
    assert len(rows) == 1
    assert [m.to for m in mail.outbox] == [["notif@acme.test"]] and mail.outbox[0].subject == "Approval needed"
    listing = api.get("/api/v1/notifications").json()
    assert listing["unread_count"] == 1 and listing["results"][0]["title"] == "Approval needed" and not listing["results"][0]["read"]
    with schema_context(acme["schema"]):
        assert Notification.objects.get(pk=rows[0].pk).emailed_at is not None


@pytest.mark.django_db
def test_users_only_see_and_modify_their_own_notifications(acme, member, owner_api):
    api, user_id = member
    with schema_context(acme["schema"]):
        mine = notifications.notify([user_id], "t", "mine")[0]
        theirs = notifications.notify([acme["owner_user_id"]], "t", "owner only")[0]
    titles = [n["title"] for n in api.get("/api/v1/notifications").json()["results"]]
    assert titles == ["mine"]
    assert api.post(f"/api/v1/notifications/{theirs.id}/read").status_code == 404  # cannot touch another user's
    assert api.post(f"/api/v1/notifications/{mine.id}/read").status_code == 204
    assert api.get("/api/v1/notifications?unread=true").json()["results"] == []
    assert owner_api.get("/api/v1/notifications").json()["unread_count"] == 1
    assert api.post("/api/v1/notifications/read-all").json() == {"marked": 0}
    assert Api(ACME_HOST).get("/api/v1/notifications").status_code == 401


@pytest.mark.django_db
def test_preferences_and_tenant_email_switch(acme, member, commit, owner_api):
    api, user_id = member
    assert api.put("/api/v1/notification-preferences", {"notification_type": "digest", "in_app": False, "email": False}).status_code == 200
    with schema_context(acme["schema"]):
        with commit():
            assert notifications.notify([user_id], "digest", "Daily digest", email=True) == []  # fully opted out
        assert notifications.notify([user_id], "other", "Other")  # other types unaffected
    api.put("/api/v1/notification-preferences", {"notification_type": "mailonly", "in_app": False, "email": True})
    with schema_context(acme["schema"]):
        with commit():
            rows = notifications.notify([user_id], "mailonly", "Mail only", email=True)
        assert len(rows) == 1
    assert [m.subject for m in mail.outbox] == ["Mail only"]

    mail.outbox = []
    assert owner_api.put("/api/v1/settings", {"notifications.email_enabled": False}).status_code == 200  # tenant-wide switch
    with schema_context(acme["schema"]):
        with commit():
            notifications.notify([user_id], "other2", "No email", email=True)
    assert mail.outbox == []
    assert any(p["notification_type"] == "digest" for p in api.get("/api/v1/notification-preferences").json())


@pytest.mark.django_db
def test_only_active_members_are_notified(acme):
    with schema_context(acme["schema"]):
        assert notifications.notify([uuid.uuid4()], "t", "nobody") == []
        assert len(notifications.notify([acme["owner_user_id"], uuid.uuid4()], "t", "one")) == 1
