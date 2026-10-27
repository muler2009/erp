import pytest

from tests.conftest import ACME_HOST, PLATFORM_HOST, Api


@pytest.mark.django_db
def test_world_is_provisioned(world, acme):
    assert acme["schema"] == "t_acme"


@pytest.mark.django_db
def test_owner_login_and_me(owner_api, acme):
    response = owner_api.get("/api/v1/me")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["tenant"]["slug"] == "acme"
    assert "users.create" in body["permissions"]


@pytest.mark.django_db
def test_platform_admin_login_and_me(platform_api):
    response = platform_api.get("/api/v1/platform/me")
    assert response.status_code == 200, response.content
    assert "platform.tenants.create" in response.json()["permissions"]
