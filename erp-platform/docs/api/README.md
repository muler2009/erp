# API reference
`openapi-tenant.yaml` (tenant hosts) and `openapi-platform.yaml` (platform host) are generated from the URL configuration:

    cd backend && python manage.py spectacular --urlconf config.urls_tenant --file ../docs/api/openapi-tenant.yaml
    cd backend && python manage.py spectacular --urlconf config.urls_platform --file ../docs/api/openapi-platform.yaml

**Limitation (known):** the views are hand-written `APIView`s that return dictionaries, so the files list every path and
method but do not describe request and response bodies. Bodies are documented in the phase status documents and the tests.
Closing this gap means introducing serializers per endpoint; it is not done.
