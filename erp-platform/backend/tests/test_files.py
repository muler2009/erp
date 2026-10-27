import io
import zipfile
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from django_tenants.utils import schema_context

from shared.files import services as files
from shared.files.models import StoredFile
from tests.conftest import GLOBEX_HOST, Api

PDF = b"%PDF-1.4\n%fake but valid magic\n"


def up(api, name, data, content_type="application/octet-stream", **extra):
    return api.client.post("/api/v1/files", {"file": SimpleUploadedFile(name, data, content_type=content_type), **extra}, HTTP_HOST=api.host)


def ooxml(prefix):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr(f"{prefix}document.xml", "<x/>")
    return buf.getvalue()


def code(response):
    return response.json()["error"]["code"]


@pytest.mark.django_db
def test_upload_download_roundtrip_headers_and_audit(owner_api, acme):
    r = up(owner_api, "../../etc/Invoice 1.pdf", PDF)
    assert r.status_code == 201, r.content
    meta = r.json()
    assert meta["name"] == "Invoice 1.pdf" and meta["content_type"] == "application/pdf" and meta["size"] == len(PDF)
    got = owner_api.get(f"/api/v1/files/{meta['id']}/content")
    assert got.status_code == 200 and b"".join(got.streaming_content) == PDF
    assert got["X-Content-Type-Options"] == "nosniff" and "attachment" in got["Content-Disposition"] and got["Cache-Control"] == "private, no-store"
    actions = [e["action"] for e in owner_api.get("/api/v1/audit-events").json()["results"]]
    assert "file.uploaded" in actions and "file.downloaded" in actions


@pytest.mark.django_db
@pytest.mark.parametrize(
    "name,data,expected",
    [
        ("evil.exe", b"MZ\x90\x00", "file_type_not_allowed"),
        ("page.html", b"<script>alert(1)</script>", "file_type_not_allowed"),
        ("logo.svg", b"<svg onload=alert(1)/>", "file_type_not_allowed"),
        ("noext", b"hello", "file_type_not_allowed"),
        ("fake.pdf", b"<html>not a pdf</html>", "file_content_mismatch"),
        ("fake.png", PDF, "file_content_mismatch"),
        ("bin.txt", b"abc\x00def", "file_content_mismatch"),
        ("notzip.docx", b"PK-not-really", "file_content_mismatch"),
        ("wrong.xlsx", ooxml("word/"), "file_content_mismatch"),
        ("empty.pdf", b"", "empty_file"),
    ],
)
def test_malicious_or_mismatched_uploads_rejected(owner_api, name, data, expected):
    r = up(owner_api, name, data)
    assert r.status_code == 400 and code(r) == expected


@pytest.mark.django_db
def test_valid_office_files_and_size_limit(owner_api, settings):
    assert up(owner_api, "a.docx", ooxml("word/")).status_code == 201
    assert up(owner_api, "b.xlsx", ooxml("xl/")).status_code == 201
    settings.FILE_MAX_BYTES = 10
    assert code(up(owner_api, "big.txt", b"x" * 11)) == "file_too_large"


@pytest.mark.django_db
def test_zip_bomb_entry_count_rejected(owner_api):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("word/document.xml", "<x/>")
        for i in range(files.MAX_ZIP_ENTRIES + 1):
            zf.writestr(f"junk/{i}", "")
    assert code(up(owner_api, "bomb.docx", buf.getvalue())) == "file_content_mismatch"


