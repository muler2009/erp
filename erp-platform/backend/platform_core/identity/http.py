"""The only place that talks HTTP to Keycloak for OIDC. Isolated so tests can substitute it."""
import requests
from django.conf import settings


def get_json(url):
    response = requests.get(url, timeout=settings.OIDC["HTTP_TIMEOUT"])
    response.raise_for_status()
    return response.json()


def post_form(url, data):
    response = requests.post(url, data=data, timeout=settings.OIDC["HTTP_TIMEOUT"])
    return response.status_code, response.json() if response.content else {}
