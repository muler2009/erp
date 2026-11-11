from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.projects import models as pm
from modules.projects import services as svc
from modules.projects import wbs as tk
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, Api
from tests.test_finance import user

S, E = date(2026, 3, 2), date(2026, 6, 30)


def codes(e):
    return e.value.get_codes()


def master(tenant):
    p = dict(pm=user(tenant, f"pm@{tenant.slug}.test", "project_manager"), pm2=user(tenant, f"pm2@{tenant.slug}.test", "project_manager"), dev=user(tenant, f"dev@{tenant.slug}.test", "employee"), dev2=user(tenant, f"dev2@{tenant.slug}.test", "employee"),
             outsider=user(tenant, f"out@{tenant.slug}.test", "employee"), auditor=user(tenant, f"paud@{tenant.slug}.test", "read_only_auditor"), owner=user(tenant, f"powner@{tenant.slug}.test", "tenant_owner"))
    proj = svc.create_project(p["pm"].id, name="Office build", start_on=S, end_on=E)
    svc.add_member(p["pm"].id, proj.id, p["dev"].id, cost_rate="20")
    svc.add_member(p["pm"].id, proj.id, p["dev2"].id)
    return {"people": p, "p": proj}


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield master(tenant)


@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = master(tenant)
    apis = {}
    for key in ("pm", "dev", "outsider", "auditor", "owner"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"pj-{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"pj-{key}-sub").status_code == 302
    return env, apis


def uid(f, k="pm"):
    return f["people"][k].id


def task(f, name, a, b, **kw):
    return tk.create_task(uid(f), f["p"].id, name=name, planned_start=S + timedelta(days=a), planned_end=S + timedelta(days=b), **kw)


@pytest.mark.django_db
def test_project_creation_numbers_manager_and_validates(f):
    p = f["p"]
    assert p.code.startswith("PRJ-2026-") and p.manager_id == uid(f)
    assert pm.ProjectMember.objects.get(project=p, role="MANAGER").user_id == uid(f)
    with pytest.raises(ValidationFailed) as e:
        svc.create_project(uid(f), name="x", start_on=E, end_on=S)
    assert codes(e) == "invalid_dates"
    with pytest.raises(ValidationFailed) as e:
        svc.create_project(uid(f), name="x", start_on=S, end_on=E, billing_type="NON_BILLABLE", contract_value=5)
    assert codes(e) == "invalid_amount"
    import uuid
    with pytest.raises(ValidationFailed) as e:
        svc.create_project(uid(f), name="x", start_on=S, end_on=E, manager_id=uuid.uuid4())
    assert codes(e) == "invalid_manager"


@pytest.mark.django_db
def test_visibility_and_management_are_object_level(f):
    p, pe = f["p"], f["people"]
    assert svc.can_view(pe["dev"].id, p) and not svc.can_view(pe["outsider"].id, p)
    assert svc.can_view(pe["auditor"].id, p) and not svc.can_manage(pe["auditor"].id, p)
    assert svc.can_manage(pe["owner"].id, p) and not svc.can_manage(pe["dev"].id, p)
    assert list(svc.visible_projects(pe["outsider"].id)) == [] and list(svc.visible_projects(pe["dev"].id)) == [p]
    with pytest.raises(DomainError) as e:
        svc.require_view(pe["outsider"].id, p.id)
    assert codes(e) == "not_found"  # existence is not revealed
    with pytest.raises(DomainError) as e:
        svc.update_project(pe["dev"].id, p.id, name="hijack")
    assert codes(e) == "forbidden"
    with pytest.raises(DomainError) as e:
        svc.update_project(pe["pm"].id, p.id, manager_id=pe["pm2"].id)
    assert codes(e) == "forbidden"  # handing over needs a project administrator
    svc.update_project(pe["owner"].id, p.id, manager_id=pe["pm2"].id)
    assert svc.can_manage(pe["pm2"].id, p)


@pytest.mark.django_db
def test_team_rules(f):
    p, pe = f["p"], f["people"]
    with pytest.raises(DomainError) as e:
        svc.add_member(uid(f), p.id, pe["dev"].id)
    assert codes(e) == "already_pending"
    with pytest.raises(DomainError):
        svc.remove_member(uid(f), p.id, pe["pm"].id)
    obs = svc.add_member(uid(f), p.id, pe["outsider"].id, role="OBSERVER")
    with pytest.raises(ValidationFailed) as e:
        task(f, "x", 0, 1, assignee_id=pe["outsider"].id)
    assert codes(e) == "invalid_assignee"
    t = task(f, "Build", 0, 5, assignee_id=pe["dev"].id)
    with pytest.raises(DomainError) as e:
        svc.remove_member(uid(f), p.id, pe["dev"].id)
    assert codes(e) == "tasks_assigned"
    svc.remove_member(uid(f), p.id, pe["outsider"].id)
    assert not svc.can_view(pe["outsider"].id, p)
    with pytest.raises(ValidationFailed):
        svc.add_member(uid(f), p.id, pe["outsider"].id, allocation_percent=150)


@pytest.mark.django_db
def test_wbs_codes_rollup_and_limits(f):
    parent = task(f, "Phase 1", 0, 10)
    a = task(f, "A", 0, 4, parent_id=parent.id, planned_hours=10)
    b = task(f, "B", 5, 10, parent_id=parent.id, planned_hours=30)
    sub = task(f, "B1", 5, 7, parent_id=b.id, planned_hours=30)
    assert (parent.wbs_code, a.wbs_code, b.wbs_code, sub.wbs_code) == ("1", "1.1", "1.2", "1.2.1")
    parent.refresh_from_db()
    assert parent.planned_hours == 40 and (parent.planned_start, parent.planned_end) == (S, S + timedelta(days=7))  # B takes B1 dates
    with pytest.raises(DomainError) as e:
        tk.update_task(uid(f), parent.id, planned_end=S + timedelta(days=20))
    assert codes(e) == "summary_derived"
    ms = task(f, "Handover", 20, 20, is_milestone=True)
    with pytest.raises(ValidationFailed):
        task(f, "child of milestone", 20, 20, parent_id=ms.id)
    with pytest.raises(ValidationFailed) as e:
        tk.create_task(uid(f), f["p"].id, name="late", planned_start=E, planned_end=E + timedelta(days=1))
    assert codes(e) == "outside_project_dates"
    deep = parent
    for i in range(5):
        deep = task(f, f"L{i}", 0, 1, parent_id=deep.id)
    with pytest.raises(ValidationFailed) as e:
        task(f, "too deep", 0, 1, parent_id=deep.id)
    assert codes(e) == "too_deep"


@pytest.mark.django_db
def test_dependencies_cycles_and_schedule_integrity(f):
    a, b, c = task(f, "A", 0, 4), task(f, "B", 5, 9), task(f, "C", 10, 14)
    tk.add_dependency(uid(f), a.id, b.id)
    tk.add_dependency(uid(f), b.id, c.id)
    with pytest.raises(DomainError) as e:
        tk.add_dependency(uid(f), c.id, a.id)
    assert codes(e) == "circular_dependency"
    with pytest.raises(DomainError) as e:
        tk.add_dependency(uid(f), a.id, b.id)
    assert codes(e) == "already_pending"
    with pytest.raises(ValidationFailed):
        tk.add_dependency(uid(f), a.id, a.id)
    with pytest.raises(DomainError) as e:
        tk.update_task(uid(f), b.id, planned_start=S + timedelta(days=3), planned_end=S + timedelta(days=8))
    assert codes(e) == "dependency_violated"
    d = task(f, "D", 0, 2)
    with pytest.raises(DomainError) as e:
        tk.add_dependency(uid(f), c.id, d.id)  # D starts before C finishes
    assert codes(e) == "dependency_violated"


@pytest.mark.django_db
def test_shift_cascades_and_critical_path(f):
    a, b, c, side = task(f, "A", 0, 4), task(f, "B", 5, 9), task(f, "C", 10, 14), task(f, "Side", 0, 2)
    tk.add_dependency(uid(f), a.id, b.id)
    tk.add_dependency(uid(f), b.id, c.id)
    g = tk.schedule(f["p"].id)
    assert g["critical_path"] == ["1", "2", "3"]
    by = {r["wbs"]: r for r in g["tasks"]}
    assert by["4"]["slack_days"] == 12 and by["4"]["critical"] is False
    moved = tk.shift_task(uid(f), a.id, 3)
    assert {t.wbs_code for t in moved} == {"1", "2", "3"}
    c.refresh_from_db()
    assert c.planned_start == S + timedelta(days=13)
    with pytest.raises(ValidationFailed):
        tk.shift_task(uid(f), c.id, 200)  # leaves the project window


@pytest.mark.django_db
def test_progress_rules_status_percent_agree_and_dependencies_gate_work(f):
    pe = f["people"]
    a, b = task(f, "A", 0, 4, assignee_id=pe["dev"].id), task(f, "B", 5, 9, assignee_id=pe["dev2"].id)
    tk.add_dependency(uid(f), a.id, b.id)
    with pytest.raises(DomainError) as e:
        tk.update_progress(pe["dev"].id, a.id, percent=50)
    assert codes(e) == "project_not_active"
    svc.set_status(uid(f), f["p"].id, "ACTIVE")
    with pytest.raises(DomainError) as e:
        tk.update_progress(pe["dev2"].id, a.id, percent=10)
    assert codes(e) == "forbidden"  # not the assignee
    with pytest.raises(DomainError) as e:
        tk.update_progress(pe["dev2"].id, b.id, status="IN_PROGRESS")
    assert codes(e) == "predecessor_open"
    t = tk.update_progress(pe["dev"].id, a.id, percent=40)
    assert t.status == "IN_PROGRESS" and t.actual_start is not None
    with pytest.raises(ValidationFailed):
        tk.update_progress(pe["dev"].id, a.id, status="BLOCKED")
    with pytest.raises(ValidationFailed):
        tk.update_progress(pe["dev"].id, a.id, status="IN_PROGRESS", percent=100)
    assert tk.update_progress(pe["dev"].id, a.id, percent=100).status == "DONE"
    assert tk.update_progress(pe["dev2"].id, b.id, status="IN_PROGRESS").status == "IN_PROGRESS"
    with pytest.raises(ValidationFailed):
        tk.update_progress(pe["dev"].id, a.id, status="IN_PROGRESS")  # reopening needs a percentage
    assert tk.update_progress(pe["dev"].id, a.id, status="IN_PROGRESS", percent=90).actual_end is None
    with pytest.raises(DomainError) as e:
        tk.update_progress(pe["dev"].id, a.id, status="CANCELLED")
    assert codes(e) == "forbidden"  # only the manager cancels


@pytest.mark.django_db
def test_summary_progress_rolls_up_by_hours_and_project_completion_needs_all_done(f):
    pe = f["people"]
    par = task(f, "Phase", 0, 10)
    a = task(f, "A", 0, 4, parent_id=par.id, planned_hours=10, assignee_id=pe["dev"].id)
    b = task(f, "B", 5, 10, parent_id=par.id, planned_hours=30, assignee_id=pe["dev"].id)
    svc.set_status(uid(f), f["p"].id, "ACTIVE")
    tk.update_progress(pe["dev"].id, a.id, percent=100)
    par.refresh_from_db()
    assert par.percent_complete == D("25.00") and par.status == "IN_PROGRESS"
    with pytest.raises(DomainError) as e:
        svc.set_status(uid(f), f["p"].id, "COMPLETED")
    assert codes(e) == "tasks_open"
    with pytest.raises(DomainError):
        tk.update_progress(uid(f), par.id, percent=50)
    tk.update_progress(pe["dev"].id, b.id, percent=100)
    par.refresh_from_db()
    assert par.status == "DONE"
    done = svc.set_status(uid(f), f["p"].id, "COMPLETED")
    assert done.actual_end is not None
    with pytest.raises(DomainError) as e:
        tk.create_task(uid(f), f["p"].id, name="late", planned_start=S, planned_end=S)
    assert codes(e) == "project_closed"
    with pytest.raises(DomainError):
        svc.set_status(uid(f), f["p"].id, "ACTIVE")


@pytest.mark.django_db
def test_task_delete_rules(f):
    par = task(f, "P", 0, 5)
    kid = task(f, "K", 0, 5, parent_id=par.id)
    with pytest.raises(DomainError) as e:
        tk.delete_task(uid(f), par.id)
    assert codes(e) == "has_children"
    tk.delete_task(uid(f), kid.id)
    assert not pm.Task.objects.filter(pk=kid.id).exists()


@pytest.mark.django_db
def test_http_permissions_and_visibility(api_env):
    env, api = api_env
    pid = str(env["p"].id)
    body = {"name": "New", "start_on": "2026-03-02", "end_on": "2026-04-02"}
    assert api["dev"].post("/api/v1/projects/projects", body).status_code == 403  # employees cannot create
    assert api["pm"].post("/api/v1/projects/projects", body).status_code == 201
    assert api["outsider"].get(f"/api/v1/projects/projects/{pid}").status_code == 404
    assert [r["id"] for r in api["outsider"].get("/api/v1/projects/projects").json()["results"]] == []
    assert api["dev"].get(f"/api/v1/projects/projects/{pid}").status_code == 200
    assert api["auditor"].get(f"/api/v1/projects/projects/{pid}/gantt").status_code == 200
    assert api["dev"].patch(f"/api/v1/projects/projects/{pid}", {"name": "x"}).status_code == 403
    assert api["auditor"].post(f"/api/v1/projects/projects/{pid}/tasks", {"name": "t", "planned_start": "2026-03-02", "planned_end": "2026-03-03"}).status_code == 403
    r = api["pm"].post(f"/api/v1/projects/projects/{pid}/tasks", {"name": "t", "planned_start": "2026-03-02", "planned_end": "2026-03-03", "assignee": str(env["people"]["dev"].id)})
    assert r.status_code == 201
    tid = r.json()["id"]
    assert api["pm"].post(f"/api/v1/projects/projects/{pid}/status", {"status": "ACTIVE"}).status_code == 200
    assert api["dev"].post(f"/api/v1/projects/tasks/{tid}/progress", {"percent": 30}).status_code == 200
    assert api["outsider"].post(f"/api/v1/projects/tasks/{tid}/progress", {"percent": 90}).status_code == 404
    assert [t["id"] for t in api["dev"].get("/api/v1/projects/my-tasks").json()["results"]] == [tid]