@pytest.mark.django_db
def test_files_are_private_to_owner_and_hidden_across_tenants(owner_api, acme, globex, idp, world):
    mine = up(owner_api, "private.pdf", PDF).json()["id"]
    # another user in the same tenant (no files.manage) cannot see it
    from platform_core.authorization.models import RoleDefinition, RoleAssignment
    from platform_core.tenants.models import Tenant
    from platform_core.users.models import ExternalIdentity, TenantMembership, User

    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        emp = User.objects.create_user("emp@acme.test", "Emp")
        TenantMembership.objects.create(user=emp, tenant=tenant, status="ACTIVE")
        RoleAssignment.objects.create(user_id=emp.id, role=RoleDefinition.objects.get(name="employee"))
    ExternalIdentity.objects.create(user=emp, issuer="https://kc.test/realms/erp", subject="emp-sub")
    emp_api = Api(owner_api.host)
    assert emp_api.login(idp, "emp-sub").status_code == 302
    assert emp_api.get(f"/api/v1/files/{mine}").status_code == 404
    assert emp_api.get(f"/api/v1/files/{mine}/content").status_code == 404
    assert emp_api.delete(f"/api/v1/files/{mine}").status_code == 404
    assert emp_api.get("/api/v1/files").json()["results"] == []
    # globex owner cannot reach acme's file id on globex's host
    gx = Api(GLOBEX_HOST)
    assert gx.login(idp, globex["owner_sub"]).status_code == 302
    assert gx.get(f"/api/v1/files/{mine}/content").status_code == 404
    # tenant owner (files.manage) can
    assert owner_api.get(f"/api/v1/files/{mine}").status_code == 200


@pytest.mark.django_db
def test_module_registered_access_check_and_ref_validation(owner_api, acme):
    files.register_access_check("demo_record", lambda user_id, ref_id: ref_id == "OK-1")
    try:
        assert up(owner_api, "x.pdf", PDF, ref_type="nope", ref_id="1").status_code == 400
        assert up(owner_api, "x.pdf", PDF, ref_type="demo_record", ref_id="DENIED").status_code == 400
        ok = up(owner_api, "x.pdf", PDF, ref_type="demo_record", ref_id="OK-1")
        assert ok.status_code == 201
        listing = owner_api.get("/api/v1/files?ref_type=demo_record&ref_id=OK-1").json()["results"]
        assert len(listing) == 1
    finally:
        files._ACCESS_CHECKS.pop("demo_record")


@pytest.mark.django_db
def test_signed_link_is_bound_to_user_file_tenant_and_expires(owner_api, acme, globex, idp, settings):
    fid = up(owner_api, "l.pdf", PDF).json()["id"]
    link = owner_api.post(f"/api/v1/files/{fid}/link").json()
    assert link["expires_in"] == 60
    assert owner_api.get(link["url"]).status_code == 200
    gx = Api(GLOBEX_HOST)
    assert gx.login(idp, globex["owner_sub"]).status_code == 302
    assert gx.get(link["url"]).status_code == 404  # other tenant/user
    assert owner_api.get("/api/v1/files/download/garbage").status_code == 404
    settings.FILE_LINK_TTL_SECONDS = -1
    assert owner_api.get(link["url"]).status_code == 404  # expired


@pytest.mark.django_db
def test_delete_then_purge_removes_blob(owner_api, acme):
    fid = up(owner_api, "d.pdf", PDF).json()["id"]
    assert owner_api.delete(f"/api/v1/files/{fid}").status_code == 204
    assert owner_api.get(f"/api/v1/files/{fid}/content").status_code == 404
    with schema_context(acme["schema"]):
        row = StoredFile.objects.get(pk=fid)
        path = files.get_storage()._path(row.storage_key)
        assert path.exists()
        assert files.purge_deleted(retention_days=30) == 0  # inside retention
        assert files.purge_deleted(retention_days=30, now=timezone.now() + timedelta(days=31)) == 1
        assert not path.exists() and not StoredFile.objects.filter(pk=fid).exists()


@pytest.mark.django_db
def test_storage_rejects_path_escape_and_scanner_hook(owner_api, acme):
    with pytest.raises(ValueError):
        files.LocalStorage()._path("../../etc/passwd")
    from shared.api.errors import ValidationFailed

    def scanner(data, name):
        if b"EICAR" in data:
            raise ValidationFailed("Malware detected.", code="malware_detected")

    files.register_scanner(scanner)
    try:
        assert code(up(owner_api, "e.txt", b"EICAR test")) == "malware_detected"
        assert up(owner_api, "ok.txt", b"clean").status_code == 201
    finally:
        files._SCANNERS.remove(scanner)
