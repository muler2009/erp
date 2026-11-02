"""CRM records, part 2: lead qualification data, duplicate detection and merge, bulk import, account hierarchy,
addresses, credit status, contact roles and consent, and the unified customer timeline."""
import csv
import io
import re
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from modules.crm import models as m
from modules.crm import services as base
from modules.crm.services import _own, scope
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations.models import Currency
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

PRIORITIES = ("LOW", "MEDIUM", "HIGH")
QUALIFICATIONS = ("COLD", "WARM", "HOT")
CUSTOMER_TYPES = ("INDIVIDUAL", "BUSINESS")
CREDIT_STATUSES = ("OK", "ON_HOLD", "BLOCKED")
LIFECYCLES = ("PROSPECT", "ACTIVE", "AT_RISK", "CHURNED")
CONTACT_ROLES = ("DECISION_MAKER", "INFLUENCER", "BILLING", "TECHNICAL", "USER", "OTHER")
CHANNELS = ("EMAIL", "PHONE", "SMS")
MAX_IMPORT_ROWS = 500


def _bad(msg, code="invalid_request"):
    return ValidationFailed(msg, code=code)


def _money(v, field):
    if v in (None, ""):
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        raise _bad(f"{field} must be a number.", "invalid_amount")
    if d < 0:
        raise _bad(f"{field} cannot be negative.", "invalid_amount")
    return d


def _norm_email(v):
    return (v or "").strip().lower()


def _norm_phone(v):
    return re.sub(r"\D", "", v or "")[-9:]  # compare the last 9 digits so +251 / 0 prefixes match


def _norm_name(v):
    return re.sub(r"\s+", " ", (v or "").strip().lower())


# ----------------------------------------------------------------------------- lead data
LEAD_FIELDS = ("priority", "qualification", "industry", "interests", "budget", "potential_value", "currency", "follow_up_date")


def _lead_values(values):
    out = {}
    if values.get("priority") is not None:
        if values["priority"] not in PRIORITIES:
            raise _bad("Priority must be LOW, MEDIUM or HIGH.", "invalid_priority")
        out["priority"] = values["priority"]
    if values.get("qualification") is not None:
        if values["qualification"] not in QUALIFICATIONS:
            raise _bad("Qualification must be COLD, WARM or HOT.", "invalid_qualification")
        out["qualification"] = values["qualification"]
    for k in ("budget", "potential_value"):
        if values.get(k) is not None:
            out[k] = _money(values[k], k)
    if values.get("currency"):
        if not Currency.objects.filter(code=values["currency"], is_active=True).exists():
            raise _bad("Currency is not active.", "invalid_currency")
        out["currency"] = values["currency"]
    for k in ("industry", "interests"):
        if values.get(k) is not None:
            out[k] = str(values[k])[:300]
    if values.get("follow_up_date") is not None:
        out["follow_up_date"] = values["follow_up_date"]
    return out


@transaction.atomic
def update_lead(actor_id, lead_id, *, name=None, company=None, email=None, phone=None, source=None, **values):
    lead = _own(m.Lead, lead_id, actor_id, "Lead", lock=True)
    if lead.status in ("CONVERTED", "MERGED"):
        raise DomainError("A converted or merged lead is read-only.", code="invalid_state_transition")
    for k, v in (("name", name), ("company", company), ("email", email), ("phone", phone), ("source", source)):
        if v is not None:
            if k == "name" and not v.strip():
                raise _bad("name is required.", "invalid_name")
            setattr(lead, k, v.strip() if isinstance(v, str) else v)
    for k, v in _lead_values(values).items():
        setattr(lead, k, v)
    lead.save()
    return lead


def set_lead_details_on_create(lead, values):
    for k, v in _lead_values(values).items():
        setattr(lead, k, v)
    lead.save()
    return lead


