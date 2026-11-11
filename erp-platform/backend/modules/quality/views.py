"""Quality API. Each endpoint is a row in ROUTES: path, then method -> (permission, handler). Handlers call services only."""
from datetime import date

from django.http import HttpResponse
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.quality import analytics, approvals, audits, calibration, complaints, core, holds, inspections, ncr, planning, projectqa, risks, suppliers
from modules.quality import models as m
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate

DATE_KEYS = {"scheduled_for", "planned_start", "planned_end", "valid_from", "valid_to", "period", "date_from", "date_to", "effective_on", "requested_for", "issued_on", "expires_on", "detected_on",
             "due_date", "target_date", "next_review_on", "performed_on", "received_on", "customer_confirmed_on", "last_calibrated_on", "incurred_on", "effective_from"}
EVIDENCE_TYPES = {"ncr", "capa", "inspection", "audit", "complaint", "inspection_request", "equipment", "hold", "scar", "finding", "risk", "initiative", "punch"}


def _body(request):
    data = request.data
    if hasattr(data, "dict"):
        data = data.dict()
    data = dict(data)
    for k in DATE_KEYS & set(data):
        v = data[k]
        if isinstance(v, str) and v:
            try:
                data[k] = date.fromisoformat(v)
            except ValueError:
                raise ValidationFailed(f"{k} must be YYYY-MM-DD.", code="invalid_date")
        elif v == "":
            data[k] = None
    return data


def _q(request):
    return _body_query(request.query_params)


def _body_query(qp):
    d = {k: v for k, v in qp.items() if v != ""}
    for k in DATE_KEYS & set(d):
        try:
            d[k] = date.fromisoformat(d[k])
        except ValueError:
            raise ValidationFailed(f"{k} must be YYYY-MM-DD.", code="invalid_date")
    return d


def _policy(self):
    entry = self.table.get(self.request.method)
    return [require(entry[0])()] if entry else [require("quality.view")()]


class _Base(APIView):
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    table = {}

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        cls.get_permissions = _policy

    def dispatch(self, request, *a, **kw):
        return super().dispatch(request, *a, **kw)

    def _run(self, request, kw):
        fn = self.table[request.method][1]
        out = fn(request, *[], **kw)
        if isinstance(out, HttpResponse):
            return out
        data, status = out if isinstance(out, tuple) else (out, 200)
        return Response(data, status=status)

    def get(self, request, **kw):
        return self._run(request, kw)

    post = patch = put = delete = get


def lst(request, qs, ser):
    return paginate(request, qs, ser)


def me(request):
    return request.user.id


# ------------------------------------------------------------------------------ handlers
def h_dashboard(r, **kw):
    return analytics.dashboard()


def h_config_list(r, kind):
    return [core.config_dict(c) for c in core.config_items(kind.upper(), active_only=False)]


def h_config_save(r, kind):
    b = _body(r)
    return core.config_dict(core.save_config(me(r), kind=kind.upper(), code=b.get("code", ""), name=b.get("name", ""), rank=b.get("rank", 1), requires_capa=b.get("requires_capa", False), is_active=b.get("is_active", True))), 201


def h_evidence_list(r, record_type, pk):
    if record_type not in EVIDENCE_TYPES:
        raise core.nf()
    return core.list_evidence(record_type, pk)


def h_evidence_add(r, record_type, pk):
    if record_type not in EVIDENCE_TYPES:
        raise core.nf()
    f = r.FILES.get("file")
    if f is None:
        raise ValidationFailed("Attach a file.", code="file_required")
    b = _body(r)
    ev = core.add_evidence(me(r), record_type, pk, filename=f.name, data=f.read(), kind=b.get("kind", "EVIDENCE"), description=b.get("description", ""))
    return {"id": str(ev.id), "file_id": str(ev.file_id), "file_name": ev.file_name}, 201


def h_actions_list(r, parent_type, pk):
    return core.list_actions(parent_type, pk)


def h_action_add(r, parent_type, pk):
    b = _body(r)
    return core.action_dict(core.add_action(me(r), parent_type, pk, action_type=b.get("action_type", ""), description=b.get("description", ""), owner_id=b.get("owner_id"), due_date=b.get("due_date"))), 201


def h_action_done(r, pk):
    return core.action_dict(core.complete_action(me(r), pk, note=_body(r).get("note", "")))


def h_action_verify(r, pk):
    return core.action_dict(core.verify_action(me(r), pk))


def h_action_cancel(r, pk):
    return core.action_dict(core.cancel_action(me(r), pk, reason=_body(r).get("reason", "")))


def h_my_actions(r):
    return core.my_actions(me(r))


def h_cost_add(r, ref_type, pk):
    b = _body(r)
    c = core.record_cost(me(r), ref_type, pk, category=b.get("category"), amount=b.get("amount"), incurred_on=b.get("incurred_on"), description=b.get("description", ""))
    return {"id": str(c.id)}, 201


# plans
def h_plans(r):
    q = _q(r)
    return lst(r, planning.list_plans(q.get("status"), q.get("scope_type")), planning.plan_dict)


