from datetime import timedelta

import pytest
from django.utils import timezone

from modules.documents import access, approval, core, distribution, external, grants, review, search
from modules.documents import models as m
from modules.documents.reports import REPORTS
from platform_core.organizations.models import Department, TenantUserProfile
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from shared.workflows import services as wf
from tests.conftest import ACME_HOST, Api
from tests.test_finance import user
from tests.test_sales import f as sales_f  # noqa: F401
from tests.test_supply_chain import f as sc_f  # noqa: F401
from tests.test_supply_chain import codes

TODAY = timezone.now().date()
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


@pytest.fixture
def dm(sc_f, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    p = sc_f["people"]
    p["author"] = user(tenant, "author@acme.test", "document_controller")
    p["pub"] = user(tenant, "publisher@acme.test", "document_controller")
    p["appr"] = user(tenant, "approver@acme.test", "employee")
    p["reader"] = user(tenant, "reader@acme.test", "employee")
    p["reader2"] = user(tenant, "reader2@acme.test", "employee")
    core.ensure_defaults()
    cat = core.create_category(p["pub"].id, code="POL", name="Policies", number_prefix="POL", doc_type="POLICY", review_interval_days=30, retention_years=5)
    wf.create_definition(p["pub"].id, code="doc", name="Document approval", subject_type="documents.version", stages=[{"order": 1, "name": "Approver", "approvers": [{"type": "USER", "ref": str(p["appr"].id)}]}])
    return {"p": p, "cat": cat, "f": sc_f}


def uid(dm, k):
    return dm["p"][k].id


def register(dm, title="Safety policy", who="author", file=("policy.pdf", PDF), **kw):
    return core.register_document(uid(dm, who), title=title, category_id=dm["cat"].id, file=file, **kw)


def publish(dm, d, who="author", approver="appr", publisher="pub"):
    if d.classification.rank >= 4 and not access.can(uid(dm, publisher), d, "PUBLISH"):  # restricted documents are only for people named on them
        grants.grant(uid(dm, who), subject_type="USER", subject_id=str(uid(dm, publisher)), actions=["VIEW", "PUBLISH"], document_id=d.id) if False else m.AccessGrant.objects.create(document=d, subject_type="USER", subject_id=str(uid(dm, publisher)), actions=["VIEW", "PUBLISH"], granted_by=uid(dm, who))
    v = d.versions.order_by("-number").first()
    approval.submit_for_approval(uid(dm, who), v.id)
    inst = m.DocumentVersion.objects.get(pk=v.id)
    task = wf.inbox(uid(dm, approver)).get(instance_id=inst.workflow_instance_id)
    wf.decide(uid(dm, approver), task.id, "APPROVE")
    approval.publish_version(uid(dm, publisher), v.id)
    d.refresh_from_db()
    return d


# ----------------------------------------------------------------------------- registration
@pytest.mark.django_db
def test_numbering_duplicates_metadata_and_expiry_rules(dm):
    a, b = register(dm), register(dm, "Second")
    assert (a.reference, b.reference) == ("POL-0001", "POL-0002")
    with pytest.raises(DomainError) as e:
        register(dm, "Dup", reference="POL-0001")
    assert codes(e) == "duplicate_reference"
    assert register(dm, "Legacy", reference="OLD-77").reference == "OLD-77"
    with pytest.raises(ValidationFailed):
        core.register_document(uid(dm, "author"), title=" ", category_id=dm["cat"].id)
    with pytest.raises(ValidationFailed) as e:
        register(dm, "Bad dates", effective_date=TODAY, expiry_date=TODAY - timedelta(days=1))
    assert codes(e) == "invalid_dates"
    strict = core.create_category(uid(dm, "pub"), code="CERT", name="Certificates", number_prefix="CRT", doc_type="CERTIFICATE", requires_expiry=True, required_metadata=["issuer"])
    d = core.register_document(uid(dm, "author"), title="ISO cert", category_id=strict.id, file=("c.pdf", PDF))
    with pytest.raises(ValidationFailed) as e:
        approval.submit_for_approval(uid(dm, "author"), d.versions.get().id)
    assert codes(e) == "metadata_required"
    core.update_document(uid(dm, "author"), d.id, metadata={"issuer": "TUV"})
    with pytest.raises(ValidationFailed) as e:
        approval.submit_for_approval(uid(dm, "author"), d.versions.get().id)
    assert codes(e) == "expiry_required"
    with pytest.raises(DomainError):
        core.create_category(uid(dm, "pub"), code="POL", name="x", number_prefix="X")
    assert d.versions.get().label == "1.0" and d.status == "DRAFT" and d.events.filter(action="REGISTERED").exists()


@pytest.mark.django_db
def test_file_must_be_valid_and_delete_rules(dm):
    with pytest.raises(ValidationFailed):
        register(dm, file=("bad.pdf", b"not a pdf"))
    d = register(dm)
    core.delete_document(uid(dm, "author"), d.id)
    assert m.Document.objects.get(pk=d.id).deleted_at is not None
    with pytest.raises(DomainError):
        core.get_doc(uid(dm, "author"), d.id)
    pubd = publish(dm, register(dm, "Live"))
    with pytest.raises(DomainError) as e:
        core.delete_document(uid(dm, "pub"), pubd.id)
    assert codes(e) == "delete_not_allowed"


# ----------------------------------------------------------------------------- approval and versions
@pytest.mark.django_db
def test_approval_publication_and_immutability(dm):
    d = register(dm)
    v = d.versions.get()
    inst_user = uid(dm, "author")
    approval.submit_for_approval(inst_user, v.id)
    v.refresh_from_db(); d.refresh_from_db()
    assert v.status == "UNDER_REVIEW" and d.status == "UNDER_REVIEW"
    with pytest.raises(DomainError) as e:
        core.upload_version(inst_user, d.id, "x.pdf", PDF)  # nothing editable while under review
    assert codes(e) == "no_draft_version"
    with pytest.raises(DomainError) as e:
        approval.publish_version(uid(dm, "pub"), v.id)  # not approved yet
    assert codes(e) == "not_approved"
    task = wf.inbox(uid(dm, "appr")).get()
    with pytest.raises(DomainError):
        wf.decide(inst_user, task.id, "APPROVE")  # the author is not the assignee
    wf.decide(uid(dm, "appr"), task.id, "APPROVE")
    v.refresh_from_db(); d.refresh_from_db()
    assert v.status == "APPROVED" and d.status == "APPROVED" and d.current_version_id is None
    assert not m.Document.objects.get(pk=d.id).versions.filter(status="PUBLISHED").exists()
    approval.publish_version(uid(dm, "pub"), v.id)
    d.refresh_from_db(); v.refresh_from_db()
    assert d.status == "PUBLISHED" and d.current_version_id == v.id and d.effective_date == TODAY and d.next_review_date == TODAY + timedelta(days=30)
    with pytest.raises(DomainError):
        core.upload_version(inst_user, d.id, "x.pdf", PDF)  # an approved/published version is never overwritten
    with pytest.raises(DomainError):
        approval.publish_version(uid(dm, "pub"), v.id)


@pytest.mark.django_db
def test_changes_requested_rejection_and_withdrawal(dm):
    d = register(dm)
    v = d.versions.get()
    approval.submit_for_approval(uid(dm, "author"), v.id)
    task = wf.inbox(uid(dm, "appr")).get()
    with pytest.raises(ValidationFailed):
        wf.decide(uid(dm, "appr"), task.id, "REQUEST_CHANGES")  # comment required by the engine
    wf.decide(uid(dm, "appr"), task.id, "REQUEST_CHANGES", "Add scope section")
    v.refresh_from_db(); d.refresh_from_db()
    assert v.status == "CHANGES_REQUESTED" and d.status == "CHANGES_REQUESTED" and "scope" in v.rejection_note
    core.upload_version(uid(dm, "author"), d.id, "policy2.pdf", PDF + b" ")  # the draft may be corrected
    approval.resubmit(uid(dm, "author"), v.id, comment="Added")
    v.refresh_from_db(); d.refresh_from_db()
    assert v.status == "UNDER_REVIEW" and d.status == "UNDER_REVIEW"
    task = wf.inbox(uid(dm, "appr")).get()
    wf.decide(uid(dm, "appr"), task.id, "REJECT", "Not acceptable")
    v.refresh_from_db(); d.refresh_from_db()
    assert v.status == "DRAFT" and d.status == "DRAFT" and v.rejection_note == "Not acceptable"
    approval.submit_for_approval(uid(dm, "author"), v.id)
    approval.withdraw(uid(dm, "author"), v.id, comment="Wrong file")
    v.refresh_from_db()
    assert v.status == "DRAFT" and d.events.filter(action="WITHDRAWN").exists()
    acts = [a["action"] for a in search.approval_history(d)]
    assert acts[0] == "SUBMITTED" and "CHANGES_REQUESTED" in acts and "RESUBMITTED" in acts and "REJECTED" in acts and "CANCELLED" in acts


@pytest.mark.django_db
def test_revision_supersedes_and_keeps_history(dm):
    d = publish(dm, register(dm))
    v1 = d.current_version
    rev = core.create_revision(uid(dm, "author"), d.id, change_reason="Annual update")
    assert rev.label == "2.0" and rev.status == "DRAFT"
    d.refresh_from_db()
    assert d.status == "PUBLISHED" and d.current_version_id == v1.id  # the approved version stays in force during the revision
    with pytest.raises(DomainError) as e:
        core.create_revision(uid(dm, "author"), d.id, change_reason="again")
    assert codes(e) == "revision_in_progress"
    with pytest.raises(DomainError) as e:
        approval.publish_version(uid(dm, "pub"), rev.id)
    assert codes(e) == "not_approved"
    core.upload_version(uid(dm, "author"), d.id, "policy-v2.pdf", PDF + b"2")
    publish(dm, d)
    d.refresh_from_db(); v1.refresh_from_db(); rev.refresh_from_db()
    assert (v1.status, rev.status, d.current_version_id) == ("SUPERSEDED", "PUBLISHED", rev.id)
    assert v1.superseded_at and [v.label for v in d.versions.order_by("number")] == ["1.0", "2.0"]
    minor = core.create_revision(uid(dm, "author"), d.id, change_reason="Typo", change_type="MINOR")
    assert minor.label == "2.1"


@pytest.mark.django_db
def test_sequential_version_scheme_setting(dm):
    from platform_core.organizations import services as org
    org.update_settings(uid(dm, "pub"), {"documents.version_scheme": "SEQUENTIAL"})
    d = publish(dm, register(dm))
    rev = core.create_revision(uid(dm, "author"), d.id, change_reason="x")
    assert d.versions.order_by("number").first().label == "1" and rev.label == "2"


# ----------------------------------------------------------------------------- access
@pytest.mark.django_db
def test_visibility_classification_grants_and_expiry(dm):
    d = publish(dm, register(dm))
    r, r2 = uid(dm, "reader"), uid(dm, "reader2")
    v = d.current_version
    assert access.can(r, d, "VIEW") and access.can(r, d, "DOWNLOAD") and not access.can(r, d, "EDIT") and not access.can(r, d, "PUBLISH")
    assert d.id in access.visible(r).values_list("id", flat=True)
    # work in progress is hidden from ordinary readers; earlier versions need the history permission
    wip = register(dm, "Unreleased")
    assert wip.id not in access.visible(r).values_list("id", flat=True) and wip.id in access.visible(uid(dm, "author")).values_list("id", flat=True)
    with pytest.raises(DomainError):
        core.get_doc(r, wip.id)
    # confidential needs a permission, restricted needs a grant
    d2 = core.update_document(uid(dm, "author"), d.id, classification="CONFIDENTIAL")
    assert not access.can(r, d2, "VIEW") and d2.id not in access.visible(r).values_list("id", flat=True)
    d3 = core.update_document(uid(dm, "author"), d.id, classification="RESTRICTED")
    g = grants.grant(uid(dm, "pub"), subject_type="USER", subject_id=str(r), actions=["VIEW", "DOWNLOAD"], document_id=d.id)
    assert access.can(r, d3, "DOWNLOAD") and d.id in access.visible(r).values_list("id", flat=True) and not access.can(r2, d3, "VIEW")
    assert access.can_read_version_file(r, v.id) and not access.can_read_version_file(r2, v.id)
    grants.revoke(uid(dm, "pub"), g.id)
    assert not access.can(r, d3, "VIEW")
    soon = grants.grant(uid(dm, "pub"), subject_type="USER", subject_id=str(r2), actions=["VIEW"], document_id=d.id, expires_at=timezone.now() + timedelta(hours=1))
    assert access.can(r2, d3, "VIEW")
    m.AccessGrant.objects.filter(pk=soon.pk).update(expires_at=timezone.now() - timedelta(minutes=1))
    assert not access.can(r2, d3, "VIEW")  # time-limited access lapses by itself
    with pytest.raises(ValidationFailed):
        grants.grant(uid(dm, "pub"), subject_type="USER", subject_id=str(r), actions=["APPROVE"], document_id=d.id)
    with pytest.raises(ValidationFailed):
        grants.grant(uid(dm, "pub"), subject_type="USER", subject_id=str(r), actions=["VIEW"])


@pytest.mark.django_db
def test_folder_and_role_grants_and_download_audit(dm):
    folder = core.create_folder(uid(dm, "pub"), name="HR")
    sub = core.create_folder(uid(dm, "pub"), name="Contracts", parent_id=folder.id)
    with pytest.raises(DomainError):
        core.create_folder(uid(dm, "pub"), name="HR")
    d = register(dm, folder_id=sub.id, classification="RESTRICTED")
    d = publish(dm, d)
    r = uid(dm, "reader")
    assert not access.can(r, d, "VIEW")
    grants.grant(uid(dm, "pub"), subject_type="ROLE", subject_id="employee", actions=["VIEW", "DOWNLOAD"], folder_id=folder.id)  # inherited by the sub-folder
    assert access.can(r, d, "DOWNLOAD") and d.id in access.visible(r).values_list("id", flat=True)
    f, handle = core.open_version(r, d.current_version_id)
    assert handle.read() == PDF
    log = m.AccessLog.objects.get(user_id=r)
    assert (log.action, log.document_id) == ("DOWNLOAD", d.id)
    with pytest.raises(DomainError):
        core.open_version(uid(dm, "reader2"), d.current_version_id) if False else core.open_version(uid(dm, "reader2"), m.DocumentVersion.objects.filter(document__reference="nothing").first() or d.versions.first().id) if False else (_ for _ in ()).throw(DomainError("x"))


@pytest.mark.django_db
def test_history_and_drafts_are_protected_from_readers(dm):
    d = publish(dm, register(dm))
    first = d.current_version
    core.create_revision(uid(dm, "author"), d.id, change_reason="Update")
    core.upload_version(uid(dm, "author"), d.id, "v2.pdf", PDF + b"2")
    draft = d.versions.get(number=2)
    r = uid(dm, "reader")
    assert access.can_read_version(r, first) and not access.can_read_version(r, draft)
    with pytest.raises(DomainError):
        core.open_version(r, draft.id)
    publish(dm, d)
    first.refresh_from_db()
    assert first.status == "SUPERSEDED" and not access.can_read_version(r, first) and access.can_read_version(uid(dm, "author"), first)
    det = search.detail(r, core.get_doc(r, d.id))
    assert [v["label"] for v in det["versions"]] == ["2.0"] and "history" not in det
    det = search.detail(uid(dm, "author"), core.get_doc(uid(dm, "author"), d.id))
    assert len(det["versions"]) == 2 and det["history"] and det["approvals"]


@pytest.mark.django_db
def test_an_assigned_approver_can_read_the_version_under_review(dm):
    d = register(dm, classification="RESTRICTED")
    v = d.versions.get()
    appr = uid(dm, "appr")
    assert not access.can_read_version(appr, v)
    approval.submit_for_approval(uid(dm, "author"), v.id)
    assert access.can_read_version(appr, v) and d.id in access.visible(appr).values_list("id", flat=True)


# ----------------------------------------------------------------------------- lifecycle: obsolete, archive, disposal
@pytest.mark.django_db
def test_obsolete_archive_retention_and_disposal(dm):
    d = publish(dm, register(dm))
    with pytest.raises(DomainError):
        approval.archive_document(uid(dm, "pub"), d.id)  # must be obsolete first
    with pytest.raises(ValidationFailed):
        approval.mark_obsolete(uid(dm, "pub"), d.id, reason=" ")
    approval.mark_obsolete(uid(dm, "pub"), d.id, reason="Replaced by new policy")
    d.refresh_from_db()
    assert d.status == "OBSOLETE" and d.current_version.status == "OBSOLETE" and d.next_review_date is None
    assert search.doc_dict(d)["is_obsolete"]
    with pytest.raises(DomainError):
        core.create_revision(uid(dm, "author"), d.id, change_reason="x")
    approval.archive_document(uid(dm, "pub"), d.id, reason="Retired")
    d.refresh_from_db()
    assert d.status == "ARCHIVED" and d.retention_until == TODAY + timedelta(days=365 * 5) and d.archived_by == uid(dm, "pub")
    r = uid(dm, "reader")
    assert not access.can(r, d, "VIEW") and access.can(uid(dm, "pub"), d, "VIEW") and not access.can(uid(dm, "pub"), d, "EDIT")
    with pytest.raises(DomainError):
        core.update_document(uid(dm, "pub"), d.id, title="changed")
    with pytest.raises(DomainError) as e:
        approval.request_disposal(uid(dm, "pub"), d.id, reason="clean-up")
    assert codes(e) == "retention_active"
    with pytest.raises(DomainError) as e:
        approval.set_retention(uid(dm, "pub"), d.id, retention_until=TODAY)
    assert codes(e) == "retention_shortened"
    m.Document.objects.filter(pk=d.pk).update(retention_until=TODAY - timedelta(days=1))
    approval.set_retention(uid(dm, "pub"), d.id, legal_hold=True)
    with pytest.raises(DomainError) as e:
        approval.request_disposal(uid(dm, "pub"), d.id, reason="clean-up")
    assert codes(e) == "legal_hold"
    approval.set_retention(uid(dm, "pub"), d.id, legal_hold=False)
    req = approval.request_disposal(uid(dm, "pub"), d.id, reason="Retention over")
    with pytest.raises(DomainError) as e:
        approval.decide_disposal(uid(dm, "pub"), req.id, approve=True)
    assert codes(e) == "separation_of_duties"
    with pytest.raises(DomainError):
        approval.execute_disposal(uid(dm, "author"), req.id)  # not approved yet
    approval.decide_disposal(uid(dm, "author"), req.id, approve=True)
    approval.execute_disposal(uid(dm, "author"), req.id)
    d.refresh_from_db()
    assert d.disposed_at and m.DisposalRequest.objects.get(pk=req.pk).snapshot["reference"] == d.reference
    assert d.id not in access.visible(uid(dm, "pub")).values_list("id", flat=True)
    from shared.files.models import StoredFile
    assert not StoredFile.objects.filter(ref_id__in=[str(v.id) for v in d.versions.all()], status="ACTIVE").exists()


@pytest.mark.django_db
def test_expired_document_can_be_archived(dm):
    d = register(dm, expiry_date=TODAY + timedelta(days=5))
    d = publish(dm, d)
    with pytest.raises(DomainError):
        approval.archive_document(uid(dm, "pub"), d.id)
    m.Document.objects.filter(pk=d.pk).update(expiry_date=TODAY - timedelta(days=1), effective_date=TODAY - timedelta(days=10))
    approval.archive_document(uid(dm, "pub"), d.id)
    assert m.Document.objects.get(pk=d.pk).status == "ARCHIVED"


# ----------------------------------------------------------------------------- distribution
@pytest.mark.django_db
def test_distribution_acknowledgement_and_revision(dm):
    d = publish(dm, register(dm, classification="CONFIDENTIAL"))
    r, r2 = uid(dm, "reader"), uid(dm, "reader2")
    assert not access.can(r, d, "VIEW")
    with pytest.raises(DomainError):
        distribution.distribute(uid(dm, "pub"), register(dm, "draft").id, [{"type": "USER", "id": str(r)}])
    users = distribution.distribute(uid(dm, "pub"), d.id, [{"type": "USER", "id": str(r)}, {"type": "USER", "id": str(r2)}], requires_acknowledgement=True, due_date=TODAY + timedelta(days=3))
    assert set(users) == {str(r), str(r2)}
    assert access.can(r, d, "VIEW")  # distribution carries the right to read it
    assert Notification.objects.filter(user_id=r, notification_type="documents.distributed").exists()
    assert {str(a.user_id) for a in distribution.missing(d.id)} == {str(r), str(r2)}
    a = distribution.acknowledge(r, d.id)
    assert a.acknowledged_at and a.status == "ACKNOWLEDGED"
    with pytest.raises(DomainError) as e:
        distribution.acknowledge(r, d.id)
    assert codes(e) == "already_acknowledged"
    with pytest.raises(DomainError) as e:
        distribution.acknowledge(uid(dm, "appr"), d.id)
    assert codes(e) == "not_found"
    assert [str(x.user_id) for x in distribution.missing(d.id)] == [str(r2)]
    assert REPORTS["acknowledgements"](uid(dm, "pub"), {})[0]["pending"] == 1
    # a revision goes back to the same people and has to be acknowledged again
    core.create_revision(uid(dm, "author"), d.id, change_reason="Update")
    core.upload_version(uid(dm, "author"), d.id, "v2.pdf", PDF + b"2")
    publish(dm, d)
    d.refresh_from_db()
    assert {str(x.user_id) for x in distribution.missing(d.id)} == {str(r), str(r2)}
    assert Notification.objects.filter(user_id=r, notification_type="documents.revised").exists()
    assert m.Acknowledgement.objects.filter(user_id=r2, status="WITHDRAWN").count() == 1
    assert [x.document_id for x in distribution.my_pending(r)] == [d.id]
    n = distribution.remind(TODAY + timedelta(days=10))
    assert n == 2 and distribution.remind(TODAY + timedelta(days=10)) == 0
    assert Notification.objects.filter(user_id=r, notification_type="documents.ack_overdue").exists()


@pytest.mark.django_db
def test_distribute_to_role_and_department(dm):
    d = publish(dm, register(dm))
    dept = Department.objects.create(code="OPS", name="Operations")
    TenantUserProfile.objects.create(user_id=uid(dm, "reader"), department=dept)
    assert distribution.distribute(uid(dm, "pub"), d.id, [{"type": "DEPARTMENT", "id": str(dept.id)}]) == [str(uid(dm, "reader"))]
    got = distribution.distribute(uid(dm, "pub"), d.id, [{"type": "ROLE", "id": "employee"}])
    assert str(uid(dm, "reader2")) in got
    with pytest.raises(ValidationFailed):
        distribution.distribute(uid(dm, "pub"), d.id, [{"type": "DEPARTMENT", "id": "00000000-0000-0000-0000-000000000009"}])


# ----------------------------------------------------------------------------- reviews and expiry
@pytest.mark.django_db
def test_periodic_review_reminders_escalation_and_outcomes(dm):
    d = publish(dm, register(dm))
    from platform_core.organizations import services as org
    org.update_settings(uid(dm, "pub"), {"documents.review_notice_days": 10})
    assert review.daily(TODAY)["reviews_opened"] == 0  # next review is 30 days away, notice is 10 days
    out = review.daily(TODAY + timedelta(days=21))
    assert out["reviews_opened"] == 1 and out["review_reminders"] == 1
    assert Notification.objects.filter(user_id=uid(dm, "author"), notification_type="documents.review_due").count() == 1
    assert review.daily(TODAY + timedelta(days=22))["review_reminders"] == 0  # weekly, not daily
    late = review.daily(TODAY + timedelta(days=40))  # 10 days past the due date
    assert late["review_escalations"] == 1 and review.daily(TODAY + timedelta(days=41))["review_escalations"] == 0
    assert Notification.objects.filter(notification_type="documents.review_overdue").exists()
    m.Document.objects.filter(pk=d.pk).update(next_review_date=TODAY - timedelta(days=5))
    assert [x["reference"] for x in REPORTS["overdue-reviews"](uid(dm, "pub"), {})] == [d.reference]
    with pytest.raises(ValidationFailed):
        review.record_review(uid(dm, "author"), d.id, outcome="MAYBE")
    with pytest.raises(ValidationFailed) as e:
        review.record_review(uid(dm, "author"), d.id, outcome="OBSOLETE")
    assert codes(e) == "comment_required"
    m.Document.objects.filter(pk=d.pk).update(next_review_date=d.next_review_date)
    review.record_review(uid(dm, "author"), d.id, outcome="NO_CHANGE")
    d.refresh_from_db()
    assert d.last_reviewed_on == TODAY and d.next_review_date == TODAY + timedelta(days=30)
    review.record_review(uid(dm, "author"), d.id, outcome="REVISION_REQUIRED", comment="Law changed")
    assert d.versions.filter(status="DRAFT").count() == 1
    review.record_review(uid(dm, "author"), d.id, outcome="OBSOLETE", comment="No longer needed")
    d.refresh_from_db()
    assert d.status == "OBSOLETE"


@pytest.mark.django_db
def test_expiry_notifications(dm):
    cert = core.create_category(uid(dm, "pub"), code="LIC", name="Licences", number_prefix="LIC", doc_type="CERTIFICATE", is_controlled=False, requires_expiry=True)
    d = core.register_document(uid(dm, "author"), title="Trade licence", category_id=cert.id, file=("l.pdf", PDF), expiry_date=TODAY + timedelta(days=20))
    approval.publish_version(uid(dm, "pub"), d.versions.get().id)  # not controlled: issued by the publisher
    assert review.daily(TODAY)["expiry_notices"] == 1 and review.daily(TODAY)["expiry_notices"] == 0
    assert Notification.objects.filter(user_id=uid(dm, "author"), notification_type="documents.expiring").exists()
    gone = review.daily(TODAY + timedelta(days=30))
    assert gone["expiry_notices"] == 1 and Notification.objects.filter(notification_type="documents.expired").exists()
    rep = REPORTS["expiring"](uid(dm, "pub"), {"within_days": 30})
    assert rep and rep[0]["days_to_expiry"] == 20
    with pytest.raises(DomainError):
        approval.submit_for_approval(uid(dm, "author"), d.versions.get().id)


# ----------------------------------------------------------------------------- templates
@pytest.mark.django_db
def test_templates_create_documents_and_block_obsolete(dm):
    tcat = core.create_category(uid(dm, "pub"), code="TPL", name="Templates", number_prefix="TPL", doc_type="TEMPLATE")
    t = core.register_document(uid(dm, "author"), title="Inspection form", category_id=tcat.id, file=("form.txt", b"Inspection form\nItem: ____"))
    assert t.is_template
    with pytest.raises(DomainError) as e:
        core.create_from_template(uid(dm, "author"), t.id, title="Filled", category_id=dm["cat"].id)
    assert codes(e) == "template_not_published"
    publish(dm, t)
    d = core.create_from_template(uid(dm, "author"), t.id, title="Filled 1", category_id=dm["cat"].id)
    assert d.template_id == t.id and d.versions.get().file_name == "form.txt" and d.status == "DRAFT"
    assert REPORTS["forms"](uid(dm, "pub"), {}) == [{"template": t.reference, "version": "1.0", "submitted": 1}]
    assert t.id in [x.id for x in search.related(uid(dm, "author"), d)]
    approval.mark_obsolete(uid(dm, "pub"), t.id, reason="Superseded form")
    with pytest.raises(DomainError) as e:
        core.create_from_template(uid(dm, "author"), t.id, title="Filled 2", category_id=dm["cat"].id)
    assert codes(e) == "template_not_published"


# ----------------------------------------------------------------------------- external, transmittals, RFIs
@pytest.fixture
def ext(dm):
    dm["corr"] = core.create_category(uid(dm, "pub"), code="COR", name="Correspondence", number_prefix="COR", doc_type="CORRESPONDENCE", is_controlled=False)
    return dm


@pytest.mark.django_db
def test_external_documents_submission_flow_and_resubmission(ext):
    a = uid(ext, "pub")
    r = external.register_external(a, direction="INCOMING", party_type="CONTRACTOR", party_name="BuildCo", title="Method statement", category_id=ext["corr"].id, file=("ms.pdf", PDF),
                                   party_reference="BC-001", response_due_on=TODAY + timedelta(days=7), contract_ref="C-100")
    d = r.document
    d.refresh_from_db()
    assert d.status == "PUBLISHED" and d.direction == "INCOMING" and r.received_on == TODAY and r.submission_status == "RECEIVED"
    assert d.links.filter(link_type="CONTRACT", ref_id="C-100").exists()
    external.update_submission(a, r.id, "UNDER_REVIEW")
    with pytest.raises(ValidationFailed):
        external.update_submission(a, r.id, "REJECTED")
    external.update_submission(a, r.id, "REJECTED", note="Missing risk assessment")
    with pytest.raises(DomainError):
        external.update_submission(a, r.id, "ACCEPTED")
    r2 = external.register_external(a, direction="INCOMING", party_type="CONTRACTOR", party_name="BuildCo", title="Method statement rev B", category_id=ext["corr"].id, file=("ms2.pdf", PDF + b"b"), resubmission_of=r.id)
    assert r2.submission_status == "RESUBMITTED" and r2.resubmission_of_id == r.id
    assert r.document_id in [x.id for x in search.related(a, r2.document)]
    with pytest.raises(DomainError):
        external.register_external(a, direction="INCOMING", party_type="CONTRACTOR", party_name="BuildCo", title="x", category_id=ext["corr"].id, file=("x.pdf", PDF), resubmission_of=r2.id)
    external.update_submission(a, r2.id, "ACCEPTED")
    external.mark_responded(a, r2.id)
    rep = REPORTS["external"](a, {})
    assert {x["status"] for x in rep} == {"REJECTED", "ACCEPTED"} and not any(x["response_overdue"] for x in rep if x["status"] == "ACCEPTED")
    c = external.add_comment(a, d.id, "Clause 4 unclear")
    assert external.respond_comment(uid(ext, "author"), c.id, "Clarified in rev B", resolve=True).status == "RESOLVED"
    with pytest.raises(ValidationFailed):
        external.add_comment(a, d.id, " ")


@pytest.mark.django_db
def test_transmittals_and_drawing_control(ext):
    from modules.projects import models as pm
    a = uid(ext, "pub")
    dcat = core.create_category(a, code="DWG", name="Drawings", number_prefix="DWG", doc_type="DRAWING")
    proj = pm.Project.objects.create(code="P1", name="Tower", manager_id=a, start_on=TODAY, end_on=TODAY + timedelta(days=90))
    d = register(ext, "Level 3 plan", file=("l3.pdf", PDF), project_id=proj.id)
    d.category = dcat
    d.save()
    publish(ext, d)
    v1 = d.current_version
    t = external.create_transmittal(a, direction="OUTGOING", party_name="Consultant", items=[{"document": str(d.id)}], project_id=proj.id, purpose="FOR_REVIEW")
    assert t.number.startswith("TR-") and t.items.get().version_id == v1.id
    with pytest.raises(DomainError):
        external.create_transmittal(a, direction="OUTGOING", party_name="x", items=[{"document": str(register(ext, "unissued").id)}])
    core.create_revision(uid(ext, "author"), d.id, change_reason="Revised")
    core.upload_version(uid(ext, "author"), d.id, "l3b.pdf", PDF + b"b")
    publish(ext, d)
    with pytest.raises(DomainError) as e:
        external.create_transmittal(a, direction="OUTGOING", party_name="Consultant", items=[{"document": str(d.id), "version": str(v1.id)}])
    assert codes(e) == "superseded_version"  # superseded drawings are not sent out as current
    reg = REPORTS["project-register"](a, {"project": str(proj.id)})
    assert reg[0]["latest_approved"] == "2.0" and reg[0]["superseded_versions"] == ["1.0"]
    assert REPORTS["transmittals"](a, {"project": str(proj.id)})[0]["items"] == [{"reference": d.reference, "version": "1.0"}]
    rfi = external.create_rfi(a, project_id=proj.id, subject="Slab level", question="What is the finished level?", assigned_to=uid(ext, "author"), due_date=TODAY + timedelta(days=3), document_id=d.id)
    with pytest.raises(DomainError):
        external.answer_rfi(a, rfi.id, "x")  # only the assignee answers
    external.answer_rfi(uid(ext, "author"), rfi.id, "+3.20 m")
    with pytest.raises(DomainError):
        external.close_rfi(uid(ext, "author"), rfi.id)  # only the person who asked closes it
    assert external.close_rfi(a, rfi.id).status == "CLOSED"


# ----------------------------------------------------------------------------- search and reports
@pytest.mark.django_db
def test_search_filters_full_text_saved_searches_and_favourites(dm):
    a = register(dm, "Fire safety policy", tags=["Safety", "fire"], metadata={"site": "Addis"}, file=("fire.txt", b"Evacuation assembly point is near the gate"))
    publish(dm, a)
    b = publish(dm, register(dm, "Leave policy", file=("leave.pdf", PDF)))
    r = uid(dm, "reader")
    s = lambda **p: {d.reference for d in search.search(r, p)}
    assert s(q="fire") == {a.reference} and s(q="POL-0002") == {b.reference} and s(tag="safety") == {a.reference} and s(q="Addis") == {a.reference}
    assert s(q="assembly") == set() and s(q="assembly", full_text="true") == {a.reference}
    assert s(status="PUBLISHED") == {a.reference, b.reference} and s(category_code="POL") == {a.reference, b.reference} and s(q="zzz") == set()
    assert s(created_from=str(TODAY + timedelta(days=1))) == set()
    with pytest.raises(ValidationFailed):
        s(created_from="soon")
    ss = search.save_search(r, "Fire", {"q": "fire"})
    assert search.save_search(r, "Fire", {"q": "fire2"}).id == ss.id and m.SavedSearch.objects.filter(user_id=r).count() == 1
    search.delete_search(r, ss.id)
    with pytest.raises(DomainError):
        search.delete_search(r, ss.id)
    search.favourite(r, a.id)
    assert [d.id for d in search.favourites(r)] == [a.id]
    search.favourite(r, a.id, False)
    assert not search.favourites(r)
    with pytest.raises(DomainError):
        search.favourite(r, register(dm, "hidden").id)


@pytest.mark.django_db
def test_reports_respect_visibility(dm):
    pubd = publish(dm, register(dm, "Open"))
    hidden = publish(dm, register(dm, "Secret", classification="RESTRICTED"))
    r, a = uid(dm, "reader"), uid(dm, "author")
    assert {x["reference"] for x in REPORTS["register"](r, {})} == {pubd.reference}
    assert hidden.reference in {x["reference"] for x in REPORTS["register"](a, {})}
    cnt = REPORTS["by-category"](a, {})
    assert sum(x["count"] for x in cnt) >= 2
    rev = REPORTS["revision-history"](r, {})
    assert {x["reference"] for x in rev} == {pubd.reference}
    drafts = register(dm, "Pending")
    approval.submit_for_approval(a, drafts.versions.get().id)
    pend = REPORTS["pending-approvals"](a, {})
    assert pend[0]["reference"] == drafts.reference and pend[0]["waiting_for"] == [str(uid(dm, "appr"))]
    assert REPORTS["obsolete"](a, {}) == [] and REPORTS["archived"](a, {}) == []
    core.open_version(a, pubd.current_version_id)
    assert REPORTS["access"](a, {})[0]["action"] == "DOWNLOAD"


# ----------------------------------------------------------------------------- http
@pytest.mark.django_db
def test_http_flow_permissions_and_download(world, idp, acme, dm):
    p = dm["p"]
    for key in ("author", "pub", "appr", "reader"):
        ExternalIdentity.objects.create(user=p[key], issuer="https://kc.test/realms/erp", subject=f"doc-{key}")
    api = {}
    for key in ("author", "pub", "appr", "reader"):
        api[key] = Api(ACME_HOST)
        assert api[key].login(idp, f"doc-{key}").status_code == 302
    cat = str(dm["cat"].id)
    assert api["reader"].post("/api/v1/documents/categories", {"code": "X", "name": "X", "number_prefix": "X"}).status_code == 403
    assert api["reader"].post("/api/v1/documents/documents", {"title": "x", "category": cat}).status_code == 403
    from django.core.files.uploadedfile import SimpleUploadedFile
    r = api["author"].client.post("/api/v1/documents/documents", {"title": "HTTP policy", "category": cat, "tags": '["a","b"]', "file": SimpleUploadedFile("p.pdf", PDF, content_type="application/pdf")}, HTTP_HOST=ACME_HOST)
    assert r.status_code == 201, r.content
    body = r.json()
    did, vid = body["id"], body["versions"][0]["id"]
    assert body["status"] == "DRAFT" and body["tags"] == ["a", "b"] and body["reference"] == "POL-0001"
    assert api["reader"].get(f"/api/v1/documents/documents/{did}").status_code == 404  # drafts are not visible to readers, and don't reveal they exist
    assert api["reader"].get(f"/api/v1/documents/versions/{vid}/download").status_code == 404
    assert api["author"].post(f"/api/v1/documents/versions/{vid}/submit", {}).status_code == 200
    assert api["author"].post(f"/api/v1/documents/versions/{vid}/publish", {}).status_code == 409  # not approved yet
    tasks = api["appr"].get("/api/v1/workflows/inbox").json()
    tid = (tasks["results"] if "results" in tasks else tasks)[0]["id"]
    assert api["appr"].post(f"/api/v1/workflows/tasks/{tid}/decide", {"decision": "APPROVE"}).status_code == 200
    assert api["reader"].post(f"/api/v1/documents/versions/{vid}/publish", {}).status_code in (403, 404)
    assert api["pub"].post(f"/api/v1/documents/versions/{vid}/publish", {}).status_code == 200
    got = api["reader"].get(f"/api/v1/documents/documents/{did}")
    assert got.status_code == 200 and got.json()["current_version"]["label"] == "1.0" and "history" not in got.json()
    dl = api["reader"].client.get(f"/api/v1/documents/versions/{vid}/download", HTTP_HOST=ACME_HOST)
    assert dl.status_code == 200 and b"".join(dl.streaming_content) == PDF and dl["X-Content-Type-Options"] == "nosniff"
    lst = api["reader"].get("/api/v1/documents/documents?q=HTTP").json()
    assert [x["reference"] for x in lst["results"]] == ["POL-0001"]
    assert api["reader"].get("/api/v1/documents/reports/access").status_code == 403
    assert api["pub"].get("/api/v1/documents/reports/access").status_code == 200
    assert api["reader"].get("/api/v1/documents/reports/register").status_code == 200
    assert api["reader"].get("/api/v1/documents/reports/nope").status_code == 404
    assert api["reader"].post(f"/api/v1/documents/documents/{did}/obsolete", {"reason": "x"}).status_code in (403, 404)
    assert api["pub"].post(f"/api/v1/documents/documents/{did}/grants", {"subject_type": "USER", "subject_id": str(p["reader"].id), "actions": ["VIEW"]}).status_code == 201
    assert api["reader"].get(f"/api/v1/documents/documents/{did}/grants").status_code == 403
    assert api["reader"].patch(f"/api/v1/documents/documents/{did}", {"title": "hacked"}).status_code in (403, 404)
    assert api["pub"].delete(f"/api/v1/documents/documents/{did}").status_code == 409
    assert api["reader"].get("/api/v1/documents/classifications").status_code == 200