# ----------------------------------------------------------------------------- duplicates
def find_lead_duplicates(user_id, *, name="", company="", email="", phone="", exclude_id=None):
    """Existing, still-open leads and accounts that look like the same party (same email, same phone, or the same
    name and company). Only records the user may see are returned."""
    leads = scope(m.Lead.objects.exclude(status__in=["MERGED"]), user_id)
    if exclude_id:
        leads = leads.exclude(pk=exclude_id)
    q = Q()
    if _norm_email(email):
        q |= Q(email__iexact=_norm_email(email))
    ph = _norm_phone(phone)
    found = []
    for l in leads.filter(q) if q else []:
        found.append((l, "email"))
    if ph:
        for l in leads.exclude(phone=""):
            if _norm_phone(l.phone) == ph and all(l.id != x.id for x, _ in found):
                found.append((l, "phone"))
    if name.strip():
        for l in leads.filter(name__iexact=name.strip(), company__iexact=company.strip()):
            if all(l.id != x.id for x, _ in found):
                found.append((l, "name+company"))
    accounts = []
    if company.strip() or name.strip():
        accounts = list(scope(m.CrmAccount.objects.filter(name__iexact=(company or name).strip()), user_id))
    return {"leads": [{"id": str(l.id), "name": l.name, "company": l.company, "status": l.status, "matched_on": why} for l, why in found], "accounts": [{"id": str(a.id), "name": a.name} for a in accounts]}


@transaction.atomic
def create_lead_checked(actor_id, *, allow_duplicate=False, details=None, **kwargs):
    """Create a lead, refusing exact duplicates unless the caller confirms (the response lists the matches)."""
    dups = find_lead_duplicates(actor_id, name=kwargs.get("name", ""), company=kwargs.get("company", ""), email=kwargs.get("email", ""), phone=kwargs.get("phone", ""))
    if (dups["leads"] or dups["accounts"]) and not allow_duplicate:
        names = ", ".join([f"lead {d['name']} ({d['matched_on']})" for d in dups["leads"][:3]] + [f"account {d['name']}" for d in dups["accounts"][:3]])
        raise DomainError(f"Possible duplicate of: {names}. Confirm with allow_duplicate or merge.", code="possible_duplicate", status_code=409)
    lead = base.create_lead(actor_id, **kwargs)
    if details:
        set_lead_details_on_create(lead, details)
    return lead


@transaction.atomic
def merge_leads(actor_id, keep_id, merge_id):
    """Fold `merge_id` into `keep_id`: blanks are filled from the merged lead, activities move across and the merged
    record stays (status MERGED, pointing at the survivor) so history is never lost."""
    if keep_id == merge_id:
        raise _bad("Pick two different leads.", "invalid_merge")
    keep = _own(m.Lead, keep_id, actor_id, "Lead", lock=True)
    gone = _own(m.Lead, merge_id, actor_id, "Lead", lock=True)
    for l in (keep, gone):
        if l.status in ("CONVERTED", "MERGED"):
            raise DomainError("Converted or already merged leads cannot be merged.", code="invalid_state_transition")
    for f in ("company", "email", "phone", "source", "industry", "interests", "budget", "potential_value", "currency", "follow_up_date"):
        if not getattr(keep, f) and getattr(gone, f):
            setattr(keep, f, getattr(gone, f))
    rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    if rank[gone.priority] > rank[keep.priority]:
        keep.priority = gone.priority
    q = {"COLD": 0, "WARM": 1, "HOT": 2}
    if q[gone.qualification] > q[keep.qualification]:
        keep.qualification = gone.qualification
    keep.save()
    m.Activity.objects.filter(lead=gone).update(lead=keep)
    gone.status, gone.merged_into = "MERGED", keep
    gone.save(update_fields=["status", "merged_into", "updated_at"])
    record_tenant_event(current_tenant(), "crm.lead.merged", actor_user_id=actor_id, target_type="Lead", target_id=keep.id, metadata={"merged": str(gone.id)})
    return keep


# ----------------------------------------------------------------------------- import
IMPORT_COLUMNS = ("name", "company", "email", "phone", "source", "industry", "priority", "budget")


def parse_csv(text):
    rows = list(csv.DictReader(io.StringIO(text)))
    return [{k.strip().lower(): (v or "").strip() for k, v in r.items() if k} for r in rows]


