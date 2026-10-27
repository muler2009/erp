from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.audit.services import record_tenant_event
from platform_core.authorization.permissions import require
from shared.api.pagination import paginate
from shared.events import services
from shared.events.models import OutboxEvent
from django.db import connection


def _dict(e):
    return {"id": str(e.id), "type": e.event_type, "version": e.version, "status": e.status, "attempts": e.attempts, "last_error": e.last_error, "created_at": e.created_at, "published_at": e.published_at}


class EventList(APIView):
    permission_classes = [require("events.manage")]

    def get(self, request):
        qs = OutboxEvent.objects.all()
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"].upper())
        response = paginate(request, qs, _dict)
        response.data["stats"] = services.outbox_stats()
        return response


class EventRetry(APIView):
    permission_classes = [require("events.manage")]

    def post(self, request, pk):
        get_object_or_404(OutboxEvent, pk=pk)
        event = services.retry_dead_event(pk)
        record_tenant_event(connection.tenant, "event.retried", actor_user_id=request.user.id, target_type="OutboxEvent", target_id=event.id, request=request)
        return Response(_dict(event))
