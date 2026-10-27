"""Django settings. All environment-specific values come from environment variables.

No secret has a usable default outside DEBUG mode.
"""
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and value in (None, ""):
        raise ImproperlyConfigured(f"Environment variable {name} is required")
    return value


def env_bool(name, default=False):
    return str(os.environ.get(name, str(default))).lower() in {"1", "true", "yes", "on"}


def env_list(name, default=""):
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


DEBUG = env_bool("DJANGO_DEBUG", False)

SECRET_KEY = env("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = "insecure-dev-only-key-do-not-use-in-production"
    else:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set when DEBUG is off")

# Key used to encrypt OIDC tokens stored in the server-side session (Fernet, urlsafe base64 32 bytes).
TOKEN_ENCRYPTION_KEY = env("ERP_TOKEN_ENCRYPTION_KEY")
if not TOKEN_ENCRYPTION_KEY and not DEBUG:
    raise ImproperlyConfigured("ERP_TOKEN_ENCRYPTION_KEY must be set when DEBUG is off")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", ".localhost,127.0.0.1")

# Tenant hosts are <slug>.<ERP_BASE_DOMAIN>; the platform console lives on ERP_PLATFORM_HOST.
BASE_DOMAIN = env("ERP_BASE_DOMAIN", "localhost")
PLATFORM_HOST = env("ERP_PLATFORM_HOST", f"platform.{BASE_DOMAIN}")
PUBLIC_SCHEME = env("ERP_PUBLIC_SCHEME", "https")

# ---------------------------------------------------------------- apps / tenancy
SHARED_APPS = [
    "django_tenants",
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.sessions",
    "rest_framework",
    "drf_spectacular",
    "platform_core.tenants",
    "platform_core.users",
    "platform_core.audit",
]
TENANT_APPS = [
    "django.contrib.contenttypes",
    "platform_core.authorization",
    "platform_core.tenant_audit",
    "platform_core.organizations",
    "shared.sequences",
    "shared.events",
    "shared.notifications",
    "shared.workflows",
    "shared.files",
]
INSTALLED_APPS = list(SHARED_APPS) + [a for a in TENANT_APPS if a not in SHARED_APPS]

TENANT_MODEL = "tenants.Tenant"
TENANT_DOMAIN_MODEL = "tenants.Domain"
PUBLIC_SCHEMA_NAME = "public"
# A host with no registered domain gets a 404, never the public schema.
SHOW_PUBLIC_IF_NO_TENANT_FOUND = False

AUTH_USER_MODEL = "users.User"
AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend"]

MIDDLEWARE = [
    "shared.middleware.CorrelationIdMiddleware",
    "shared.middleware.TenantRoutingMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "shared.middleware.TenantStatusMiddleware",
]

ROOT_URLCONF = "config.urls_tenant"
PUBLIC_SCHEMA_URLCONF = "config.urls_platform"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django_tenants.postgresql_backend",
        "NAME": env("DB_NAME", "erp"),
        "USER": env("DB_USER", "erp"),
        "PASSWORD": env("DB_PASSWORD", ""),
        "HOST": env("DB_HOST", "localhost"),
        "PORT": env("DB_PORT", "5432"),
        "CONN_MAX_AGE": 0,  # no connection reuse across requests: the schema is reset per request
    }
}
DATABASE_ROUTERS = ("django_tenants.routers.TenantSyncRouter",)
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

TEMPLATES = []
USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"

# ---------------------------------------------------------------- sessions / cookies / CSRF
SESSION_ENGINE = "django.contrib.sessions.backends.db"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_AGE = int(env("ERP_SESSION_MAX_AGE_SECONDS", 8 * 3600))
CSRF_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_HTTPONLY = False  # the SPA reads it to send X-CSRFToken
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https") if env_bool("ERP_BEHIND_PROXY") else None