@transaction.atomic
def import_leads(actor_id, rows, *, dry_run=True, source="IMPORT"):
    """All-or-nothing bulk import. Dry run (default) validates and reports; a real run only happens when every row is
    clean. Duplicates (against existing leads and within the file) are errors, never silently created."""
    if len(rows) > MAX_IMPORT_ROWS:
        raise _bad(f"At most {MAX_IMPORT_ROWS} rows per import.", "too_many_rows")
    errors, seen = [], set()
    for i, r in enumerate(rows, start=1):
        row_errors = []
        if not (r.get("name") or "").strip():
            row_errors.append("name is required")
        if r.get("priority") and r["priority"].upper() not in PRIORITIES:
            row_errors.append("invalid priority")
        if r.get("budget"):
            try:
                _money(r["budget"], "budget")
            except ValidationFailed:
                row_errors.append("invalid budget")
        key = _norm_email(r.get("email")) or _norm_phone(r.get("phone"))
        if key:
            if key in seen:
                row_errors.append("duplicate inside the file")
            seen.add(key)
            if find_lead_duplicates(actor_id, name="", email=r.get("email", ""), phone=r.get("phone", ""))["leads"]:
                row_errors.append("duplicate of an existing lead")
        if row_errors:
            errors.append({"row": i, "errors": row_errors})
    if errors or dry_run:
        return {"dry_run": dry_run, "valid": not errors, "rows": len(rows), "errors": errors, "created": 0}
    for r in rows:
        lead = base.create_lead(actor_id, name=r["name"], company=r.get("company", ""), email=_norm_email(r.get("email")), phone=r.get("phone", ""), source=r.get("source") or source)
        details = {"industry": r.get("industry") or None, "priority": r["priority"].upper() if r.get("priority") else None, "budget": r.get("budget") or None}
        set_lead_details_on_create(lead, {k: v for k, v in details.items() if v is not None})
    record_tenant_event(current_tenant(), "crm.leads.imported", actor_user_id=actor_id, target_type="Lead", target_id=None, metadata={"rows": str(len(rows))})
    return {"dry_run": False, "valid": True, "rows": len(rows), "errors": [], "created": len(rows)}


# ----------------------------------------------------------------------------- accounts
def _history(account, actor_id, field, old, new):
    if str(old or "") != str(new or ""):
        m.AccountHistory.objects.create(account=account, actor_id=actor_id, field=field, old=str(old or "")[:300], new=str(new or "")[:300])


def _is_ancestor(candidate_parent, account):
    node = candidate_parent
    while node is not None:
        if node.id == account.id:
            return True
        node = node.parent
    return False


@transaction.atomic
def update_account_profile(actor_id, account_id, **v):
    a = _own(m.CrmAccount, account_id, actor_id, "Account", lock=True)
    if v.get("customer_type") is not None and v["customer_type"] not in CUSTOMER_TYPES:
        raise _bad("customer_type must be INDIVIDUAL or BUSINESS.", "invalid_type")
    if v.get("lifecycle_stage") is not None and v["lifecycle_stage"] not in LIFECYCLES:
        raise _bad("Invalid lifecycle stage.", "invalid_lifecycle")
    for f in ("name", "industry", "segment", "website", "tax_id", "classification", "preferred_channel", "language", "customer_type", "lifecycle_stage"):
        if v.get(f) is not None:
            if f == "name" and not v[f].strip():
                raise _bad("name is required.", "invalid_name")
            _history(a, actor_id, f, getattr(a, f), v[f]) if f in ("classification", "lifecycle_stage", "customer_type") else None
            setattr(a, f, v[f])
    if "parent_id" in v:
        if v["parent_id"] is None:
            _history(a, actor_id, "parent", a.parent_id, None)
            a.parent = None
        else:
            parent = _own(m.CrmAccount, v["parent_id"], actor_id, "Parent account")
            if _is_ancestor(parent, a):
                raise DomainError("An account cannot be its own ancestor.", code="hierarchy_cycle")
            _history(a, actor_id, "parent", a.parent_id, parent.id)
            a.parent = parent
    if v.get("is_active") is not None:
        _history(a, actor_id, "is_active", a.is_active, v["is_active"])
        a.is_active = bool(v["is_active"])
    a.save()
    return a


@transaction.atomic
def set_credit(actor_id, account_id, *, credit_status=None, credit_limit="__keep__", note=None):
    """Credit limit and status are commercial controls: they need crm.assign (managers), not just ownership."""
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only sales managers can change credit terms.", code="permission_denied", status_code=403)
    a = _own(m.CrmAccount, account_id, actor_id, "Account", lock=True)
    if credit_status is not None:
        if credit_status not in CREDIT_STATUSES:
            raise _bad("credit_status must be OK, ON_HOLD or BLOCKED.", "invalid_credit_status")
        if credit_status != "OK" and not (note or "").strip():
            raise _bad("A restriction note is required.", "reason_required")
        _history(a, actor_id, "credit_status", a.credit_status, credit_status)
        a.credit_status = credit_status
        a.restriction_note = (note or "")[:300] if credit_status != "OK" else ""
    if credit_limit != "__keep__":
        new = _money(credit_limit, "credit_limit")
        _history(a, actor_id, "credit_limit", a.credit_limit, new)
        a.credit_limit = new
    a.save()
    return a


