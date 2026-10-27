from django.db import connection
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.authorization.permissions import IsTenantMember
from shared.api.pagination import paginate
from shared.notifications import services
from shared.notifications.models import Notification, NotificationPreference


def _dict(n):
    return {"id": str(n.id), "type": n.notification_type, "title": n.title, "body": n.body, "ref_type": n.ref_type, "ref_id": n.ref_id, "created_at": n.created_at, "read": n.read_at is not None}


class NotificationList(APIView):
    """Own notifications only: the queryset is always filtered by the authenticated user."""

    permission_classes = [IsTenantMember]

    def get(self, request):
        qs = Notification.objects.filter(user_id=request.user.id)
        if request.query_params.get("unread") == "true":
            qs = qs.filter(read_at__isnull=True)
        response = paginate(request, qs, _dict)
        response.data["unread_count"] = services.unread_count(request.user.id)
        return response


class NotificationRead(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request, pk):
        get_object_or_404(Notification, pk=pk, user_id=request.user.id)
        services.mark_read(request.user.id, pk)
        return Response(status=204)


class NotificationReadAll(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request):
        return Response({"marked": services.mark_read(request.user.id)})


class Preferences(APIView):
    permission_classes = [IsTenantMember]

    class In(serializers.Serializer):
        notification_type = serializers.CharField(max_length=80)
        in_app = serializers.BooleanField(required=False)
        email = serializers.BooleanField(required=False)

    def get(self, request):
        return Response(list(NotificationPreference.objects.filter(user_id=request.user.id).values("notification_type", "in_app", "email")))

    def put(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        pref = services.set_preference(request.user.id, v["notification_type"], in_app=v.get("in_app"), email=v.get("email"))
        return Response({"notification_type": pref.notification_type, "in_app": pref.in_app, "email": pref.email})
