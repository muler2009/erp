from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.authorization import services as authz
from platform_core.authorization.permissions import IsTenantMember, require
from shared.api.errors import DomainError
from shared.api.pagination import paginate
from shared.workflows import services
from shared.workflows.models import WorkflowDefinition, WorkflowInstance


def _task(t):
    i = t.instance
    return {"id": str(t.id), "instance_id": str(i.id), "subject_type": i.subject_type, "subject_id": i.subject_id, "title": i.title, "amount": str(i.amount) if i.amount is not None else None, "stage_order": t.stage_order, "status": t.status, "due_at": t.due_at, "requester_id": str(i.requester_id)}


def _instance(i, detail=False):
    data = {"id": str(i.id), "subject_type": i.subject_type, "subject_id": i.subject_id, "title": i.title, "amount": str(i.amount) if i.amount is not None else None, "status": i.status, "round": i.round, "requester_id": str(i.requester_id), "definition": f"{i.definition.code}@v{i.definition.version}", "created_at": i.created_at, "completed_at": i.completed_at}
    if detail:
        data["tasks"] = [{"id": str(t.id), "round": t.round, "stage_order": t.stage_order, "assignee_id": str(t.assignee_id), "status": t.status, "due_at": t.due_at, "handed_over_from": str(t.handed_over_from) if t.handed_over_from else None, "comment": t.comment} for t in i.tasks.order_by("round", "stage_order", "created_at")]
        data["history"] = [{"action": a.action, "actor_id": str(a.actor_id) if a.actor_id else None, "round": a.round, "stage_order": a.stage_order, "comment": a.comment, "metadata": a.metadata, "at": a.created_at} for a in i.actions.all()]
    return data


def _definition(d):
    return {"id": str(d.id), "code": d.code, "version": d.version, "name": d.name, "subject_type": d.subject_type, "is_active": d.is_active, "separation_of_duties": d.separation_of_duties, "distinct_approvers": d.distinct_approvers,
            "stages": [{"order": s.order, "name": s.name, "policy": s.policy, "approvers": s.approvers, "min_amount": str(s.min_amount) if s.min_amount is not None else None, "max_amount": str(s.max_amount) if s.max_amount is not None else None, "due_hours": s.due_hours, "escalate_to_user_id": str(s.escalate_to_user_id) if s.escalate_to_user_id else None} for s in d.stages.all()]}


class DefinitionIn(serializers.Serializer):
    code = serializers.SlugField(max_length=60)
    name = serializers.CharField(max_length=200)
    subject_type = serializers.CharField(max_length=60)
    separation_of_duties = serializers.BooleanField(default=True)
    distinct_approvers = serializers.BooleanField(default=False)
    stages = serializers.ListField(child=serializers.DictField(), allow_empty=False)


class Definitions(APIView):
    def get_permissions(self):
        return [require("workflow.definitions.manage")()]

    def get(self, request):
        qs = WorkflowDefinition.objects.prefetch_related("stages")
        if request.query_params.get("active") == "true":
            qs = qs.filter(is_active=True)
        return paginate(request, qs, _definition, ordering="-created_at")

    def post(self, request):
        data = DefinitionIn(data=request.data)
        data.is_valid(raise_exception=True)
        definition = services.create_definition(request.user.id, **data.validated_data)
        return Response(_definition(definition), status=201)


class SubjectTypes(APIView):
    def get_permissions(self):
        return [require("workflow.definitions.manage")()]

    def get(self, request):
        return Response({"subject_types": services.registered_subjects()})


class Inbox(APIView):
    permission_classes = [IsTenantMember]

    def get(self, request):
        return paginate(request, services.inbox(request.user.id), _task, ordering="created_at")


class Instances(APIView):
    permission_classes = [IsTenantMember]

    def get(self, request):
        qs = WorkflowInstance.objects.select_related("definition")
        if not authz.has_permission(request.user.id, "workflow.view_all"):
            from django.db.models import Q

            qs = qs.filter(Q(requester_id=request.user.id) | Q(tasks__assignee_id=request.user.id)).distinct()
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _instance)


class InstanceDetail(APIView):
    permission_classes = [IsTenantMember]

    def get(self, request, pk):
        instance = get_object_or_404(WorkflowInstance.objects.select_related("definition"), pk=pk)
        if not services.can_view(request.user.id, instance):
            raise DomainError("Workflow instance not found.", code="not_found", status_code=404)
        return Response(_instance(instance, detail=True))


class DecisionIn(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["APPROVE", "REJECT", "REQUEST_CHANGES"])
    comment = serializers.CharField(allow_blank=True, default="", max_length=4000)


class TaskDecide(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request, pk):
        data = DecisionIn(data=request.data)
        data.is_valid(raise_exception=True)
        instance = services.decide(request.user.id, pk, data.validated_data["decision"], data.validated_data["comment"])
        return Response(_instance(instance, detail=True))


class DelegateIn(serializers.Serializer):
    to_user_id = serializers.UUIDField()
    comment = serializers.CharField(allow_blank=True, default="", max_length=4000)


class TaskDelegate(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request, pk):
        data = DelegateIn(data=request.data)
        data.is_valid(raise_exception=True)
        services.delegate(request.user.id, pk, data.validated_data["to_user_id"], data.validated_data["comment"])
        return Response(status=201)


class ResubmitIn(serializers.Serializer):
    comment = serializers.CharField(allow_blank=True, default="", max_length=4000)
    amount = serializers.DecimalField(max_digits=18, decimal_places=2, required=False)


class InstanceResubmit(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request, pk):
        data = ResubmitIn(data=request.data)
        data.is_valid(raise_exception=True)
        instance = services.resubmit(request.user.id, pk, comment=data.validated_data["comment"], amount=data.validated_data.get("amount"))
        return Response(_instance(instance, detail=True))


class InstanceCancel(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request, pk):
        instance = services.cancel(request.user.id, pk, comment=str(request.data.get("comment", ""))[:4000])
        return Response(_instance(instance, detail=True))
