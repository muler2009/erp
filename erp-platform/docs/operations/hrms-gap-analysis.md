# HRMS functional requirements — gap analysis and correction plan

Reviewed: the Phase 6 build (employees, contracts, checklists, attendance, leave, timesheets, payroll) against the 18-section HRMS Functional Requirements Specification.
Legend: ✅ done and tested · 🟡 partial · ❌ not built at review time. "Slice" is where the gap is closed in this phase.

| # | FRS section | At review | Gaps found | Slice |
|---|---|---|---|---|
| 1 | Employee management | 🟡 | No emergency contacts, qualifications, skills, employment type, probation period, grade; no employment history (promotions, transfers, salary and reporting-line changes); no documents; no bulk import or duplicate detection | A |
| 2 | Organizational structure | 🟡 | Departments/branches/positions/cost centers exist (org module). Missing: grades, position requirements, approved headcount / occupied / vacancies, org chart, effective-dated changes | A |
| 3 | Recruitment / ATS | ❌ | Whole section | E |
| 4 | Onboarding / offboarding | 🟡 | Checklist had no assignee role; no probation evaluation/confirmation; no separation types, clearance, final settlement; no resignation request; access revocation not triggered | A |
| 5 | Attendance and time | 🟡 | No shifts/schedules, overtime policy, lateness / early-leave / overtime / absence calculation, correction requests, work modes (remote/field/travel), reports | B |
| 6 | Leave | 🟡 | No accrual, carry-over, expiry, eligibility, half days, delegated approval, leave calendar, utilization report | C |
| 7 | Payroll and compensation | 🟡 | No salary revision with approval and history, bonuses/commissions, overtime input, loans/advances, adjustments/arrears/reversal, payroll register, payment instructions, run locking | D |
| 8 | Performance | ❌ | Whole section | F |
| 9 | Learning and development | ❌ | Whole section | G |
| 10 | Benefits, loans, reimbursements | ❌ | Whole section | H |
| 11 | Employee self-service | 🟡 | Profile, attendance, leave, timesheets, payslips present; missing change requests, correction/overtime/reimbursement requests, goals/appraisals/training views, resignation | A–H |
| 12 | Manager self-service | 🟡 | Team view and approvals present; missing probation / contract-expiry monitoring, transfers, team reports | A, K |
| 13 | Employee relations / cases | ❌ | Whole section | I |
| 14 | HR documents and policies | ❌ | Whole section (shared file service exists) | J |
| 15 | HR reports and analytics | 🟡 | Headcount only | K |
| 16 | HR configuration | 🟡 | Rules for pay components, tax table, pension existed; others added with each slice | all |
| 17 | Cross-module integration | 🟡 | IAM link, finance journals, shared workflow, shared files, notifications are used. Project timesheet costing and asset returns wait for those modules (Phases 7+); hooks and fields are provided | all |
| 18 | Business rules | 🟡 | Status-based eligibility, object-level access, SoD and approvals existed; effective dating and history added | all |

Corrections to existing behaviour (not just additions) are listed in `phase6-status.md`.


## Status after Phase 6

| # | FRS section | Result |
|---|---|---|
| 1 | Employee management | ✅ A — profile, emergency contacts, qualifications, skills, grades, history, documents, bulk import (dry-run), duplicate detection |
| 2 | Organizational structure | ✅ A — grades, position plans (approved/occupied/vacant), org chart, effective-dated assignment changes |
| 3 | Recruitment / ATS | ✅ E — requisitions with approval, candidates, stages, interviews and scorecards, offers with approval, hire-to-employee. 🟡 no careers portal, CV attachments or email templates |
| 4 | Onboarding / offboarding | ✅ A — role-based checklists, probation evaluation, resignation, separation types, settlement, automatic access revocation |
| 5 | Attendance and time | ✅ B — schedules, overtime policy and approvals, exceptions, corrections, device import, reports |
| 6 | Leave | ✅ C — accrual, carry-over with expiry, eligibility, half days, notice, delegation, calendar, utilization |
| 7 | Payroll and compensation | ✅ D — revisions with history, bonuses/commissions/arrears/adjustments, overtime pay, loans, reversal, register, payment instructions, locking. 🟡 no employee groups; cost-centre split is a report, not journal dimensions |
| 8 | Performance | ✅ F — cycles, weighted goals, self then manager review, acknowledgment. 🟡 no 360° feedback or calibration |
| 9 | Learning and development | ✅ G — courses, records with expiry, mandatory-course compliance. 🟡 no enrolment/scheduling or budgets |
| 10 | Benefits, loans, reimbursements | 🟡 H — loans and reimbursements flow into payroll; benefits are modelled as pay components. No benefit-plan enrolment or insurance claims |
| 11 | Employee self-service | 🟡 profile, attendance, leave, timesheets, payslips, loans, reimbursements, grievances, policies, reviews. Personal-data change requests not built |
| 12 | Manager self-service | ✅ team view, approvals (with delegation), monitoring, goals and reviews |
| 13 | Employee relations / cases | ✅ I — confidential cases, notes, outcomes in history |
| 14 | HR documents and policies | ✅ J — versioned policies, publish, acknowledgments; employee documents (A) |
| 15 | HR reports and analytics | ✅ K — headcount, turnover, tenure, payroll cost, absenteeism, recruitment funnel, review ratings, training compliance |
| 16 | HR configuration | ✅ settings, leave types, overtime policy, schedules, grades, tax table, components, requirements |
| 17 | Cross-module integration | 🟡 IAM, finance, workflows, files, notifications used. Project timesheet costing and asset returns wait for Phases 7+ |
| 18 | Business rules | ✅ eligibility, object-level access, separation of duties, effective dating, immutable history |
