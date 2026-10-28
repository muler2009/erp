from datetime import date

from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate
from modules.finance import models as m
from modules.finance import reports, services


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _account(a):
    return {"id": str(a.id), "code": a.code, "name": a.name, "type": a.type, "parent": _s(a.parent_id), "is_postable": a.is_postable, "is_control": a.is_control, "system_key": a.system_key, "is_active": a.is_active}


def _entry(e, lines=False):
    d = {"id": str(e.id), "number": e.number, "entry_date": str(e.entry_date), "memo": e.memo, "status": e.status, "source_type": e.source_type, "source_id": e.source_id, "posted_at": e.posted_at, "reversed_by": _s(e.reversed_by_id)}
    if lines:
        d["lines"] = [{"line_no": l.line_no, "account": l.account.code, "account_name": l.account.name, "debit": str(l.debit), "credit": str(l.credit), "description": l.description} for l in e.lines.select_related("account")]
    return d


def _invoice(i, lines=False):
    d = {"id": str(i.id), "kind": i.kind, "number": i.number, "supplier_ref": i.supplier_ref, "partner": {"id": str(i.partner_id), "name": i.partner.name}, "invoice_date": str(i.invoice_date), "due_date": _s(i.due_date), "currency": i.currency, "status": i.status,
         "subtotal": str(i.subtotal), "tax_total": str(i.tax_total), "total": str(i.total), "paid_amount": str(i.paid_amount), "outstanding": str(i.outstanding), "total_base": _s(i.total_base), "fx_rate": _s(i.fx_rate),
         "credit_for": _s(i.credit_for_id), "journal_entry": _s(i.journal_entry_id), "workflow_instance_id": _s(i.workflow_instance_id), "version": i.version}
    if lines:
        d["lines"] = [{"line_no": l.line_no, "description": l.description, "quantity": str(l.quantity), "unit_price": str(l.unit_price), "account": l.account.code, "tax_rate": _s(l.tax_rate_id), "line_total": str(l.line_total), "tax_amount": str(l.tax_amount)} for l in i.lines.select_related("account")]
    return d


def _payment(p):
    return {"id": str(p.id), "number": p.number, "kind": p.kind, "partner": str(p.partner_id), "bank_account": str(p.bank_account_id), "payment_date": str(p.payment_date), "currency": p.currency, "amount": str(p.amount), "amount_base": str(p.amount_base), "journal_entry": str(p.journal_entry_id),
            "allocations": [{"invoice": str(a.invoice_id), "amount": str(a.amount)} for a in p.allocations.all()]}


# ----------------------------------------------------------------------------- reference data
class AccountIn(serializers.Serializer):
    code = serializers.CharField(max_length=20)
    name = serializers.CharField(max_length=200)
    type = serializers.ChoiceField(choices=m.Account.Type.values)
    parent = serializers.UUIDField(required=False, allow_null=True)
    is_postable = serializers.BooleanField(default=True)


class Accounts(APIView):
    def get_permissions(self):
        return perm("finance.accounts.manage" if self.request.method == "POST" else "finance.accounts.view")

    def get(self, request):
        return paginate(request, m.Account.objects.all(), _account, ordering="code")

    def post(self, request):
        v = AccountIn(data=request.data)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        return Response(_account(services.create_account(request.user.id, code=d["code"], name=d["name"], type=d["type"], parent_id=d.get("parent"), is_postable=d["is_postable"], request=request)), status=201)


class AccountDetail(APIView):
    def get_permissions(self):
        return perm("finance.accounts.manage" if self.request.method == "PATCH" else "finance.accounts.view")

    def get(self, request, pk):
        acct = get_object_or_404(m.Account, pk=pk)
        return Response({**_account(acct), "balance": str(services.account_balance(acct))})

    def patch(self, request, pk):
        acct = services.update_account(request.user.id, pk, name=request.data.get("name"), is_active=request.data.get("is_active"), request=request)
        return Response(_account(acct))


class TaxRates(APIView):
    def get_permissions(self):
        return perm("finance.accounts.manage" if self.request.method == "POST" else "finance.accounts.view")

    def get(self, request):
        return paginate(request, m.TaxRate.objects.all(), lambda t: {"id": str(t.id), "code": t.code, "name": t.name, "kind": t.kind, "rate": str(t.rate), "account": str(t.account_id), "is_active": t.is_active}, ordering="code")

    def post(self, request):
        b = request.data
        t = services.create_tax_rate(request.user.id, code=b.get("code", ""), name=b.get("name", ""), kind=b.get("kind", ""), rate=b.get("rate"), account_id=b.get("account"))
        return Response({"id": str(t.id), "code": t.code, "rate": str(t.rate)}, status=201)


