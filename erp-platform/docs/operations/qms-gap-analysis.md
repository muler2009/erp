# Quality Management: requirements coverage

Maps the 17 sections of the Quality Management FRS to `backend/modules/quality`.

| # | FRS section | Status | Where / notes |
|---|---|---|---|
| 1 | Quality dashboard | Done | `GET /quality/dashboard`: open NCRs by severity, CAPAs, inspection pass rate, holds, complaints, findings, calibration, risks, supplier status, compliance, objectives |
| 2 | Quality planning | Done | Plans with scope, objectives (measured per period), control points; approval through the workflow engine; approved plans are revised, never edited, with full revision snapshots |
| 3 | Standards and compliance | Done | Standards, versions with change records, clause requirements, links to controlled documents, assessments (append-only), gap list, compliance percentage, re-assessment flagged when a standard changes |
| 4 | Inspections | Done | Plans (incoming, in-process, final, project, equipment, supplier) with numeric/boolean/text parameters and critical flags; sampling; results are corrected by superseding, never overwritten; defects; re-inspection; equipment used is checked for calibration |
| 5 | Non-conformances | Done | Traceable to a source, configurable category/severity, containment (optionally placing a hold), investigation, workflow approval, owned actions, verification by a different person, closure rules by severity, reopen |
| 6 | CAPA | Done | Root-cause analysis methods (configurable), approval, owned actions, implementation evidence, effectiveness verification by the named reviewer, failed effectiveness starts a new cycle |
| 7 | Audits | Done | Programme, checklist templates linked to requirements and procedures, team, answers, findings, CAPA links, reporting and closure rules |
| 8 | Supplier quality | Done | Status (approved/conditional/restricted/blocked, synced to the procurement supplier), certificates with expiry reminders, scored evaluations from inspection results, SCAR cycle |
| 9 | Product / manufacturing quality | Done | Incoming/in-process/final inspections, quality holds that block inventory issue and transfer, disposition (accept, reject, rework, repair, scrap, conditional), release by an authorised person other than the one who placed the hold |
| 10 | Project / construction quality | Done | Inspection requests with ITP plans, hold points that block dependent project tasks, punch list with fix/verify, acceptance gated on a passed inspection and no open major punch items |
| 11 | Customer complaints | Done | Registration, recurrence detection, investigation, linked NCR/CAPA, response, customer confirmation, closure rules by severity |
| 12 | Risk-based quality | Done | 5x5 register, levels, mitigation actions, residual risk, review reminders, high-risk alerts; high risks cannot be accepted |
| 13 | Calibration | Done | Equipment register, intervals, schedule, records with certificates, out-of-tolerance impact assessment on past inspections, return to service only after a passing calibration and assessments |
| 14 | Continuous improvement | Done | Suggestions, decision, initiatives with baseline/target/result, lessons learned, approval by someone other than the creator |
| 15 | Reporting | Done | 18 reports with filters and CSV export (formula-injection safe); cost of quality by category |
| 16 | Administration | Done | Configurable lists, severity levels (which require a CAPA), checklist templates, settings (`quality.*`), roles Quality Manager and Quality Inspector |
| 17 | Business rules | Done | See "Rules enforced" below |

## Rules enforced (each has a test in `tests/test_quality.py`)
Unique numbers on every record; NCRs need a source reference; CAPA needs a source; CAPA cannot close without implementation evidence and effectiveness verification by the named reviewer; failed or conditional inspections place the goods on hold and never release them; holds are released only with an accepting disposition and not by the person who placed them; inspection results keep history; approved plans keep revision history; every action has an owner and a due date; audit findings stay open until closed; quality approval runs through the workflow engine and is separate from financial or purchasing approval.

## Known limits
- Reports are tabular (JSON and CSV); there are no rendered charts, PDF or Excel exports yet.
- Quality approvals need a workflow definition for `quality.plan`, `quality.ncr` and `quality.capa`; without one, submission fails with `no_workflow`.
- A CAPA that fails effectiveness returns to analysis; resubmitting it for approval a second time through the workflow engine is not covered by tests.
- Hold quantity is informational: a hold blocks the product or lot as a whole, not a partial quantity.
- Statistical process control charts and sampling plans by AQL tables are not included (sampling is all / percentage / fixed).
- Supplier evaluation uses a documented fixed formula (100 minus twice the rejection rate, 5 per NCR, 5 per open SCAR); weights are not yet configurable.