def h_plan_create(r):
    return planning.plan_dict(planning.create_plan(me(r), _body(r))), 201


def h_plan_get(r, pk):
    return planning.plan_dict(planning.get_plan(pk), detail=True)


def h_plan_update(r, pk):
    return planning.plan_dict(planning.update_plan(me(r), pk, _body(r)))


def h_plan_objective(r, pk):
    return planning.objective_dict(planning.add_objective(me(r), pk, _body(r))), 201


def h_plan_cp(r, pk):
    c = planning.add_control_point(me(r), pk, _body(r))
    return {"id": str(c.id)}, 201


def h_plan_submit(r, pk):
    return planning.plan_dict(planning.submit_plan(me(r), pk, comment=_body(r).get("comment", "")))


def h_plan_resubmit(r, pk):
    approvals.resubmit(me(r), "quality.plan", pk, comment=_body(r).get("comment", ""))
    return planning.plan_dict(planning.get_plan(pk))


def h_plan_revise(r, pk):
    return planning.plan_dict(planning.revise_plan(me(r), pk, reason=_body(r).get("reason", "")))


def h_objective_measure(r, pk):
    b = _body(r)
    planning.measure_objective(me(r), pk, period=b.get("period"), value=b.get("value"))
    return {"ok": True}, 201


# standards
def h_standards(r):
    return lst(r, m.Standard.objects.all(), planning.standard_dict)


def h_standard_save(r):
    return planning.standard_dict(planning.save_standard(me(r), _body(r))), 201


def h_standard_get(r, pk):
    s = m.Standard.objects.filter(pk=pk).first()
    if s is None:
        raise core.nf("Standard")
    return planning.standard_dict(s, detail=True)


def h_standard_update(r, pk):
    return planning.standard_dict(planning.save_standard(me(r), {"code": "x", "name": "x", **_body(r)}, pk=pk))


def h_standard_version(r, pk):
    b = _body(r)
    return planning.standard_dict(planning.new_standard_version(me(r), pk, version=b.get("version", ""), summary=b.get("summary", ""), effective_on=b.get("effective_on"), impact=b.get("impact", "")))


def h_requirement_add(r, pk):
    return planning.requirement_dict(planning.add_requirement(me(r), pk, _body(r))), 201


def h_requirement_map(r, pk):
    b = _body(r)
    planning.map_document(me(r), pk, document_id=b.get("document_id"), note=b.get("note", ""))
    return {"ok": True}, 201


def h_requirement_assess(r, pk):
    b = _body(r)
    planning.assess(me(r), pk, status=b.get("status"), gap=b.get("gap", ""), notes=b.get("notes", ""), evidence_document_id=b.get("evidence_document_id"), next_review_on=b.get("next_review_on"))
    return planning.requirement_dict(m.Requirement.objects.get(pk=pk))


def h_compliance(r):
    q = _q(r)
    return planning.compliance_summary(q.get("standard_id"), q.get("department_id"))


# inspections
def h_ip_list(r):
    return lst(r, inspections.list_plans(**_q(r)), inspections.plan_dict)


def h_ip_create(r):
    return inspections.plan_dict(inspections.create_plan(me(r), _body(r))), 201


def h_ip_get(r, pk):
    return inspections.plan_dict(inspections.get_plan(pk), detail=True)


def h_ip_param(r, pk):
    return inspections.param_dict(inspections.add_parameter(me(r), pk, _body(r))), 201


def h_param_retire(r, pk):
    inspections.retire_parameter(me(r), pk)
    return {"ok": True}


def h_insp_list(r):
    return lst(r, inspections.list_inspections(**_q(r)), inspections.inspection_dict)


def h_insp_schedule(r):
    return inspections.inspection_dict(inspections.schedule(me(r), _body(r))), 201


def h_insp_get(r, pk):
    return inspections.inspection_dict(inspections.get_inspection(pk), detail=True)


def h_insp_start(r, pk):
    return inspections.inspection_dict(inspections.start(me(r), pk, equipment_ids=_body(r).get("equipment_ids", [])))


def h_insp_result(r, pk):
    b = _body(r)
    return inspections.result_dict(inspections.record_result(me(r), pk, parameter_id=b.get("parameter_id"), value=b.get("value"), text=b.get("text", ""), comment=b.get("comment", ""),
                                                             correction_reason=b.get("correction_reason", ""))), 201


def h_insp_defect(r, pk):
    b = _body(r)
    d = inspections.record_defect(me(r), pk, defect_code=b.get("defect_code", ""), quantity=b.get("quantity"), note=b.get("note", ""), lot_number=b.get("lot_number", ""))
    return {"id": str(d.id)}, 201


def h_insp_complete(r, pk):
    b = _body(r)
    return inspections.inspection_dict(inspections.complete(me(r), pk, quantity_accepted=b.get("quantity_accepted"), quantity_rejected=b.get("quantity_rejected"), summary=b.get("summary", ""),
                                                            accept_conditionally=bool(b.get("accept_conditionally")), conditional_note=b.get("conditional_note", "")), detail=True)