class BankAccounts(APIView):
    def get_permissions(self):
        return perm("finance.accounts.manage" if self.request.method == "POST" else "finance.accounts.view")

    def get(self, request):
        return paginate(request, m.BankAccount.objects.all(), lambda b: {"id": str(b.id), "name": b.name, "currency": b.currency, "gl_account": str(b.gl_account_id), "is_cash": b.is_cash, "is_active": b.is_active})

    def post(self, request):
        b = request.data
        row = services.create_bank_account(request.user.id, name=b.get("name", ""), currency=b.get("currency", ""), gl_account_id=b.get("gl_account"), account_number=b.get("account_number", ""), is_cash=bool(b.get("is_cash", False)))
        return Response({"id": str(row.id), "name": row.name}, status=201)


class Partners(APIView):
    def get_permissions(self):
        return perm("finance.invoice.create" if self.request.method == "POST" else "finance.invoice.view")

    def get(self, request):
        return paginate(request, m.Partner.objects.filter(is_active=True), lambda p: {"id": str(p.id), "name": p.name, "is_customer": p.is_customer, "is_supplier": p.is_supplier, "tax_id": p.tax_id})

    def post(self, request):
        b = request.data
        p = services.create_partner(request.user.id, name=b.get("name", ""), is_customer=bool(b.get("is_customer")), is_supplier=bool(b.get("is_supplier")), tax_id=b.get("tax_id", ""))
        return Response({"id": str(p.id), "name": p.name}, status=201)


# ----------------------------------------------------------------------------- journals
class LineIn(serializers.Serializer):
    account = serializers.CharField()
    debit = serializers.DecimalField(max_digits=20, decimal_places=4, required=False, default=0)
    credit = serializers.DecimalField(max_digits=20, decimal_places=4, required=False, default=0)
    description = serializers.CharField(required=False, allow_blank=True, default="", max_length=300)
    cost_center_id = serializers.UUIDField(required=False, allow_null=True, default=None)


class JournalIn(serializers.Serializer):
    entry_date = serializers.DateField()
    memo = serializers.CharField(required=False, allow_blank=True, default="", max_length=500)
    lines = LineIn(many=True)


class Journals(APIView):
    def get_permissions(self):
        return perm("finance.journal.create" if self.request.method == "POST" else "finance.accounts.view")

    def get(self, request):
        qs = m.JournalEntry.objects.all()
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _entry)

    def post(self, request):
        v = JournalIn(data=request.data)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        entry = services.create_journal(request.user.id, entry_date=d["entry_date"], memo=d["memo"], lines=[dict(l) for l in d["lines"]], request=request)
        return Response(_entry(entry, lines=True), status=201)


class JournalDetail(APIView):
    def get_permissions(self):
        return perm("finance.journal.create" if self.request.method == "DELETE" else "finance.accounts.view")

    def get(self, request, pk):
        return Response(_entry(get_object_or_404(m.JournalEntry, pk=pk), lines=True))

    def delete(self, request, pk):
        services.delete_draft_journal(request.user.id, pk)
        return Response(status=204)


class JournalPost(APIView):
    def get_permissions(self):
        return perm("finance.journal.post")

    def post(self, request, pk):
        return Response(_entry(services.post_journal(request.user.id, pk, request=request), lines=True))


class JournalReverse(APIView):
    def get_permissions(self):
        return perm("finance.journal.post")

    def post(self, request, pk):
        rdate = request.data.get("date")
        rev = services.reverse_journal(request.user.id, pk, reversal_date=date.fromisoformat(rdate) if rdate else None, memo=request.data.get("memo", ""), request=request)
        return Response(_entry(rev, lines=True), status=201)


# ----------------------------------------------------------------------------- invoices
class InvoiceLineIn(serializers.Serializer):
    description = serializers.CharField(max_length=300)
    quantity = serializers.DecimalField(max_digits=18, decimal_places=4)
    unit_price = serializers.DecimalField(max_digits=20, decimal_places=4)
    account = serializers.UUIDField()
    tax_rate = serializers.UUIDField(required=False, allow_null=True, default=None)


class InvoiceIn(serializers.Serializer):
    kind = serializers.ChoiceField(choices=m.Invoice.Kind.values)
    partner = serializers.UUIDField()
    invoice_date = serializers.DateField()
    due_date = serializers.DateField(required=False, allow_null=True)
    currency = serializers.CharField(required=False, max_length=3)
    supplier_ref = serializers.CharField(required=False, allow_blank=True, default="", max_length=60)
    credit_for = serializers.UUIDField(required=False, allow_null=True)
    lines = InvoiceLineIn(many=True, allow_empty=False)


class Invoices(APIView):
    def get_permissions(self):
        return perm("finance.invoice.create" if self.request.method == "POST" else "finance.invoice.view")

    def get(self, request):
        qs = m.Invoice.objects.select_related("partner")
        for f in ("kind", "status"):
            if request.query_params.get(f):
                qs = qs.filter(**{f: request.query_params[f]})
        return paginate(request, qs, _invoice)

    def post(self, request):
        v = InvoiceIn(data=request.data)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        inv = services.create_invoice(request.user.id, kind=d["kind"], partner_id=d["partner"], invoice_date=d["invoice_date"], due_date=d.get("due_date"), currency=d.get("currency"), lines=[{**l, "account": str(l["account"]), "tax_rate": str(l["tax_rate"]) if l["tax_rate"] else None} for l in d["lines"]], supplier_ref=d["supplier_ref"], credit_for_id=d.get("credit_for"), request=request)
        return Response(_invoice(inv, lines=True), status=201)


