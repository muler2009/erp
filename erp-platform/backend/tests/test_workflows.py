import threading
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError, connection, connections, transaction
from django.utils import timezone
from django_tenants.utils import schema_context

from platform_core.authorization.models import RoleAssignment, RoleDefinition
from platform_core.organizations.models import Department
from platform_core.tenants.models import Tenant
from platform_core.users.models import TenantMembership, User
from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import OutboxEvent
from shared.notifications.models import Notification
from shared.workflows import services as wf
from shared.workflows.models import ApprovalTask, WorkflowAction, WorkflowInstance

SUBJECT = "purchase_order"
wf.register_subject(SUBJECT)


def code_of(exc):
    return exc.value.detail[0].code if isinstance(exc.value.detail, list) else exc.value.get_codes()


def make_user(tenant, email, *roles):
    user = User.objects.create_user(email, email.split("@")[0])
    TenantMembership.objects.create(user=user, tenant=tenant, status="ACTIVE")
    for name in roles:
        RoleAssignment.objects.create(user_id=user.id, role=RoleDefinition.objects.get(name=name))
    return user


@pytest.fixture
def env(acme):
    """Users and a default three-step PO chain inside the acme schema."""
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        people = {
            "req": make_user(tenant, "req@acme.test", "employee"),
            "proc": make_user(tenant, "proc@acme.test", "procurement_manager"),
            "fin": make_user(tenant, "fin@acme.test", "finance_manager"),
            "fin2": make_user(tenant, "fin2@acme.test", "finance_manager"),
            "ctrl": make_user(tenant, "ctrl@acme.test", "finance_controller"),
            "other": make_user(tenant, "other@acme.test", "employee"),
        }
        yield people


def chain(env, **kw):
    return wf.create_definition(
        env["ctrl"].id, code="po-approval", name="PO approval", subject_type=SUBJECT,
        stages=[
            {"order": 1, "name": "Procurement", "approvers": [{"type": "ROLE", "ref": "procurement_manager"}]},
            {"order": 2, "name": "Finance", "policy": "ANY_OF", "approvers": [{"type": "ROLE", "ref": "finance_manager"}]},
            {"order": 3, "name": "Final", "approvers": [{"type": "USER", "ref": str(env["ctrl"].id)}], "min_amount": "10000"},
        ], **kw,
    )


def pending(instance, user):
    return ApprovalTask.objects.get(instance=instance, assignee_id=user.id, status="PENDING")


@pytest.mark.django_db
def test_sequential_chain_with_amount_threshold_and_completion_event(env, acme):
    chain(env)
    small = wf.submit(env["req"].id, SUBJECT, "PO-1", amount="500", title="Small PO")
    assert small.stage_orders == [1, 2]  # threshold stage skipped for small amounts
    wf.decide(env["proc"].id, pending(small, env["proc"]).id, "APPROVE")
    assert not ApprovalTask.objects.filter(instance=small, assignee_id=env["fin"].id).exclude(status="PENDING").exists()
    done = wf.decide(env["fin"].id, pending(small, env["fin"]).id, "APPROVE")
    assert done.status == "APPROVED" and done.completed_at
    assert OutboxEvent.objects.filter(event_type="workflow.approval.completed", payload__subject_id="PO-1", payload__outcome="APPROVED").count() == 1
    assert ApprovalTask.objects.get(instance=small, assignee_id=env["fin2"].id).status == "SKIPPED"  # ANY_OF satisfied

    big = wf.submit(env["req"].id, SUBJECT, "PO-2", amount="25000")
    assert big.stage_orders == [1, 2, 3]
    wf.decide(env["proc"].id, pending(big, env["proc"]).id, "APPROVE")
    wf.decide(env["fin2"].id, pending(big, env["fin2"]).id, "APPROVE")
    assert WorkflowInstance.objects.get(pk=big.pk).status == "PENDING"
    wf.decide(env["ctrl"].id, pending(big, env["ctrl"]).id, "APPROVE")
    assert WorkflowInstance.objects.get(pk=big.pk).status == "APPROVED"
    actions = list(big.actions.values_list("action", flat=True))
    assert actions[0] == "SUBMITTED" and actions[-1] == "COMPLETED" and actions.count("APPROVED") == 3