# ---------------------------------------------------------------- DRF
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "platform_core.identity.authentication.BFFSessionAuthentication",
        "platform_core.identity.authentication.BearerJWTAuthentication",
    ],
    # Deny by default: every view must declare its own permission_classes explicitly.
    "DEFAULT_PERMISSION_CLASSES": ["shared.api.permissions.DenyByDefault"],
    "EXCEPTION_HANDLER": "shared.api.errors.exception_handler",
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "shared.api.pagination.StandardPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.UserRateThrottle", "rest_framework.throttling.AnonRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"user": env("ERP_THROTTLE_USER", "600/min"), "anon": env("ERP_THROTTLE_ANON", "60/min")},
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}
SPECTACULAR_SETTINGS = {
    "TITLE": "ERP Platform API",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# ---------------------------------------------------------------- OIDC / Keycloak
OIDC = {
    "ISSUER": env("OIDC_ISSUER", "http://localhost:8080/realms/erp"),
    "CLIENT_ID": env("OIDC_CLIENT_ID", "erp-bff"),
    "CLIENT_SECRET": env("OIDC_CLIENT_SECRET", ""),
    "API_AUDIENCE": env("OIDC_API_AUDIENCE", "erp-api"),
    "SCOPES": "openid profile email",
    "ALGORITHMS": ["RS256"],
    "LEEWAY_SECONDS": 30,
    "DISCOVERY_TTL": 600,
    "JWKS_REFETCH_MIN_INTERVAL": 30,
    "HTTP_TIMEOUT": 5,
}
KEYCLOAK_ADMIN = {
    "BASE_URL": env("KEYCLOAK_BASE_URL", "http://localhost:8080"),
    "REALM": env("KEYCLOAK_REALM", "erp"),
    # Dedicated confidential client with a narrow service account (manage-users, manage-clients only).
    "CLIENT_ID": env("KEYCLOAK_ADMIN_CLIENT_ID", "erp-identity-admin"),
    "CLIENT_SECRET": env("KEYCLOAK_ADMIN_CLIENT_SECRET", ""),
    "BFF_CLIENT_UUID": env("KEYCLOAK_BFF_CLIENT_UUID", ""),
}
IDENTITY_PROVISIONER = env("ERP_IDENTITY_PROVISIONER", "platform_core.identity.provisioner.KeycloakAdminClient")
# Platform admins must have authenticated with MFA (amr claim contains otp/mfa/hwk).
PLATFORM_REQUIRE_MFA = env_bool("ERP_PLATFORM_REQUIRE_MFA", True)

# ---------------------------------------------------------------- tenant policy
TENANT_RETENTION_DAYS = int(env("ERP_TENANT_RETENTION_DAYS", 30))
BREAK_GLASS_MAX_MINUTES = 240
INVITE_TTL_HOURS = int(env("ERP_INVITE_TTL_HOURS", 72))

# ---------------------------------------------------------------- celery
CELERY_BROKER_URL = env("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = None
CELERY_TASK_ALWAYS_EAGER = env_bool("CELERY_TASK_ALWAYS_EAGER", False)
CELERY_TASK_EAGER_PROPAGATES = False
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True

CELERY_BEAT_SCHEDULE = {
    "relay-outboxes": {"task": "events.relay_all", "schedule": 15.0},
    "purge-deleted-files": {"task": "files.purge_all", "schedule": 86400},
    "escalate-overdue-approvals": {"task": "workflows.escalate_all", "schedule": 300.0},
}

# ---------------------------------------------------------------- events / files
# Optional external broker (RabbitMQ). Empty = no external publication; local consumers still run.
EVENT_BROKER_URL = env("EVENT_BROKER_URL", "")
EVENT_EXCHANGE = env("EVENT_EXCHANGE", "erp.events")
EVENT_MAX_ATTEMPTS = int(env("ERP_EVENT_MAX_ATTEMPTS", 8))
FILE_STORAGE_ROOT = env("FILE_STORAGE_ROOT", str(BASE_DIR / "var" / "files"))
FILE_MAX_BYTES = int(env("FILE_MAX_BYTES", 10 * 1024 * 1024))
FILE_LINK_TTL_SECONDS = 60
FILE_RETENTION_DAYS = int(env("FILE_RETENTION_DAYS", 30))  # deleted files are purged after this

# ---------------------------------------------------------------- email
EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", "localhost")
EMAIL_PORT = int(env("EMAIL_PORT", 25))
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "no-reply@erp.localhost")

# ---------------------------------------------------------------- logging (structured JSON, correlation-aware)
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"correlation": {"()": "shared.logging.CorrelationFilter"}},
    "formatters": {"json": {"()": "shared.logging.JsonFormatter"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "json", "filters": ["correlation"]}},
    "root": {"handlers": ["console"], "level": env("ERP_LOG_LEVEL", "INFO")},
}
