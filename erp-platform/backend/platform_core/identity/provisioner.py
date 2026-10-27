"""Keycloak administration, used ONLY by tenant provisioning / user lifecycle code (never by modules).

The service account behind KEYCLOAK_ADMIN is a dedicated confidential client with narrow roles
(manage-users, manage-clients on the erp realm), not a realm admin.
"""
from dataclasses import dataclass

import requests
from django.conf import settings
from django.utils.module_loading import import_string

REQUIRED_ACTIONS = ["VERIFY_EMAIL", "UPDATE_PASSWORD", "CONFIGURE_TOTP"]


@dataclass
class EnsureUserResult:
    subject: str
    created: bool  # True only if this call created the Keycloak account (so the subject is known-fresh)


class IdentityProvisioner:
    def ensure_user(self, email: str, display_name: str) -> EnsureUserResult:
        raise NotImplementedError

    def send_required_actions_email(self, subject: str) -> None:
        raise NotImplementedError

    def register_redirect_uris(self, redirect_uri: str, post_logout_uri: str) -> None:
        raise NotImplementedError

    def disable_user(self, subject: str) -> None:
        raise NotImplementedError


def get_provisioner() -> IdentityProvisioner:
    return import_string(settings.IDENTITY_PROVISIONER)()


class KeycloakAdminClient(IdentityProvisioner):
    """Keycloak Admin REST API client.

    NOTE: exercised in this repository only against a fake in unit tests; it has not been run against
    a live Keycloak server (see docs/operations/phase1-status.md).
    """

    timeout = 10

    def __init__(self):
        self.cfg = settings.KEYCLOAK_ADMIN
        self.base = f"{self.cfg['BASE_URL'].rstrip('/')}/admin/realms/{self.cfg['REALM']}"

    def _token(self):
        url = f"{self.cfg['BASE_URL'].rstrip('/')}/realms/{self.cfg['REALM']}/protocol/openid-connect/token"
        response = requests.post(
            url,
            data={"grant_type": "client_credentials", "client_id": self.cfg["CLIENT_ID"], "client_secret": self.cfg["CLIENT_SECRET"]},
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()["access_token"]

    def _headers(self):
        return {"Authorization": f"Bearer {self._token()}"}

    def ensure_user(self, email, display_name):
        headers = self._headers()
        found = requests.get(f"{self.base}/users", params={"email": email, "exact": "true"}, headers=headers, timeout=self.timeout)
        found.raise_for_status()
        if found.json():
            return EnsureUserResult(subject=found.json()[0]["id"], created=False)
        first, _, last = display_name.partition(" ")
        created = requests.post(
            f"{self.base}/users",
            json={
                "username": email,
                "email": email,
                "firstName": first,
                "lastName": last,
                "enabled": True,
                "emailVerified": False,
                "requiredActions": REQUIRED_ACTIONS,
            },
            headers=headers,
            timeout=self.timeout,
        )
        if created.status_code == 409:  # raced with another creator: look it up again
            again = requests.get(f"{self.base}/users", params={"email": email, "exact": "true"}, headers=headers, timeout=self.timeout)
            again.raise_for_status()
            return EnsureUserResult(subject=again.json()[0]["id"], created=False)
        created.raise_for_status()
        return EnsureUserResult(subject=created.headers["Location"].rstrip("/").rsplit("/", 1)[-1], created=True)

    def send_required_actions_email(self, subject):
        response = requests.put(
            f"{self.base}/users/{subject}/execute-actions-email",
            json=REQUIRED_ACTIONS,
            params={"client_id": settings.OIDC["CLIENT_ID"]},
            headers=self._headers(),
            timeout=self.timeout,
        )
        response.raise_for_status()

    def register_redirect_uris(self, redirect_uri, post_logout_uri):
        client_uuid = self.cfg["BFF_CLIENT_UUID"]
        headers = self._headers()
        url = f"{self.base}/clients/{client_uuid}"
        current = requests.get(url, headers=headers, timeout=self.timeout)
        current.raise_for_status()
        client = current.json()
        uris = set(client.get("redirectUris", []))
        attrs = client.setdefault("attributes", {})
        logout_uris = {u for u in attrs.get("post.logout.redirect.uris", "").split("##") if u}
        if redirect_uri in uris and post_logout_uri in logout_uris:
            return  # idempotent
        uris.add(redirect_uri)
        logout_uris.add(post_logout_uri)
        client["redirectUris"] = sorted(uris)
        attrs["post.logout.redirect.uris"] = "##".join(sorted(logout_uris))
        requests.put(url, json=client, headers=headers, timeout=self.timeout).raise_for_status()

    def disable_user(self, subject):
        requests.put(f"{self.base}/users/{subject}", json={"enabled": False}, headers=self._headers(), timeout=self.timeout).raise_for_status()