def h_insp_cancel(r, pk):
    return inspections.inspection_dict(inspections.cancel(me(r), pk, reason=_body(r).get("reason", "")))


def h_insp_reinspect(r, pk):
    b = _body(r)
    return inspections.inspection_dict(inspections.reinspect(me(r), pk, scheduled_for=b.get("scheduled_for"), inspector_id=b.get("inspector_id"))), 201


# holds
def h_holds(r):
    q = _q(r)
    return lst(r, holds.list_holds(q.get("status"), q.get("product_id")), holds.hold_dict)


def h_hold_place(r):
    b = _body(r)
    return holds.hold_dict(holds.place_hold(me(r), product_id=b.get("product_id"), reason=b.get("reason", ""), lot_number=b.get("lot_number", ""), quantity=b.get("quantity") or 0,
                                            source_type=b.get("source_type", ""), source_id=b.get("source_id"))), 201


def h_hold_get(r, pk):
    return holds.get_hold(pk)


def h_hold_disposition(r, pk):
    b = _body(r)
    return holds.hold_dict(holds.decide_disposition(me(r), pk, disposition=b.get("disposition", ""), note=b.get("note", "")))


def h_hold_release(r, pk):
    return holds.hold_dict(holds.release_hold(me(r), pk, note=_body(r).get("note", "")))


def h_hold_reject(r, pk):
    return holds.hold_dict(holds.reject_hold(me(r), pk, note=_body(r).get("note", "")))


# NCR
def h_ncr_list(r):
    q = _q(r)
    q["open"] = q.get("open") in ("1", "true", "True")
    return lst(r, ncr.list_ncrs(**q), ncr.ncr_dict)


def h_ncr_raise(r):
    return ncr.ncr_dict(ncr.raise_ncr(me(r), _body(r))), 201


def h_ncr_get(r, pk):
    return ncr.ncr_dict(ncr.get_ncr(pk), detail=True)


def h_ncr_update(r, pk):
    return ncr.ncr_dict(ncr.update_ncr(me(r), pk, _body(r)))


def h_ncr_contain(r, pk):
    b = _body(r)
    return ncr.ncr_dict(ncr.contain(me(r), pk, containment=b.get("containment", ""), place_hold=bool(b.get("place_hold"))))


def h_ncr_assign(r, pk):
    return ncr.ncr_dict(ncr.assign(me(r), pk, investigator_id=_body(r).get("investigator_id")))


def h_ncr_submit(r, pk):
    return ncr.ncr_dict(ncr.submit_for_approval(me(r), pk, comment=_body(r).get("comment", "")))


def h_ncr_resubmit(r, pk):
    return ncr.ncr_dict(ncr.resubmit(me(r), pk, comment=_body(r).get("comment", "")))


def h_ncr_implement(r, pk):
    return ncr.ncr_dict(ncr.start_implementation(me(r), pk))


def h_ncr_verify(r, pk):
    return ncr.ncr_dict(ncr.submit_for_verification(me(r), pk))


def h_ncr_capa(r, pk):
    b = _body(r)
    return ncr.capa_dict(ncr.create_capa(me(r), pk, owner_id=b.get("owner_id"), reviewer_id=b.get("reviewer_id"), due_date=b.get("due_date"), kind=b.get("kind", "CORRECTIVE"))), 201


def h_ncr_close(r, pk):
    return ncr.ncr_dict(ncr.close_ncr(me(r), pk, note=_body(r).get("note", "")))


def h_ncr_reopen(r, pk):
    return ncr.ncr_dict(ncr.reopen(me(r), pk, reason=_body(r).get("reason", "")))


def h_ncr_dismiss(r, pk):
    return ncr.ncr_dict(ncr.reject_ncr(me(r), pk, reason=_body(r).get("reason", "")))


# CAPA
def h_capa_list(r):
    q = _q(r)
    q["overdue"] = q.get("overdue") in ("1", "true", "True")
    return lst(r, ncr.list_capas(**q), ncr.capa_dict)


def h_capa_create(r):
    return ncr.capa_dict(ncr.create_capa_record(me(r), _body(r))), 201


def h_capa_get(r, pk):
    return ncr.capa_dict(ncr.get_capa(pk), detail=True)


def h_capa_update(r, pk):
    return ncr.capa_dict(ncr.update_capa(me(r), pk, _body(r)))


def h_capa_rca(r, pk):
    b = _body(r)
    a = ncr.add_root_cause(me(r), pk, method=b.get("method", ""), conclusion=b.get("conclusion", ""), details=b.get("details"))
    return {"id": str(a.id)}, 201


def h_capa_submit(r, pk):
    return ncr.capa_dict(ncr.submit_capa(me(r), pk, comment=_body(r).get("comment", "")))


def h_capa_resubmit(r, pk):
    return ncr.capa_dict(ncr.resubmit_capa(me(r), pk, comment=_body(r).get("comment", "")))


def h_capa_start(r, pk):
    return ncr.capa_dict(ncr.start_capa(me(r), pk))


