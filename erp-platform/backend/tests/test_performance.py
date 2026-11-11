"""Query budgets for pages that fan out. These fail when someone reintroduces a per-row permission or
snapshot query (the classic N+1), which is what makes list pages slow as a tenant grows."""
import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from modules.analytics import dashboards, kpis, registry
from modules.analytics import models as m
from tests.test_analytics import an, sales_f, sc_f, uid  # noqa: F401

pytestmark = pytest.mark.django_db


def queries(fn):
    with CaptureQueriesContext(connection) as c:
        out = fn()
    return out, len(c)


def test_kpi_list_does_not_query_per_permission(an):
    kpis.daily()
    for who in ("exec", "fin", "qm"):
        out, n = queries(lambda: kpis.list_kpis(uid(an, who)))
        assert len(out) >= 20
        assert n <= 2 * len(out) + 10, f"{who}: {n} queries for {len(out)} KPIs"


def test_dashboard_view_query_budget(an):
    kpis.daily()
    d = m.Dashboard.objects.get(code="executive")
    widgets = d.widgets.count()
    for who in ("exec", "fin", "qm"):
        _, n = queries(lambda: dashboards.view(uid(an, who), d.id))
        assert n <= 5 * widgets + 20, f"{who}: {n} queries for {widgets} widgets"


def test_catalog_is_constant_queries(an):
    _, n = queries(lambda: registry.catalog_for(uid(an, "exec")))
    assert n <= 5


def test_perms_helper_matches_the_authorization_service(an):
    """The batch permission helper must agree with the real check for every permission."""
    from platform_core.authorization import services as authz
    from platform_core.catalog import PERMISSIONS
    from modules.analytics import core
    for who in ("exec", "fin", "emp", "qm"):
        p = core.Perms(uid(an, who))
        for perm in PERMISSIONS:
            assert p.can(perm.code) == authz.has_permission(uid(an, who), perm.code), (who, perm.code)
