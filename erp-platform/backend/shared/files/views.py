from django.http import FileResponse
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.authorization import services as authz
from platform_core.authorization.permissions import IsTenantMember, require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate
from shared.files import services
from shared.files.models import StoredFile


def _meta(f):
    return {"id": str(f.id), "name": f.original_name, "content_type": f.content_type, "size": f.size, "sha256": f.sha256, "ref_type": f.ref_type, "ref_id": f.ref_id, "owner_id": str(f.owner_id), "created_at": f.created_at}


def _download(file, handle):
    response = FileResponse(handle, content_type=file.content_type, as_attachment=True, filename=file.original_name)
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response["Cache-Control"] = "private, no-store"
    return response


class FileListCreate(APIView):
    parser_classes = [MultiPartParser]

    def get_permissions(self):
        return [require("files.upload")()] if self.request.method == "POST" else [IsTenantMember()]

    def get(self, request):
        qs = StoredFile.objects.filter(status="ACTIVE")
        if not authz.has_permission(request.user.id, "files.manage"):
            qs = qs.filter(owner_id=request.user.id)
        if request.query_params.get("ref_type"):
            qs = qs.filter(ref_type=request.query_params["ref_type"], ref_id=request.query_params.get("ref_id", ""))
        return paginate(request, qs, _meta)

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationFailed("A 'file' part is required.", code="file_required")
        if upload.size > services.settings.FILE_MAX_BYTES:
            raise ValidationFailed("The file is too large.", code="file_too_large")
        ref_type = request.data.get("ref_type", "")
        if ref_type:  # only attach to record types a module has registered, so ref_type can't be used to probe
            if ref_type not in services._ACCESS_CHECKS:
                raise ValidationFailed("Unknown ref_type.", code="invalid_ref")
            if not services._ACCESS_CHECKS[ref_type](request.user.id, request.data.get("ref_id", "")):
                raise ValidationFailed("You cannot attach files to that record.", code="invalid_ref")
        row = services.upload(request.user.id, upload.name, upload.read(), ref_type=ref_type, ref_id=request.data.get("ref_id", ""), request=request)
        return Response(_meta(row), status=201)


class FileDetail(APIView):
    permission_classes = [IsTenantMember]

    def get(self, request, pk):
        return Response(_meta(services.get_for_user(request.user.id, pk)))

    def delete(self, request, pk):
        services.delete(request.user.id, pk, request=request)
        return Response(status=204)


class FileContent(APIView):
    permission_classes = [IsTenantMember]

    def get(self, request, pk):
        file, handle = services.read_for_user(request.user.id, pk, request=request)
        return _download(file, handle)


class FileLink(APIView):
    permission_classes = [IsTenantMember]

    def post(self, request, pk):
        token, ttl = services.issue_link(request.user.id, pk)
        return Response({"url": f"/api/v1/files/download/{token}", "expires_in": ttl})


class FileLinkRedeem(APIView):
    permission_classes = [IsTenantMember]

    def get(self, request, token):
        file, handle = services.redeem_link(token, request.user.id)
        return _download(file, handle)