def h_capa_implemented(r, pk):
    return ncr.capa_dict(ncr.mark_implemented(me(r), pk, note=_body(r).get("note", "")))


def h_capa_effectiveness(r, pk):
    b = _body(r)
    return ncr.capa_dict(ncr.verify_effectiveness(me(r), pk, effective=bool(b.get("effective")), notes=b.get("notes", "")))


def h_capa_cancel(r, pk):
    return ncr.capa_dict(ncr.cancel_capa(me(r), pk, reason=_body(r).get("reason", "")))


# audits
def h_audit_list(r):
    return lst(r, audits.list_audits(**_q(r)), audits.audit_dict)


def h_audit_schedule(r):
    return audits.audit_dict(audits.schedule(me(r), _body(r))), 201


def h_audit_get(r, pk):
    return audits.audit_dict(audits.get_audit(pk), detail=True)


def h_audit_start(r, pk):
    return audits.audit_dict(audits.start(me(r), pk))


def h_audit_item(r, pk):
    b = _body(r)
    return audits.checklist_dict(audits.add_checklist_item(me(r), pk, question=b.get("question", ""), requirement_id=b.get("requirement_id"), procedure_document_id=b.get("procedure_document_id"))), 201


def h_item_answer(r, pk):
    b = _body(r)
    return audits.checklist_dict(audits.answer(me(r), pk, response=b.get("response", ""), note=b.get("note", "")))


def h_audit_finding(r, pk):
    return audits.finding_dict(audits.raise_finding(me(r), pk, _body(r))), 201


def h_audit_report(r, pk):
    return audits.audit_dict(audits.report(me(r), pk, summary=_body(r).get("summary", "")))


def h_audit_close(r, pk):
    return audits.audit_dict(audits.close_audit(me(r), pk))


def h_audit_cancel(r, pk):
    return audits.audit_dict(audits.cancel(me(r), pk, reason=_body(r).get("reason", "")))


def h_template_list(r):
    return [{"id": str(t.id), "name": t.name, "audit_type": t.audit_type, "questions": t.questions, "is_active": t.is_active} for t in m.ChecklistTemplate.objects.all()]


def h_template_save(r):
    t = audits.save_template(me(r), _body(r))
    return {"id": str(t.id), "name": t.name}, 201


def h_finding_list(r):
    q = _q(r)
    q["overdue"] = q.get("overdue") in ("1", "true", "True")
    return lst(r, audits.list_findings(**q), audits.finding_dict)


def h_finding_get(r, pk):
    return audits.finding_dict(audits.get_finding(pk))


def h_finding_assign(r, pk):
    b = _body(r)
    return audits.finding_dict(audits.assign_finding(me(r), pk, owner_id=b.get("owner_id"), due_date=b.get("due_date")))


def h_finding_capa(r, pk):
    b = _body(r)
    return ncr.capa_dict(audits.finding_capa(me(r), pk, owner_id=b.get("owner_id"), reviewer_id=b.get("reviewer_id"), due_date=b.get("due_date"), kind=b.get("kind", "CORRECTIVE"))), 201


def h_finding_close(r, pk):
    return audits.finding_dict(audits.close_finding(me(r), pk, note=_body(r).get("note", "")))


# suppliers
def h_sup_profile(r, pk):
    return suppliers.profile_dict(suppliers.profile(pk))


def h_sup_status(r, pk):
    b = _body(r)
    return suppliers.profile_dict(suppliers.set_status(me(r), pk, status=b.get("status", ""), reason=b.get("reason", ""), min_score=b.get("min_score"), max_rejection_rate=b.get("max_rejection_rate"), criteria_note=b.get("criteria_note")))


def h_sup_cert(r, pk):
    return suppliers.cert_dict(suppliers.add_certificate(me(r), pk, _body(r))), 201


def h_sup_eval(r, pk):
    b = _body(r)
    return suppliers.evaluation_dict(suppliers.evaluate(me(r), pk, date_from=b.get("date_from"), date_to=b.get("date_to"), apply_status=bool(b.get("apply_status")))), 201


def h_sup_evals(r, pk):
    return suppliers.evaluation_list(pk)


def h_scar_list(r):
    return lst(r, suppliers.list_scars(**_q(r)), suppliers.scar_dict)


def h_scar_raise(r):
    return suppliers.scar_dict(suppliers.raise_scar(me(r), _body(r))), 201


def h_scar_get(r, pk):
    return suppliers.scar_dict(suppliers.get_scar(pk))


def h_scar_response(r, pk):
    return suppliers.scar_dict(suppliers.record_response(me(r), pk, response=_body(r).get("response", "")))


def h_scar_review(r, pk):
    b = _body(r)
    return suppliers.scar_dict(suppliers.review_response(me(r), pk, accept=bool(b.get("accept")), note=b.get("note", "")))


def h_scar_close(r, pk):
    return suppliers.scar_dict(suppliers.close_scar(me(r), pk, note=_body(r).get("note", "")))


# complaints
def h_cmp_list(r):
    return lst(r, complaints.list_complaints(**_q(r)), complaints.complaint_dict)


