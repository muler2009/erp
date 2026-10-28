"""Financial reports computed from posted ledger lines only (POSTED and REVERSED entries; reversal entries
cancel them out). Amounts are in the base currency."""
from decimal import Decimal

from django.db.models import Sum

from modules.finance import models as m

ZERO = Decimal("0")
POSTED = ["POSTED", "REVERSED"]


def _sums(date_from=None, date_to=None):
    qs = m.JournalLine.objects.filter(entry__status__in=POSTED)
    if date_from:
        qs = qs.filter(entry__entry_date__gte=date_from)
    if date_to:
        qs = qs.filter(entry__entry_date__lte=date_to)
    return {r["account_id"]: (r["d"] or ZERO, r["c"] or ZERO) for r in qs.values("account_id").annotate(d=Sum("debit"), c=Sum("credit"))}


def _natural(acct, d, c):
    return d - c if acct.debit_normal else c - d


def trial_balance(as_of):
    sums = _sums(date_to=as_of)
    rows, td, tc = [], ZERO, ZERO
    for acct in m.Account.objects.filter(id__in=sums).order_by("code"):
        d, c = sums[acct.id]
        net = d - c
        rows.append({"code": acct.code, "name": acct.name, "type": acct.type, "debit": str(d), "credit": str(c), "balance_debit": str(net if net > 0 else ZERO), "balance_credit": str(-net if net < 0 else ZERO)})
        td += net if net > 0 else ZERO
        tc += -net if net < 0 else ZERO
    return {"as_of": str(as_of), "rows": rows, "total_debit": str(td), "total_credit": str(tc), "balanced": td == tc}


def profit_and_loss(date_from, date_to):
    sums = _sums(date_from, date_to)
    sections = {"REVENUE": [], "EXPENSE": []}
    totals = {"REVENUE": ZERO, "EXPENSE": ZERO}
    for acct in m.Account.objects.filter(id__in=sums, type__in=sections).order_by("code"):
        value = _natural(acct, *sums[acct.id])
        sections[acct.type].append({"code": acct.code, "name": acct.name, "amount": str(value)})
        totals[acct.type] += value
    return {"from": str(date_from), "to": str(date_to), "revenue": sections["REVENUE"], "expenses": sections["EXPENSE"], "total_revenue": str(totals["REVENUE"]), "total_expenses": str(totals["EXPENSE"]), "net_profit": str(totals["REVENUE"] - totals["EXPENSE"])}


def balance_sheet(as_of):
    sums = _sums(date_to=as_of)
    groups = {"ASSET": [], "LIABILITY": [], "EQUITY": []}
    totals = {"ASSET": ZERO, "LIABILITY": ZERO, "EQUITY": ZERO}
    earnings = ZERO
    for acct in m.Account.objects.filter(id__in=sums).order_by("code"):
        value = _natural(acct, *sums[acct.id])
        if acct.type in groups:
            groups[acct.type].append({"code": acct.code, "name": acct.name, "amount": str(value)})
            totals[acct.type] += value
        else:  # unclosed revenue/expense accounts roll into earnings until a year-end close exists
            earnings += value if acct.type == "REVENUE" else -value
    equity_total = totals["EQUITY"] + earnings
    return {"as_of": str(as_of), "assets": groups["ASSET"], "liabilities": groups["LIABILITY"], "equity": groups["EQUITY"], "current_earnings": str(earnings),
            "total_assets": str(totals["ASSET"]), "total_liabilities": str(totals["LIABILITY"]), "total_equity": str(equity_total),
            "balanced": totals["ASSET"] == totals["LIABILITY"] + equity_total}


def ledger(account, date_from=None, date_to=None):
    opening = ZERO
    if date_from:
        agg = m.JournalLine.objects.filter(account=account, entry__status__in=POSTED, entry__entry_date__lt=date_from).aggregate(d=Sum("debit"), c=Sum("credit"))
        opening = _natural(account, agg["d"] or ZERO, agg["c"] or ZERO)
    qs = m.JournalLine.objects.filter(account=account, entry__status__in=POSTED).select_related("entry").order_by("entry__entry_date", "entry__number", "line_no")
    if date_from:
        qs = qs.filter(entry__entry_date__gte=date_from)
    if date_to:
        qs = qs.filter(entry__entry_date__lte=date_to)
    running, rows = opening, []
    for l in qs:
        running += _natural(account, l.debit, l.credit)
        rows.append({"date": str(l.entry.entry_date), "entry": l.entry.number, "description": l.description or l.entry.memo, "debit": str(l.debit), "credit": str(l.credit), "balance": str(running)})
    return {"account": account.code, "name": account.name, "opening_balance": str(opening), "rows": rows, "closing_balance": str(running)}