@pytest.mark.django_db
def test_all_of_policy_needs_every_approver(env):
    wf.create_definition(env["ctrl"].id, code="x", name="x", subject_type=SUBJECT, stages=[{"order": 1, "policy": "ALL_OF", "approvers": [{"type": "ROLE", "ref": "finance_manager"}]}])
    inst = wf.submit(env["req"].id, SUBJECT, "PO-3")
    wf.decide(env["fin"].id, pending(inst, env["fin"]).id, "APPROVE")
    assert WorkflowInstance.objects.get(pk=inst.pk).status == "PENDING"
    wf.decide(env["fin2"].id, pending(inst, env["fin2"]).id, "APPROVE")
    assert WorkflowInstance.objects.get(pk=inst.pk).status == "APPROVED"


@pytest.mark.django_db
def test_reject_cancels_remaining_and_requires_comment(env):
    chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-4", amount="1")
    task = pending(inst, env["proc"])
    with pytest.raises(ValidationFailed):
        wf.decide(env["proc"].id, task.id, "REJECT", "")
    done = wf.decide(env["proc"].id, task.id, "REJECT", "Over budget")
    assert done.status == "REJECTED"
    assert not ApprovalTask.objects.filter(instance=inst, status="PENDING").exists()
    with pytest.raises(DomainError):  # nothing more can happen
        wf.decide(env["proc"].id, task.id, "APPROVE")


@pytest.mark.django_db
def test_request_changes_and_resubmission_restarts_chain(env):
    chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-5", amount="500")
    wf.decide(env["proc"].id, pending(inst, env["proc"]).id, "APPROVE")
    wf.decide(env["fin"].id, pending(inst, env["fin"]).id, "REQUEST_CHANGES", "Add supplier quote")
    inst.refresh_from_db()
    assert inst.status == "CHANGES_REQUESTED"
    with pytest.raises(DomainError) as e:
        wf.resubmit(env["other"].id, inst.id)
    assert e.value.status_code == 404  # only the requester
    again = wf.resubmit(env["req"].id, inst.id, comment="Quote attached", amount="20000")
    assert again.round == 2 and again.status == "PENDING" and again.stage_orders == [1, 2, 3]
    assert pending(again, env["proc"]).round == 2
    assert [a.action for a in again.actions.all()].count("RESUBMITTED") == 1