def h_cmp_register(r):
    return complaints.complaint_dict(complaints.register(me(r), _body(r))), 201


def h_cmp_get(r, pk):
    return complaints.complaint_dict(complaints.get(pk), detail=True)


def h_cmp_investigate(r, pk):
    b = _body(r)
    return complaints.complaint_dict(complaints.investigate(me(r), pk, findings=b.get("findings", ""), lot_number=b.get("lot_number")))


def h_cmp_ncr(r, pk):
    b = _body(r)
    return ncr.ncr_dict(complaints.raise_ncr(me(r), pk, category=b.get("category", ""), severity=b.get("severity"), containment=b.get("containment", ""))), 201


def h_cmp_capa(r, pk):
    b = _body(r)
    return ncr.capa_dict(complaints.link_capa(me(r), pk, owner_id=b.get("owner_id"), reviewer_id=b.get("reviewer_id"), due_date=b.get("due_date"))), 201


def h_cmp_respond(r, pk):
    b = _body(r)
    return complaints.complaint_dict(complaints.respond(me(r), pk, response_text=b.get("response_text", ""), resolution=b.get("resolution", "")))


def h_cmp_close(r, pk):
    b = _body(r)
    return complaints.complaint_dict(complaints.close(me(r), pk, customer_confirmed_on=b.get("customer_confirmed_on"), note=b.get("note", "")))


# risks and improvement
def h_risk_list(r):
    rows = risks.list_risks(**_q(r))
    return [risks.risk_dict(x) for x in rows]


def h_risk_register(r):
    return risks.risk_dict(risks.register(me(r), _body(r))), 201


def h_risk_get(r, pk):
    return risks.risk_dict(risks.get_risk(pk), detail=True)


def h_risk_reassess(r, pk):
    b = _body(r)
    return risks.risk_dict(risks.reassess(me(r), pk, likelihood=b.get("likelihood"), impact=b.get("impact"), note=b.get("note", ""), residual=bool(b.get("residual"))))


def h_risk_status(r, pk):
    b = _body(r)
    return risks.risk_dict(risks.set_status(me(r), pk, status=b.get("status", ""), note=b.get("note", "")))


def h_risk_matrix(r):
    return risks.risk_matrix()


def h_sug_list(r):
    return lst(r, risks.list_suggestions(**_q(r)), risks.suggestion_dict)


def h_sug_submit(r):
    return risks.suggestion_dict(risks.suggest(me(r), _body(r))), 201


def h_sug_decide(r, pk):
    b = _body(r)
    return risks.suggestion_dict(risks.decide_suggestion(me(r), pk, accept=bool(b.get("accept")), note=b.get("note", "")))


def h_ini_list(r):
    return lst(r, risks.list_initiatives(**_q(r)), risks.initiative_dict)


def h_ini_create(r):
    return risks.initiative_dict(risks.create_initiative(me(r), _body(r))), 201


def h_ini_get(r, pk):
    return risks.initiative_dict(risks.get_initiative(pk), detail=True)


def h_ini_status(r, pk):
    b = _body(r)
    return risks.initiative_dict(risks.initiative_status(me(r), pk, status=b.get("status", ""), progress=b.get("progress"), result_value=b.get("result_value"), lessons_learned=b.get("lessons_learned", ""), note=b.get("note", "")))


# calibration
def h_eq_list(r):
    q = _q(r)
    q["overdue"] = q.get("overdue") in ("1", "true", "True")
    return lst(r, calibration.list_equipment(**q), calibration.equipment_dict)


def h_eq_register(r):
    return calibration.equipment_dict(calibration.register(me(r), _body(r))), 201


def h_eq_get(r, pk):
    return calibration.equipment_dict(calibration.get(pk), detail=True)


def h_eq_schedule(r, pk):
    return calibration.calibration_dict(calibration.schedule(me(r), pk, scheduled_for=_body(r).get("scheduled_for"))), 201


def h_cal_record(r, pk):
    b = _body(r)
    f = r.FILES.get("certificate")
    return calibration.calibration_dict(calibration.record(me(r), pk, performed_on=b.get("performed_on"), performed_by=b.get("performed_by", ""), result=b.get("result", ""), certificate_ref=b.get("certificate_ref", ""),
                                                           as_found=b.get("as_found", ""), certificate_file=(f.name, f.read()) if f else None))


def h_impact(r, pk):
    b = _body(r)
    i = calibration.assess_impact(me(r), pk, affected=bool(b.get("affected")), note=b.get("note", ""))
    return {"id": str(i.id), "status": i.status}


def h_eq_return(r, pk):
    b = _body(r)
    return calibration.equipment_dict(calibration.return_to_service(me(r), pk, calibration_id=b.get("calibration_id"), note=b.get("note", "")))


def h_eq_retire(r, pk):
    return calibration.equipment_dict(calibration.retire(me(r), pk, reason=_body(r).get("reason", "")))


# project quality
def h_req_list(r):
    q = _q(r)
    return lst(r, projectqa.list_requests(**q), projectqa.request_dict)


