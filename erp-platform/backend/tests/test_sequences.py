from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from django.db import IntegrityError, connection, transaction
from django_tenants.utils import schema_context

from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as seq
from shared.sequences.models import IssuedNumber, NumberSequence
from tests.conftest import Api


def code_of(response):
    return response.json()["error"]["code"]


@pytest.mark.parametrize("template", ["PO-{yyyy}-{seq:05d}", "{seq}", "INV/{yy}{mm}/{seq:03d}"])
def test_valid_templates(template):
    seq.validate_template(template)


@pytest.mark.parametrize("template", ["", "NOSEQ-{yyyy}", "{seq:abc}", "{__class__}", "{0.__class__}", "{seq!r}", "{seq:05d}{evil}", "x" * 121])
def test_invalid_templates_are_rejected(template):
    with pytest.raises(ValidationFailed):
        seq.validate_template(template)


def test_rendering():
    assert seq.render("PO-{yyyy}-{seq:05d}", 7, date(2026, 3, 9)) == "PO-2026-00007"
    assert seq.render("INV/{yy}{mm}/{seq:03d}", 12, date(2026, 3, 9)) == "INV/2603/012"
    assert seq.render("{seq}", 1234, date(2026, 1, 1)) == "1234"


@pytest.mark.django_db
def test_numbers_increase_and_reset_by_policy(acme):
    with schema_context(acme["schema"]):
        seq.create_sequence("po", "Purchase orders", "PO-{yyyy}-{seq:03d}", "YEARLY")
        assert seq.next_number("po", on_date=date(2026, 5, 1)) == "PO-2026-001"
        assert seq.next_number("po", on_date=date(2026, 6, 1)) == "PO-2026-002"
        assert seq.next_number("po", on_date=date(2027, 1, 2)) == "PO-2027-001"  # yearly reset
        with pytest.raises(DomainError) as exc:
            seq.next_number("po", on_date=date(2026, 12, 31))  # never go back to an earlier period
        assert exc.value.detail.code == "sequence_period_regression"
        seq.create_sequence("m", "Monthly", "M{mm}-{seq}", "MONTHLY")
        assert [seq.next_number("m", on_date=date(2026, 1, 5)), seq.next_number("m", on_date=date(2026, 1, 6)), seq.next_number("m", on_date=date(2026, 2, 1))] == ["M01-1", "M01-2", "M02-1"]
        seq.create_sequence("n", "Never", "N-{seq}")
        assert [seq.next_number("n", on_date=date(2026, 1, 1)), seq.next_number("n", on_date=date(2030, 1, 1))] == ["N-1", "N-2"]
        assert seq.preview("n") == "N-3"  # preview does not consume
        assert seq.preview("n") == "N-3"
        with pytest.raises(DomainError):
            seq.next_number("missing")
        assert IssuedNumber.objects.filter(sequence__code="po").count() == 3


@pytest.mark.django_db
def test_rolled_back_business_transaction_releases_the_number(acme):
    with schema_context(acme["schema"]):
        seq.create_sequence("rb", "Rollback", "R-{seq}")
        with pytest.raises(RuntimeError):
            with transaction.atomic():
                assert seq.next_number("rb") == "R-1"
                raise RuntimeError("business action failed")
        assert seq.next_number("rb") == "R-1"  # gapless: the failed action did not burn a number


@pytest.mark.django_db
def test_database_prevents_duplicate_issued_numbers(acme):
    with schema_context(acme["schema"]):
        sequence = seq.create_sequence("dup", "Dup", "D-{seq}")
        IssuedNumber.objects.create(sequence=sequence, number="D-1")
        with pytest.raises(IntegrityError):
            with transaction.atomic():
                IssuedNumber.objects.create(sequence=sequence, number="D-1")


@pytest.mark.django_db
def test_sequence_api_and_permissions(owner_api, acme):
    created = owner_api.post("/api/v1/sequences", {"code": "inv", "name": "Invoices", "template": "INV-{yyyy}-{seq:05d}", "reset_policy": "YEARLY"})
    assert created.status_code == 201 and created.json()["next_value"] == 1
    assert code_of(owner_api.post("/api/v1/sequences", {"code": "inv", "name": "x", "template": "{seq}"})) == "sequence_exists"
    assert code_of(owner_api.post("/api/v1/sequences", {"code": "bad", "name": "x", "template": "{evil}"})) == "invalid_template"
    detail = owner_api.get("/api/v1/sequences/inv").json()
    assert detail["preview"].startswith("INV-") and detail["preview"].endswith("-00001")
    assert owner_api.patch("/api/v1/sequences/inv", {"template": "I-{seq}", "next_value": 50}).json()["next_value"] == 50
    assert code_of(owner_api.patch("/api/v1/sequences/inv", {"next_value": 10})) == "sequence_value_regression"
    assert owner_api.patch("/api/v1/sequences/inv", {"template": "I-{bad}"}).status_code == 400
    # there is deliberately no HTTP endpoint that consumes a number
    assert owner_api.post("/api/v1/sequences/inv/next").status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_issuance_has_no_duplicates_or_gaps(own_tenant):
    tenant = own_tenant("seqco")
    with schema_context(tenant.schema_name):
        seq.create_sequence("c", "Concurrent", "C-{seq:04d}")

    def worker(_):
        issued = []
        try:
            with schema_context(tenant.schema_name):
                for _ in range(10):
                    issued.append(seq.next_number("c"))
        finally:
            connection.close()  # each thread has its own connection
        return issued

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = [n for batch in pool.map(worker, range(8)) for n in batch]
    assert len(results) == 80 and len(set(results)) == 80
    assert sorted(results) == [f"C-{i:04d}" for i in range(1, 81)]
    with schema_context(tenant.schema_name):
        assert NumberSequence.objects.get(code="c").next_value == 81
        assert IssuedNumber.objects.filter(sequence__code="c").count() == 80
