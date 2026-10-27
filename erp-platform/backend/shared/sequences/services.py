"""Concurrency-safe number generation.

`next_number` must be called inside the business transaction that consumes the number. It takes a row
lock on the sequence (SELECT ... FOR UPDATE), so concurrent callers serialize and never get duplicates;
if the caller's transaction rolls back, the counter increment rolls back with it (gapless per sequence).
"""
import re
from datetime import date

from django.db import transaction
from django.utils import timezone

from shared.api.errors import DomainError, ValidationFailed
from shared.sequences.models import IssuedNumber, NumberSequence

# Templates may only use these placeholders; {seq} is mandatory (optionally with a format spec).
_PLACEHOLDER_RE = re.compile(r"\{(yyyy|yy|mm|seq(?::0?\d{1,2}d)?)\}")
_ANY_BRACE_RE = re.compile(r"\{[^}]*\}")

# Module-registered default sequences, seeded into every tenant: code -> (name, template, reset)
DEFAULT_SEQUENCES = {}


def register_default_sequence(code, name, template, reset=NumberSequence.Reset.NEVER):
    validate_template(template)
    DEFAULT_SEQUENCES[code] = (name, template, reset)


def validate_template(template):
    braces = _ANY_BRACE_RE.findall(template or "")
    if not braces or any(not _PLACEHOLDER_RE.fullmatch(b) for b in braces):
        raise ValidationFailed("Template may only contain {yyyy}, {yy}, {mm} and {seq} / {seq:05d}.", code="invalid_template")
    if not any(b.startswith("{seq") for b in braces):
        raise ValidationFailed("Template must contain {seq}.", code="invalid_template")
    if len(template) > 120:
        raise ValidationFailed("Template too long.", code="invalid_template")


def render(template, value, on_date):
    def sub(match):
        token = match.group(1)
        if token == "yyyy":
            return f"{on_date.year:04d}"
        if token == "yy":
            return f"{on_date.year % 100:02d}"
        if token == "mm":
            return f"{on_date.month:02d}"
        spec = token.partition(":")[2]
        return f"{value:{spec}}" if spec else str(value)

    return _PLACEHOLDER_RE.sub(sub, template)


def _period_key(policy, on_date):
    if policy == NumberSequence.Reset.YEARLY:
        return f"{on_date.year:04d}"
    if policy == NumberSequence.Reset.MONTHLY:
        return f"{on_date.year:04d}-{on_date.month:02d}"
    return ""


def next_number(code, *, on_date=None, for_type="", for_id=""):
    on_date = on_date or timezone.now().date()
    with transaction.atomic():
        seq = NumberSequence.objects.select_for_update().filter(code=code, is_active=True).first()
        if seq is None:
            raise DomainError(f"Unknown or inactive numbering sequence '{code}'.", code="unknown_sequence", status_code=404)
        key = _period_key(seq.reset_policy, on_date)
        if key != seq.period_key:
            if seq.period_key and key < seq.period_key:
                raise DomainError("Cannot issue a number for an earlier period than the sequence has already reached.", code="sequence_period_regression")
            seq.period_key = key
            seq.next_value = 1
        value = seq.next_value
        seq.next_value = value + 1
        seq.save(update_fields=["next_value", "period_key"])
        number = render(seq.template, value, on_date)
        IssuedNumber.objects.create(sequence=seq, number=number, issued_for_type=for_type, issued_for_id=str(for_id or ""))
        return number


def preview(code, on_date=None):
    on_date = on_date or timezone.now().date()
    seq = NumberSequence.objects.filter(code=code).first()
    if seq is None:
        raise DomainError("Unknown sequence.", code="unknown_sequence", status_code=404)
    key = _period_key(seq.reset_policy, on_date)
    value = 1 if key != seq.period_key else seq.next_value
    return render(seq.template, value, on_date)


def create_sequence(code, name, template, reset_policy=NumberSequence.Reset.NEVER):
    validate_template(template)
    if NumberSequence.objects.filter(code=code).exists():
        raise DomainError("A sequence with this code already exists.", code="sequence_exists")
    return NumberSequence.objects.create(code=code, name=name, template=template, reset_policy=reset_policy)


def update_sequence(seq, *, name=None, template=None, reset_policy=None, is_active=None, next_value=None):
    """Changing the template is safe (numbers already issued are immutable). Lowering next_value is refused
    because it could re-issue numbers; the IssuedNumber constraint would catch it, but we refuse early."""
    with transaction.atomic():
        seq = NumberSequence.objects.select_for_update().get(pk=seq.pk)
        if template is not None:
            validate_template(template)
            seq.template = template
        if name is not None:
            seq.name = name
        if reset_policy is not None:
            seq.reset_policy = reset_policy
        if is_active is not None:
            seq.is_active = is_active
        if next_value is not None:
            if next_value < seq.next_value:
                raise DomainError("The next value cannot be lowered.", code="sequence_value_regression")
            seq.next_value = next_value
        seq.save()
        return seq


def seed_default_sequences():
    for code, (name, template, reset) in DEFAULT_SEQUENCES.items():
        NumberSequence.objects.get_or_create(code=code, defaults={"name": name, "template": template, "reset_policy": reset})