class InvoiceDetail(APIView):
    def get_permissions(self):
        return perm("finance.invoice.create" if self.request.method == "PUT" else "finance.invoice.view")

    def get(self, request, pk):
        return Response(_invoice(get_object_or_404(m.Invoice.objects.select_related("partner"), pk=pk), lines=True))

    def put(self, request, pk):
        v = InvoiceIn(data=request.data, partial=True)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        if "lines" not in d:
            raise ValidationFailed("lines are required.", code="no_lines")
        inv = services.update_invoice(request.user.id, pk, lines=[{**l, "account": str(l["account"]), "tax_rate": str(l["tax_rate"]) if l["tax_rate"] else None} for l in d["lines"]], invoice_date=d.get("invoice_date"), due_date=d.get("due_date"), supplier_ref=d.get("supplier_ref"), expected_version=request.data.get("version"))
        return Response(_invoice(inv, lines=True))


def _action(permission, fn):
    class View(APIView):
        def get_permissions(self):
            return perm(permission)

        def post(self, request, pk):
            inv = fn(request.user.id, pk) if fn is not services.post_invoice else fn(request.user.id, pk, request=request)
            return Response(_invoice(m.Invoice.objects.select_related("partner").get(pk=inv.pk), lines=True))

    return View


InvoiceSubmit = _action("finance.invoice.create", services.submit_invoice)
InvoiceApprove = _action("finance.invoice.approve", services.approve_invoice)
InvoicePost = _action("finance.invoice.approve", services.post_invoice)
InvoiceVoid = _action("finance.invoice.create", services.void_invoice)


class CreditApply(APIView):
    def get_permissions(self):
        return perm("finance.invoice.approve")

    def post(self, request, pk):
        s = services.apply_credit_note(request.user.id, pk, request.data.get("invoice"), request.data.get("amount"))
        return Response({"id": str(s.id), "amount": str(s.amount)}, status=201)


# ----------------------------------------------------------------------------- payments
class PaymentIn(serializers.Serializer):
    kind = serializers.ChoiceField(choices=m.Payment.Kind.values)
    partner = serializers.UUIDField()
    bank_account = serializers.UUIDField()
    payment_date = serializers.DateField()
    memo = serializers.CharField(required=False, allow_blank=True, default="", max_length=300)
    allocations = serializers.ListField(child=serializers.DictField(), allow_empty=False)


class Payments(APIView):
    def get_permissions(self):
        return perm("finance.payment.release" if self.request.method == "POST" else "finance.invoice.view")

    def get(self, request):
        return paginate(request, m.Payment.objects.prefetch_related("allocations"), _payment)

    def post(self, request):
        key = request.headers.get("Idempotency-Key", "")
        v = PaymentIn(data=request.data)
        v.is_valid(raise_exception=True)
        d = v.validated_data
        payment, created = services.record_payment(request.user.id, idempotency_key=key, kind=d["kind"], partner_id=d["partner"], bank_account_id=d["bank_account"], payment_date=d["payment_date"], allocations=d["allocations"], memo=d["memo"], request=request)
        response = Response(_payment(payment), status=201 if created else 200)
        response["Idempotent-Replay"] = "false" if created else "true"
        return response


# ----------------------------------------------------------------------------- reports
def _date(request, name, default=None, required=False):
    raw = request.query_params.get(name)
    if not raw:
        if required:
            raise ValidationFailed(f"{name} is required (YYYY-MM-DD).", code="invalid_date")
        return default
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValidationFailed(f"{name} must be YYYY-MM-DD.", code="invalid_date")


class TrialBalance(APIView):
    def get_permissions(self):
        return perm("reports.financial.view")

    def get(self, request):
        return Response(reports.trial_balance(_date(request, "as_of", date.today())))


class ProfitLoss(APIView):
    def get_permissions(self):
        return perm("reports.financial.view")

    def get(self, request):
        return Response(reports.profit_and_loss(_date(request, "from", required=True), _date(request, "to", required=True)))


class BalanceSheet(APIView):
    def get_permissions(self):
        return perm("reports.financial.view")

    def get(self, request):
        return Response(reports.balance_sheet(_date(request, "as_of", date.today())))


class Ledger(APIView):
    def get_permissions(self):
        return perm("reports.financial.view")

    def get(self, request):
        acct = get_object_or_404(m.Account, code=request.query_params.get("account", ""))
        return Response(reports.ledger(acct, _date(request, "from"), _date(request, "to")))