def h_req_create(r):
    return projectqa.request_dict(projectqa.request_inspection(me(r), _body(r))), 201


def h_req_get(r, pk):
    return projectqa.request_dict(projectqa.get_request(pk), detail=True)


def h_req_schedule(r, pk):
    b = _body(r)
    return projectqa.request_dict(projectqa.schedule(me(r), pk, inspector_id=b.get("inspector_id"), scheduled_for=b.get("scheduled_for"), plan_id=b.get("plan_id"), product_id=b.get("product_id")))


def h_req_decide(r, pk):
    b = _body(r)
    return projectqa.request_dict(projectqa.decide(me(r), pk, approve=bool(b.get("approve")), note=b.get("note", "")))


def h_req_cancel(r, pk):
    return projectqa.request_dict(projectqa.cancel(me(r), pk, reason=_body(r).get("reason", "")))


def h_punch_list(r):
    return lst(r, projectqa.list_punch(**_q(r)), projectqa.punch_dict)


def h_punch_raise(r):
    return projectqa.punch_dict(projectqa.raise_punch(me(r), _body(r))), 201


def h_punch_fixed(r, pk):
    return projectqa.punch_dict(projectqa.punch_fixed(me(r), pk, note=_body(r).get("note", "")))


def h_punch_verify(r, pk):
    b = _body(r)
    return projectqa.punch_dict(projectqa.punch_verify(me(r), pk, accept=bool(b.get("accept")), note=b.get("note", "")))


# reports
def h_reports(r):
    return analytics.list_reports()


def h_report(r, code):
    return analytics.run(code, _q(r))


def h_report_csv(r, code):
    out = analytics.run(code, _q(r))
    resp = HttpResponse(analytics.to_csv(out["rows"]), content_type="text/csv")
    resp["Content-Disposition"] = f'attachment; filename="quality-{code}.csv"'
    return resp


def h_history(r, record_type, pk):
    return core.history(record_type, pk)


V, REP, PLAN, STD, INS, NCR, CAPA, AUD, SUP, CMP, RSK, CAL, IMP, HOLD, PRJ, ADM, ANA = (
    "quality.view", "quality.report", "quality.plan.manage", "quality.standards.manage", "quality.inspect", "quality.ncr.manage", "quality.capa.manage", "quality.audit.manage",
    "quality.supplier.manage", "quality.complaint.manage", "quality.risk.manage", "quality.calibration.manage", "quality.improvement.manage", "quality.hold.release", "quality.project.manage",
    "quality.admin", "quality.analytics.view")
VER = "quality.capa.verify"
APR = "quality.ncr.manage"