@transaction.atomic
def add_address(actor_id, account_id, *, kind, line1, label="", city="", region="", country="", is_default=False):
    a = _own(m.CrmAccount, account_id, actor_id, "Account", lock=True)
    if kind not in m.AccountAddress.Kind.values or not (line1 or "").strip():
        raise _bad("A valid kind and an address line are required.", "invalid_address")
    first = not a.addresses.filter(kind=kind).exists()
    if is_default or first:
        a.addresses.filter(kind=kind, is_default=True).update(is_default=False)
    return m.AccountAddress.objects.create(account=a, kind=kind, label=label[:80], line1=line1.strip()[:200], city=city[:80], region=region[:80], country=country[:2].upper(), is_default=is_default or first)


@transaction.atomic
def delete_address(actor_id, address_id):
    addr = m.AccountAddress.objects.select_related("account").filter(pk=address_id).first()
    if addr is None:
        raise DomainError("Address not found.", code="not_found", status_code=404)
    _own(m.CrmAccount, addr.account_id, actor_id, "Address")
    kind, acct, was_default = addr.kind, addr.account, addr.is_default
    addr.delete()
    if was_default:
        nxt = acct.addresses.filter(kind=kind).order_by("created_at").first()
        if nxt:
            nxt.is_default = True
            nxt.save(update_fields=["is_default", "updated_at"])


def default_address(account, kind):
    return account.addresses.filter(kind=kind, is_default=True).first()


# ----------------------------------------------------------------------------- contacts
@transaction.atomic
def update_contact(actor_id, contact_id, **v):
    c = _own(m.Contact, contact_id, actor_id, "Contact", lock=True)
    if v.get("role") is not None and v["role"] and v["role"] not in CONTACT_ROLES:
        raise _bad("Unknown contact role.", "invalid_role")
    if v.get("preferred_channel") and v["preferred_channel"] not in CHANNELS:
        raise _bad("Unknown channel.", "invalid_channel")
    for f in ("first_name", "last_name", "email", "phone", "job_title", "role", "preferred_channel"):
        if v.get(f) is not None:
            if f == "first_name" and not v[f].strip():
                raise _bad("first_name is required.", "invalid_name")
            setattr(c, f, v[f])
    if "account_id" in v:
        c.account = _own(m.CrmAccount, v["account_id"], actor_id, "Account") if v["account_id"] else None
    c.save()
    return c


@transaction.atomic
def link_contact(actor_id, contact_id, account_id, role=""):
    c = _own(m.Contact, contact_id, actor_id, "Contact")
    a = _own(m.CrmAccount, account_id, actor_id, "Account")
    link, _ = m.ContactLink.objects.update_or_create(contact=c, account=a, defaults={"role": role[:40]})
    return link


@transaction.atomic
def set_consent(actor_id, contact_id, *, email=None, phone=None, sms=None, opt_out=None):
    """Record what the contact agreed to. `opt_out=True` is a global stop that overrides every channel flag."""
    c = _own(m.Contact, contact_id, actor_id, "Contact", lock=True)
    before = (c.consent_email, c.consent_phone, c.consent_sms, c.opted_out_at)
    for f, v in (("consent_email", email), ("consent_phone", phone), ("consent_sms", sms)):
        if v is not None:
            setattr(c, f, bool(v))
    if opt_out is True:
        c.opted_out_at = timezone.now()
        c.consent_email = c.consent_phone = c.consent_sms = False
    elif opt_out is False:
        c.opted_out_at = None
    c.consent_recorded_at = timezone.now()
    c.save()
    record_tenant_event(current_tenant(), "crm.consent.changed", actor_user_id=actor_id, target_type="Contact", target_id=c.id, metadata={"before": str(before[:3]), "after": str((c.consent_email, c.consent_phone, c.consent_sms)), "opt_out": str(c.opted_out_at is not None)})
    return c