@pytest.mark.django_db
def test_self_approval_blocked_by_separation_of_duties(env, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    both = make_user(tenant, "both@acme.test", "procurement_manager")
    chain(env)
    inst = wf.submit(both.id, SUBJECT, "PO-6", amount="1")
    assert not ApprovalTask.objects.filter(instance=inst, assignee_id=both.id).exists()  # never even assigned
    # With SoD disabled the requester may approve.
    wf.create_definition(env["ctrl"].id, code="po-approval", name="PO approval", subject_type=SUBJECT, separation_of_duties=False, stages=[{"order": 1, "approvers": [{"type": "USER", "ref": str(both.id)}]}])
    inst2 = wf.submit(both.id, SUBJECT, "PO-7")
    assert wf.decide(both.id, pending(inst2, both).id, "APPROVE").status == "APPROVED"


@pytest.mark.django_db
def test_wrong_user_and_duplicate_decisions(env):
    chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-8", amount="1")
    task = pending(inst, env["proc"])
    with pytest.raises(DomainError) as e:
        wf.decide(env["other"].id, task.id, "APPROVE")
    assert e.value.status_code == 404
    wf.decide(env["proc"].id, task.id, "APPROVE")
    with pytest.raises(DomainError) as dup:
        wf.decide(env["proc"].id, task.id, "APPROVE")
    assert dup.value.get_codes() == "already_decided"


@pytest.mark.django_db
def test_one_active_instance_per_subject(env):
    chain(env)
    wf.submit(env["req"].id, SUBJECT, "PO-9", amount="1")
    with pytest.raises(DomainError) as e:
        wf.submit(env["req"].id, SUBJECT, "PO-9", amount="1")
    assert e.value.get_codes() == "already_in_flight"


@pytest.mark.django_db
def test_delegation_rules(env):
    chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-10", amount="1")
    task = pending(inst, env["proc"])
    with pytest.raises(DomainError) as e:
        wf.delegate(env["proc"].id, task.id, env["req"].id)  # requester cannot be delegate
    assert e.value.get_codes() == "separation_of_duties"
    with pytest.raises(ValidationFailed):
        wf.delegate(env["proc"].id, task.id, env["proc"].id)
    wf.delegate(env["proc"].id, task.id, env["other"].id, "on leave")
    task.refresh_from_db()
    assert task.status == "DELEGATED"
    with pytest.raises(DomainError):
        wf.decide(env["proc"].id, task.id, "APPROVE")  # delegator lost authority
    new = pending(inst, env["other"])
    assert new.handed_over_from == env["proc"].id
    wf.decide(env["other"].id, new.id, "APPROVE")
    assert pending(inst, env["fin"])  # advanced to finance
    assert "DELEGATED" in inst.actions.values_list("action", flat=True)
    assert Notification.objects.filter(user_id=env["other"].id, notification_type="workflow.approval_requested").exists()


@pytest.mark.django_db
def test_escalation_hands_overdue_task_to_escalation_user_once(env):
    wf.create_definition(env["ctrl"].id, code="esc", name="esc", subject_type=SUBJECT, stages=[{"order": 1, "due_hours": 1, "escalate_to_user_id": str(env["ctrl"].id), "approvers": [{"type": "USER", "ref": str(env["proc"].id)}]}])
    inst = wf.submit(env["req"].id, SUBJECT, "PO-11")
    assert wf.escalate_overdue() == 0  # not overdue yet
    ApprovalTask.objects.filter(instance=inst).update(due_at=timezone.now() - timedelta(minutes=1))
    assert wf.escalate_overdue() == 1 and wf.escalate_overdue() == 0
    assert ApprovalTask.objects.get(instance=inst, assignee_id=env["proc"].id).status == "ESCALATED"
    esc = pending(inst, env["ctrl"])
    assert wf.decide(env["ctrl"].id, esc.id, "APPROVE").status == "APPROVED"
    assert "ESCALATED" in inst.actions.values_list("action", flat=True)


@pytest.mark.django_db
def test_cancel_and_permissions(env):
    chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-12", amount="1")
    with pytest.raises(DomainError) as e:
        wf.cancel(env["other"].id, inst.id)
    assert e.value.status_code == 404
    assert wf.cancel(env["req"].id, inst.id).status == "CANCELLED"
    assert not ApprovalTask.objects.filter(instance=inst, status="PENDING").exists()
    with pytest.raises(DomainError):
        wf.cancel(env["req"].id, inst.id)


@pytest.mark.django_db
def test_definition_validation_and_versioning(env):
    with pytest.raises(ValidationFailed):
        wf.create_definition(env["ctrl"].id, code="bad", name="b", subject_type="nope", stages=[{"approvers": [{"type": "USER", "ref": "x"}]}])
    with pytest.raises(ValidationFailed):
        wf.create_definition(env["ctrl"].id, code="bad", name="b", subject_type=SUBJECT, stages=[{"policy": "SOME_OF", "approvers": [{"type": "USER", "ref": "x"}]}])
    with pytest.raises(ValidationFailed):
        wf.create_definition(env["ctrl"].id, code="bad", name="b", subject_type=SUBJECT, stages=[{"approvers": [{"type": "ROLE", "ref": "no_such_role"}]}])
    v1 = chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-13", amount="1")
    v2 = chain(env)
    assert (v1.version, v2.version) == (1, 2)
    v1.refresh_from_db()
    assert not v1.is_active and inst.definition_id == v1.id  # in-flight instance keeps its version
    with pytest.raises(IntegrityError), transaction.atomic():
        v1.is_active = True
        v1.save()  # two active versions for one subject type is impossible


@pytest.mark.django_db
def test_no_eligible_approver_fails_at_submission(env):
    wf.create_definition(env["ctrl"].id, code="e", name="e", subject_type=SUBJECT, stages=[{"order": 1, "approvers": [{"type": "ROLE", "ref": "warehouse_staff"}]}])
    with pytest.raises(DomainError) as e:
        wf.submit(env["req"].id, SUBJECT, "PO-14")
    assert e.value.get_codes() == "no_eligible_approvers"
    assert not WorkflowInstance.objects.filter(subject_id="PO-14").exists()  # rolled back, no half-created request


@pytest.mark.django_db
def test_department_head_and_manager_resolution(env, acme):
    from platform_core.organizations.models import TenantUserProfile

    dept = Department.objects.create(code="OPS", name="Ops", head_user_id=env["fin"].id)
    TenantUserProfile.objects.create(user_id=env["req"].id, manager_user_id=env["proc"].id)
    wf.create_definition(env["ctrl"].id, code="d", name="d", subject_type=SUBJECT, stages=[{"order": 1, "approvers": [{"type": "DEPARTMENT_HEAD"}]}, {"order": 2, "approvers": [{"type": "MANAGER"}]}])
    inst = wf.submit(env["req"].id, SUBJECT, "PO-15", department_id=dept.id)
    wf.decide(env["fin"].id, pending(inst, env["fin"]).id, "APPROVE")
    assert wf.decide(env["proc"].id, pending(inst, env["proc"]).id, "APPROVE").status == "APPROVED"


@pytest.mark.django_db
def test_action_history_is_append_only(env):
    chain(env)
    inst = wf.submit(env["req"].id, SUBJECT, "PO-16", amount="1")
    action = WorkflowAction.objects.filter(instance=inst).first()
    with pytest.raises(Exception, match="append-only"), transaction.atomic():
        WorkflowAction.objects.filter(pk=action.pk).update(comment="tampered")
    with pytest.raises(Exception, match="append-only"), transaction.atomic():
        action.delete()


@pytest.mark.django_db
def test_workflow_api_inbox_decide_and_visibility(env, acme, world, idp):
    from tests.conftest import ACME_HOST, Api

    chain(env)
    from platform_core.users.models import ExternalIdentity

    ExternalIdentity.objects.create(user=env["proc"], issuer="https://kc.test/realms/erp", subject="proc-sub")
    ExternalIdentity.objects.create(user=env["other"], issuer="https://kc.test/realms/erp", subject="other-sub")
    inst = wf.submit(env["req"].id, SUBJECT, "PO-17", amount="1", title="Laptops")
    proc_api, other_api = Api(ACME_HOST), Api(ACME_HOST)
    assert proc_api.login(idp, "proc-sub").status_code == 302 and other_api.login(idp, "other-sub").status_code == 302
    box = proc_api.get("/api/v1/workflows/inbox").json()["results"]
    assert [t["title"] for t in box] == ["Laptops"]
    assert other_api.get("/api/v1/workflows/inbox").json()["results"] == []
    assert other_api.get(f"/api/v1/workflows/instances/{inst.id}").status_code == 404  # not involved
    assert other_api.post(f"/api/v1/workflows/tasks/{box[0]['id']}/decide", {"decision": "APPROVE"}).status_code == 404
    assert other_api.get("/api/v1/workflows/definitions").status_code == 403  # needs workflow.definitions.manage
    detail = proc_api.get(f"/api/v1/workflows/instances/{inst.id}").json()
    assert detail["status"] == "PENDING" and detail["history"][0]["action"] == "SUBMITTED"
    ok = proc_api.post(f"/api/v1/workflows/tasks/{box[0]['id']}/decide", {"decision": "APPROVE", "comment": "ok"})
    assert ok.status_code == 200
    assert proc_api.post(f"/api/v1/workflows/tasks/{box[0]['id']}/decide", {"decision": "APPROVE"}).status_code == 409  # duplicate


@pytest.mark.django_db
def test_definition_admin_api(owner_api, acme):
    created = owner_api.post("/api/v1/workflows/definitions", {"code": "gen", "name": "Generic", "subject_type": "generic", "stages": [{"order": 1, "approvers": [{"type": "ROLE", "ref": "tenant_admin"}]}]})
    assert created.status_code == 201 and created.json()["version"] == 1
    assert owner_api.get("/api/v1/workflows/definitions?active=true").json()["results"][0]["code"] == "gen"
    assert "generic" in owner_api.get("/api/v1/workflows/subject-types").json()["subject_types"]
    bad = owner_api.post("/api/v1/workflows/definitions", {"code": "gen2", "name": "x", "subject_type": "unknown", "stages": [{"approvers": [{"type": "USER", "ref": "x"}]}]})
    assert bad.status_code == 400


@pytest.mark.django_db(transaction=True)
def test_concurrent_approvals_only_one_wins(own_tenant):
    tenant = own_tenant("wfrace")
    with schema_context(tenant.schema_name):
        req = make_user(tenant, "r@race.test", "employee")
        approvers = [make_user(tenant, f"a{i}@race.test", "finance_manager") for i in range(2)]
        wf.create_definition(req.id, code="race", name="race", subject_type=SUBJECT, stages=[{"order": 1, "policy": "ALL_OF", "approvers": [{"type": "ROLE", "ref": "finance_manager"}]}, {"order": 2, "approvers": [{"type": "USER", "ref": str(approvers[0].id)}]}], distinct_approvers=False)
        inst = wf.submit(req.id, SUBJECT, "RACE-1")
        task = ApprovalTask.objects.get(instance=inst, assignee_id=approvers[0].id)
    results = []

    def go():
        try:
            with schema_context(tenant.schema_name):
                wf.decide(approvers[0].id, task.id, "APPROVE")
            results.append("ok")
        except DomainError as exc:
            results.append(exc.get_codes())
        finally:
            connections.close_all()

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["already_decided"] * 5 + ["ok"]
    with schema_context(tenant.schema_name):
        assert WorkflowAction.objects.filter(instance=inst, action="APPROVED").count() == 1