ROUTES = [
    ("dashboard", {"GET": (V, h_dashboard)}),
    ("config/<str:kind>", {"GET": (V, h_config_list), "POST": (ADM, h_config_save)}),
    ("evidence/<str:record_type>/<uuid:pk>", {"GET": (V, h_evidence_list), "POST": (V, h_evidence_add)}),
    ("history/<str:record_type>/<uuid:pk>", {"GET": (V, h_history)}),
    ("actions/mine", {"GET": (REP, h_my_actions)}),
    ("actions/<str:parent_type>/<uuid:pk>", {"GET": (V, h_actions_list), "POST": (NCR, h_action_add)}),
    ("action/<uuid:pk>/done", {"POST": (REP, h_action_done)}),
    ("action/<uuid:pk>/verify", {"POST": (NCR, h_action_verify)}),
    ("action/<uuid:pk>/cancel", {"POST": (NCR, h_action_cancel)}),
    ("costs/<str:ref_type>/<uuid:pk>", {"POST": (NCR, h_cost_add)}),
    ("plans", {"GET": (V, h_plans), "POST": (PLAN, h_plan_create)}),
    ("plans/<uuid:pk>", {"GET": (V, h_plan_get), "PATCH": (PLAN, h_plan_update)}),
    ("plans/<uuid:pk>/objectives", {"POST": (PLAN, h_plan_objective)}),
    ("plans/<uuid:pk>/control-points", {"POST": (PLAN, h_plan_cp)}),
    ("plans/<uuid:pk>/submit", {"POST": (PLAN, h_plan_submit)}),
    ("plans/<uuid:pk>/resubmit", {"POST": (PLAN, h_plan_resubmit)}),
    ("plans/<uuid:pk>/revise", {"POST": (PLAN, h_plan_revise)}),
    ("objectives/<uuid:pk>/measure", {"POST": (PLAN, h_objective_measure)}),
    ("standards", {"GET": (V, h_standards), "POST": (STD, h_standard_save)}),
    ("standards/<uuid:pk>", {"GET": (V, h_standard_get), "PATCH": (STD, h_standard_update)}),
    ("standards/<uuid:pk>/new-version", {"POST": (STD, h_standard_version)}),
    ("standards/<uuid:pk>/requirements", {"POST": (STD, h_requirement_add)}),
    ("requirements/<uuid:pk>/map", {"POST": (STD, h_requirement_map)}),
    ("requirements/<uuid:pk>/assess", {"POST": (STD, h_requirement_assess)}),
    ("compliance", {"GET": (V, h_compliance)}),
    ("inspection-plans", {"GET": (V, h_ip_list), "POST": (INS, h_ip_create)}),
    ("inspection-plans/<uuid:pk>", {"GET": (V, h_ip_get)}),
    ("inspection-plans/<uuid:pk>/parameters", {"POST": (INS, h_ip_param)}),
    ("parameters/<uuid:pk>/retire", {"POST": (INS, h_param_retire)}),
    ("inspections", {"GET": (V, h_insp_list), "POST": (INS, h_insp_schedule)}),
    ("inspections/<uuid:pk>", {"GET": (V, h_insp_get)}),
    ("inspections/<uuid:pk>/start", {"POST": (INS, h_insp_start)}),
    ("inspections/<uuid:pk>/results", {"POST": (INS, h_insp_result)}),
    ("inspections/<uuid:pk>/defects", {"POST": (INS, h_insp_defect)}),
    ("inspections/<uuid:pk>/complete", {"POST": (INS, h_insp_complete)}),
    ("inspections/<uuid:pk>/cancel", {"POST": (INS, h_insp_cancel)}),
    ("inspections/<uuid:pk>/reinspect", {"POST": (INS, h_insp_reinspect)}),
    ("holds", {"GET": (V, h_holds), "POST": (INS, h_hold_place)}),
    ("holds/<uuid:pk>", {"GET": (V, h_hold_get)}),
    ("holds/<uuid:pk>/disposition", {"POST": (HOLD, h_hold_disposition)}),
    ("holds/<uuid:pk>/release", {"POST": (HOLD, h_hold_release)}),
    ("holds/<uuid:pk>/reject", {"POST": (HOLD, h_hold_reject)}),
    ("ncrs", {"GET": (V, h_ncr_list), "POST": (REP, h_ncr_raise)}),
    ("ncrs/<uuid:pk>", {"GET": (V, h_ncr_get), "PATCH": (NCR, h_ncr_update)}),
    ("ncrs/<uuid:pk>/contain", {"POST": (NCR, h_ncr_contain)}),
    ("ncrs/<uuid:pk>/assign", {"POST": (NCR, h_ncr_assign)}),
    ("ncrs/<uuid:pk>/submit", {"POST": (NCR, h_ncr_submit)}),
    ("ncrs/<uuid:pk>/resubmit", {"POST": (NCR, h_ncr_resubmit)}),
    ("ncrs/<uuid:pk>/implement", {"POST": (NCR, h_ncr_implement)}),
    ("ncrs/<uuid:pk>/request-verification", {"POST": (NCR, h_ncr_verify)}),
    ("ncrs/<uuid:pk>/capa", {"POST": (CAPA, h_ncr_capa)}),
    ("ncrs/<uuid:pk>/close", {"POST": (VER, h_ncr_close)}),
    ("ncrs/<uuid:pk>/reopen", {"POST": (VER, h_ncr_reopen)}),
    ("ncrs/<uuid:pk>/dismiss", {"POST": (NCR, h_ncr_dismiss)}),
    ("capas", {"GET": (V, h_capa_list), "POST": (CAPA, h_capa_create)}),
    ("capas/<uuid:pk>", {"GET": (V, h_capa_get), "PATCH": (CAPA, h_capa_update)}),
    ("capas/<uuid:pk>/root-causes", {"POST": (CAPA, h_capa_rca)}),
    ("capas/<uuid:pk>/submit", {"POST": (CAPA, h_capa_submit)}),
    ("capas/<uuid:pk>/resubmit", {"POST": (CAPA, h_capa_resubmit)}),
    ("capas/<uuid:pk>/start", {"POST": (CAPA, h_capa_start)}),
    ("capas/<uuid:pk>/implemented", {"POST": (CAPA, h_capa_implemented)}),
    ("capas/<uuid:pk>/effectiveness", {"POST": (VER, h_capa_effectiveness)}),
    ("capas/<uuid:pk>/cancel", {"POST": (CAPA, h_capa_cancel)}),
    ("audits", {"GET": (V, h_audit_list), "POST": (AUD, h_audit_schedule)}),
    ("audits/<uuid:pk>", {"GET": (V, h_audit_get)}),
    ("audits/<uuid:pk>/start", {"POST": (AUD, h_audit_start)}),
    ("audits/<uuid:pk>/checklist", {"POST": (AUD, h_audit_item)}),
    ("audits/<uuid:pk>/findings", {"POST": (AUD, h_audit_finding)}),
    ("audits/<uuid:pk>/report", {"POST": (AUD, h_audit_report)}),
    ("audits/<uuid:pk>/close", {"POST": (AUD, h_audit_close)}),
    ("audits/<uuid:pk>/cancel", {"POST": (AUD, h_audit_cancel)}),
    ("checklist-items/<uuid:pk>/answer", {"POST": (AUD, h_item_answer)}),
    ("checklist-templates", {"GET": (V, h_template_list), "POST": (AUD, h_template_save)}),
    ("findings", {"GET": (V, h_finding_list)}),
    ("findings/<uuid:pk>", {"GET": (V, h_finding_get)}),
    ("findings/<uuid:pk>/assign", {"POST": (AUD, h_finding_assign)}),
    ("findings/<uuid:pk>/capa", {"POST": (AUD, h_finding_capa)}),
    ("findings/<uuid:pk>/close", {"POST": (AUD, h_finding_close)}),
    ("suppliers/<uuid:pk>/profile", {"GET": (V, h_sup_profile)}),
    ("suppliers/<uuid:pk>/status", {"POST": (SUP, h_sup_status)}),
    ("suppliers/<uuid:pk>/certificates", {"POST": (SUP, h_sup_cert)}),
    ("suppliers/<uuid:pk>/evaluations", {"GET": (V, h_sup_evals), "POST": (SUP, h_sup_eval)}),
    ("scars", {"GET": (V, h_scar_list), "POST": (SUP, h_scar_raise)}),
    ("scars/<uuid:pk>", {"GET": (V, h_scar_get)}),
    ("scars/<uuid:pk>/response", {"POST": (SUP, h_scar_response)}),
    ("scars/<uuid:pk>/review", {"POST": (SUP, h_scar_review)}),
    ("scars/<uuid:pk>/close", {"POST": (SUP, h_scar_close)}),
    ("complaints", {"GET": (V, h_cmp_list), "POST": (CMP, h_cmp_register)}),
    ("complaints/<uuid:pk>", {"GET": (V, h_cmp_get)}),
    ("complaints/<uuid:pk>/investigate", {"POST": (CMP, h_cmp_investigate)}),
    ("complaints/<uuid:pk>/ncr", {"POST": (CMP, h_cmp_ncr)}),
    ("complaints/<uuid:pk>/capa", {"POST": (CMP, h_cmp_capa)}),
    ("complaints/<uuid:pk>/respond", {"POST": (CMP, h_cmp_respond)}),
    ("complaints/<uuid:pk>/close", {"POST": (CMP, h_cmp_close)}),
    ("risks", {"GET": (V, h_risk_list), "POST": (RSK, h_risk_register)}),
    ("risks/matrix", {"GET": (V, h_risk_matrix)}),
    ("risks/<uuid:pk>", {"GET": (V, h_risk_get)}),
    ("risks/<uuid:pk>/reassess", {"POST": (RSK, h_risk_reassess)}),
    ("risks/<uuid:pk>/status", {"POST": (RSK, h_risk_status)}),
    ("suggestions", {"GET": (V, h_sug_list), "POST": (REP, h_sug_submit)}),
    ("suggestions/<uuid:pk>/decide", {"POST": (IMP, h_sug_decide)}),
    ("initiatives", {"GET": (V, h_ini_list), "POST": (IMP, h_ini_create)}),
    ("initiatives/<uuid:pk>", {"GET": (V, h_ini_get)}),
    ("initiatives/<uuid:pk>/status", {"POST": (IMP, h_ini_status)}),
    ("equipment", {"GET": (V, h_eq_list), "POST": (CAL, h_eq_register)}),
    ("equipment/<uuid:pk>", {"GET": (V, h_eq_get)}),
    ("equipment/<uuid:pk>/schedule", {"POST": (CAL, h_eq_schedule)}),
    ("equipment/<uuid:pk>/return-to-service", {"POST": (CAL, h_eq_return)}),
    ("equipment/<uuid:pk>/retire", {"POST": (CAL, h_eq_retire)}),
    ("calibrations/<uuid:pk>/record", {"POST": (CAL, h_cal_record)}),
    ("impact-assessments/<uuid:pk>", {"POST": (CAL, h_impact)}),
    ("inspection-requests", {"GET": (V, h_req_list), "POST": (PRJ, h_req_create)}),
    ("inspection-requests/<uuid:pk>", {"GET": (V, h_req_get)}),
    ("inspection-requests/<uuid:pk>/schedule", {"POST": (PRJ, h_req_schedule)}),
    ("inspection-requests/<uuid:pk>/decide", {"POST": (PRJ, h_req_decide)}),
    ("inspection-requests/<uuid:pk>/cancel", {"POST": (PRJ, h_req_cancel)}),
    ("punch-items", {"GET": (V, h_punch_list), "POST": (PRJ, h_punch_raise)}),
    ("punch-items/<uuid:pk>/fixed", {"POST": (PRJ, h_punch_fixed)}),
    ("punch-items/<uuid:pk>/verify", {"POST": (PRJ, h_punch_verify)}),
    ("reports", {"GET": (ANA, h_reports)}),
    ("reports/<str:code>", {"GET": (ANA, h_report)}),
    ("reports/<str:code>/csv", {"GET": (ANA, h_report_csv)}),
]


def _build():
    out = []
    for i, (path, table) in enumerate(ROUTES):
        cls = type(f"QualityView{i}", (_Base,), {"table": table, "__module__": __name__})
        out.append((f"api/v1/quality/{path}", cls))
    return out


VIEWS = _build()