def can_contact(contact, channel):
    """The single gate every outbound marketing or service message must pass."""
    if channel not in CHANNELS:
        raise _bad("Unknown channel.", "invalid_channel")
    if contact.opted_out_at:
        return False
    return {"EMAIL": contact.consent_email, "PHONE": contact.consent_phone, "SMS": contact.consent_sms}[channel]


@transaction.atomic
def add_contact_date(actor_id, contact_id, *, label, on_date, remind_days_before=7, yearly=True):
    c = _own(m.Contact, contact_id, actor_id, "Contact")
    if not (label or "").strip():
        raise _bad("A label is required.", "invalid_label")
    return m.ContactDate.objects.create(contact=c, label=label.strip()[:80], on_date=on_date, remind_days_before=int(remind_days_before), yearly=bool(yearly))


def upcoming_contact_dates(user_id, today=None, within_days=30):
    today = today or timezone.now().date()
    out = []
    for d in m.ContactDate.objects.select_related("contact").filter(contact__in=scope(m.Contact.objects.all(), user_id)):
        nxt = d.on_date
        if d.yearly:
            try:
                nxt = d.on_date.replace(year=today.year)
            except ValueError:
                nxt = d.on_date.replace(year=today.year, day=28)
            if nxt < today:
                nxt = nxt.replace(year=today.year + 1) if not (nxt.month == 2 and nxt.day == 29) else nxt.replace(year=today.year + 1, day=28)
        if today <= nxt <= today + timedelta(days=within_days):
            out.append({"contact": str(d.contact_id), "name": f"{d.contact.first_name} {d.contact.last_name}".strip(), "label": d.label, "date": str(nxt), "remind_on": str(nxt - timedelta(days=d.remind_days_before))})
    return sorted(out, key=lambda r: r["date"])


# ----------------------------------------------------------------------------- timeline
def account_timeline(user_id, account_id, limit=200):
    """One chronological view of everything that happened with a customer: activities, opportunities, quotations,
    orders, deliveries, invoices and their status. Newest first."""
    a = _own(m.CrmAccount, account_id, user_id, "Account")
    from modules.sales import models as sm

    ev = []
    for x in a.activities.select_related().all():
        ev.append((x.done_at or x.due_at or x.created_at, "activity", f"{x.type}: {x.subject}", str(x.id)))
    for o in a.opportunities.all():
        ev.append((o.created_at, "opportunity", f"Opportunity '{o.name}' opened ({o.amount} {o.currency})", str(o.id)))
        if o.closed_at:
            ev.append((o.closed_at, "opportunity", f"Opportunity '{o.name}' {o.status.lower()}" + (f": {o.lost_reason}" if o.lost_reason else ""), str(o.id)))
    for q in sm.Quotation.objects.filter(account=a):
        ev.append((q.created_at, "quotation", f"Quotation {q.number} {q.status.lower()} ({q.total} {q.currency})", str(q.id)))
    for so in sm.SalesOrder.objects.filter(account=a):
        ev.append((so.created_at, "order", f"Order {so.number} {so.status.lower()} ({so.total} {so.currency})", str(so.id)))
    for d in sm.Delivery.objects.filter(order__account=a).select_related("order"):
        ev.append((d.created_at, "delivery", f"Delivery {d.number} for {d.order.number}", str(d.id)))
    if a.partner_id:
        from modules.finance import models as fm

        for inv in fm.Invoice.objects.filter(partner_id=a.partner_id).exclude(status="VOID"):
            kind = "Credit note" if "CREDIT" in inv.kind else "Invoice"
            ev.append((inv.created_at, "invoice", f"{kind} {inv.number or '(draft)'} {inv.status.lower()} ({inv.total} {inv.currency})", str(inv.id)))
    for cs in a.cases.all():
        ev.append((cs.created_at, "case", f"Case {cs.number} {cs.status.lower()}: {cs.subject}", str(cs.id)))
    for h in a.history.all():
        ev.append((h.at, "change", f"{h.field}: {h.old or '-'} → {h.new or '-'}", str(h.id)))

    def at(x):
        t = x[0]
        return t if hasattr(t, "hour") and getattr(t, "tzinfo", None) else timezone.make_aware(__import__("datetime").datetime.combine(t, __import__("datetime").time.min)) if not hasattr(t, "hour") else timezone.make_aware(t)

    ev.sort(key=lambda r: at(r), reverse=True)
    return [{"at": at(r).isoformat(), "kind": r[1], "summary": r[2], "ref": r[3]} for r in ev[:limit]]
