import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-secret-key-not-for-production")
os.environ.setdefault("DJANGO_DEBUG", "true")

from config.settings import *  # noqa: E402,F401,F403

DATABASES["default"].update(  # noqa: F405
    {
        "NAME": os.environ.get("DB_NAME", "erp_dev"),
        "USER": os.environ.get("DB_USER", "postgres"),
        "HOST": os.environ.get("DB_HOST", "localhost"),
        "PORT": os.environ.get("DB_PORT", "5433"),
    }
)
CELERY_TASK_ALWAYS_EAGER = True
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
IDENTITY_PROVISIONER = "tests.fakes.FakeIdentityProvisioner"
PLATFORM_REQUIRE_MFA = True
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
PUBLIC_SCHEME = "http"
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": {"user": "100000/min", "anon": "100000/min"}}  # noqa: F405
OIDC = {**OIDC, "ISSUER": "https://kc.test/realms/erp", "CLIENT_SECRET": "test-secret"}  # noqa: F405
LOGGING["root"]["level"] = "WARNING"  # noqa: F405

import tempfile  # noqa: E402

FILE_STORAGE_ROOT = tempfile.mkdtemp(prefix="erp-test-files-")
