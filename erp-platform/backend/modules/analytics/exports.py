"""Turn rows into CSV, Excel or PDF. Values that could be read as spreadsheet formulas are always written as text."""
import csv
import re
from datetime import datetime
from decimal import Decimal
from io import BytesIO, StringIO

from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed

FORMATS = {"CSV": ("text/csv", "csv"), "XLSX": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"), "PDF": ("application/pdf", "pdf")}
_NUMBER = re.compile(r"^-?(0|[1-9]\d{0,17})(\.\d+)?$")
_RISKY = ("=", "+", "-", "@", "\t", "\r")


def columns_of(rows, wanted=None):
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    if wanted:
        missing = [c for c in wanted if c not in cols] if rows else []
        if missing:
            raise ValidationFailed("Unknown column(s): " + ", ".join(missing), code="unknown_column")
        return list(wanted)
    return cols


def _text(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (dict, list)):
        return str(v)
    return str(v)


def _risky(s):
    return bool(s) and s[0] in _RISKY and not _NUMBER.match(s)


def check_limit(rows, fmt):
    limit = int(org.get_setting("analytics.pdf_row_limit" if fmt == "PDF" else "analytics.export_row_limit", 2000 if fmt == "PDF" else 50000))
    if len(rows) > limit:
        raise DomainError(f"The report has {len(rows)} rows; {fmt} exports are limited to {limit}. Narrow the filters.", code="too_many_rows", status_code=413)


def to_csv(rows, cols):
    out = StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    for r in rows:
        w.writerow([("'" + t if _risky(t) else t) for t in (_text(r.get(c)) for c in cols)])
    return out.getvalue().encode("utf-8-sig")


def to_xlsx(rows, cols, title, subtitle):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = re.sub(r"[\[\]\*\?/\\:]", " ", title)[:31] or "Report"
    ws.append(cols)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="1F3A5F")
        c.alignment = Alignment(vertical="center", wrap_text=True)
    for r in rows:
        line = []
        for c in cols:
            v = r.get(c)
            t = _text(v)
            if isinstance(v, bool) or v is None or isinstance(v, (dict, list)):
                line.append(t)
            elif isinstance(v, (int, float, Decimal)) or (isinstance(v, str) and _NUMBER.match(v)):
                line.append(float(v) if not isinstance(v, int) else v)
            else:
                line.append(t)
        ws.append(line)
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"  # never let a value that starts with = be evaluated as a formula
    ws.freeze_panes = "A2"
    if rows:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{len(rows) + 1}"
    for i, c in enumerate(cols, start=1):
        width = max([len(str(c))] + [len(_text(r.get(c))) for r in rows[:200]])
        ws.column_dimensions[get_column_letter(i)].width = min(max(width + 2, 10), 60)
    info = wb.create_sheet("About")
    info.append(["Report", title])
    info.append(["Parameters", subtitle])
    info.append(["Generated", datetime.now().strftime("%Y-%m-%d %H:%M")])
    info.append(["Rows", len(rows)])
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def to_pdf(rows, cols, title, subtitle):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    out = BytesIO()
    page = landscape(A4)
    doc = SimpleDocTemplate(out, pagesize=page, leftMargin=12 * mm, rightMargin=12 * mm, topMargin=14 * mm, bottomMargin=14 * mm, title=title)
    styles = getSampleStyleSheet()
    cell = styles["BodyText"].clone("cell")
    cell.fontSize, cell.leading = 7, 8.5
    head = styles["BodyText"].clone("head")
    head.fontSize, head.leading, head.textColor, head.fontName = 7.5, 9, colors.white, "Helvetica-Bold"
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    data = [[Paragraph(esc(str(c)), head) for c in cols]]
    for r in rows:
        data.append([Paragraph(esc(_text(r.get(c))[:120]), cell) for c in cols])
    width = page[0] - 24 * mm
    lengths = [max([len(str(c))] + [min(len(_text(r.get(c))), 40) for r in rows[:100]]) + 2 for c in cols]
    total = sum(lengths) or 1
    table = Table(data, colWidths=[width * n / total for n in lengths], repeatRows=1)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3A5F")), ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BBBBBB")),
                               ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F6FA")]), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story = [Paragraph(esc(title), styles["Title"]), Paragraph(esc(subtitle), styles["Normal"]), Paragraph(f"{len(rows)} row(s), generated {datetime.now():%Y-%m-%d %H:%M}", styles["Normal"]), Spacer(1, 6), table]

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.drawRightString(page[0] - 12 * mm, 8 * mm, f"Page {d.page}")
        canvas.restoreState()
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return out.getvalue()


def export(rows, fmt, title, subtitle="", wanted_columns=None):
    """Returns (bytes, content_type, extension)."""
    fmt = (fmt or "").upper()
    if fmt not in FORMATS:
        raise ValidationFailed("format must be CSV, XLSX or PDF.", code="invalid_format")
    check_limit(rows, fmt)
    cols = columns_of(rows, wanted_columns) or ["result"]
    if fmt == "CSV":
        data = to_csv(rows, cols)
    elif fmt == "XLSX":
        data = to_xlsx(rows, cols, title, subtitle)
    else:
        data = to_pdf(rows, cols, title, subtitle)
    return data, FORMATS[fmt][0], FORMATS[fmt][1]


def filename(title, ext, on):
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", title).strip("-").lower()[:60] or "report"
    return f"{safe}-{on:%Y%m%d}.{ext}"
