"""Test doubles for the identity-provider boundary."""
import itertools

from platform_core.identity.provisioner import EnsureUserResult, IdentityProvisioner


class FakeIdentityProvisioner(IdentityProvisioner):
    """In-memory stand-in for the Keycloak admin API. State is class-level so separate instances created by
    get_provisioner() share it; tests reset it via the `fake_identity` fixture."""

    users = {}
    redirect_uris = set()
    emails_sent = []
    fail_register_redirect = False
    _counter = itertools.count(1)

    @classmethod
    def reset(cls):
        cls.users = {}
        cls.redirect_uris = set()
        cls.emails_sent = []
        cls.fail_register_redirect = False

    def ensure_user(self, email, display_name):
        if email in self.users:
            return EnsureUserResult(subject=self.users[email], created=False)
        subject = f"kc-{next(self._counter)}-{abs(hash(email)) % 10**6}"
        self.users[email] = subject
        return EnsureUserResult(subject=subject, created=True)

    def send_required_actions_email(self, subject):
        self.emails_sent.append(subject)

    def register_redirect_uris(self, redirect_uri, post_logout_uri):
        if self.fail_register_redirect:
            raise RuntimeError("keycloak unavailable")
        self.redirect_uris.add(redirect_uri)

    def disable_user(self, subject):
        pass
