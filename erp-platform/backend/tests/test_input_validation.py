"""Bad request bodies must produce 400s, never 500s, and blank records must not be created."""
from datetime import date

import pytest

from modules.assets import services as assets
from modules.hr import lifecycle as hr
from modules.inventory import items as items_svc
from modules.inventory import services as inv
from shared.api.errors import ValidationFailed, iso_date, require_text
from tests.test_inventory import f  # noqa: F401


def test_iso_date_parses_and_rejects():
    assert iso_date("2026-03-01", "d") == date(2026, 3, 1)
    assert iso_date(date(2026, 3, 1), "d") == date(2026, 3, 1)
    assert iso_date(None, "d") is None and iso_date("", "d") is None
    for bad in ("tomorrow", "2026-13-40", 5, "01/02/2026"):
        with pytest.raises(ValidationFailed) as e:
            iso_date(bad, "d")
        assert e.value.detail.code == "invalid_date"
    with pytest.raises(ValidationFailed) as e:
        iso_date(None, "start_date", required=True)
    assert e.value.detail.code == "required"


def test_require_text():
    assert require_text("  A1 ", "code") == "A1"
    for bad in (None, "", "   ", 7):
        with pytest.raises(ValidationFailed):
            require_text(bad, "code")


@pytest.mark.django_db
@pytest.mark.parametrize("code,name", [("", "x"), ("x", ""), (None, "x"), ("  ", " ")])
def test_blank_records_are_refused(f, code, name):
    with pytest.raises(ValidationFailed):
        inv.create_warehouse(None, code=code, name=name)
    with pytest.raises(ValidationFailed):
        items_svc.save_category(None, code=code, name=name)
    with pytest.raises(ValidationFailed):
        assets.create_location(None, code=code, name=name)
    with pytest.raises(ValidationFailed):
        hr.create_grade(None, code=code, name=name)
    with pytest.raises(ValidationFailed):
        hr.set_document_requirement(None, doc_type=code, title=name)
