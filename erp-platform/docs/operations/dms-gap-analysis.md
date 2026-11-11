# Document Management: requirements coverage

Maps the 17 sections of the Document Management FRS to `backend/modules/documents`. "Partial" means the rule is enforced but a convenience is missing.

| # | FRS section | Status | Where / notes |
|---|---|---|---|
| 1 | Document repository | Done | Categories, folders (nested), documents, metadata, tags, department/project ownership |
| 2 | Classification | Done | Four ranks (Public, Internal, Confidential, Restricted); confidential needs `documents.confidential.view`; restricted only for people named on the document |
| 3 | Registration | Done | Per-category numbering with a locked counter; legacy references allowed but unique; category-required metadata and expiry enforced before approval |
| 4 | Version control | Done | Major.minor or sequential labels; revisions of a published document leave it published until the new version is published; one published version per document (database constraint); history never overwritten |
| 5 | Review and approval | Done | Shared workflow engine (`documents.version`): sequential/parallel stages, request changes, resubmit, withdraw; approval comment history across all versions |
| 6 | Lifecycle | Done | Draft, under review, changes requested, approved, published, obsolete, archived; obsolete marked and the superseded version identified |
| 7 | Controlled distribution and acknowledgement | Done | Distribution lists, required reading, acknowledgement records (user and date), re-issue on a new version, reminders |
| 8 | Access control | Done | Role permission plus per-document/folder grants (user, role, department, project), expiry and revocation; every open/download logged |
| 9 | Search | Partial | Title, reference, metadata, tags and extracted text of docx/xlsx/pptx/txt/csv; saved searches and favourites. PDF text is not indexed |
| 10 | Templates and forms | Done | Templates per category; create-from-template; forms report |
| 11 | Review and expiry | Done | Periodic review records (no change / revision required / obsolete); review, expiry and acknowledgement reminders; one escalation to the department head or document admins |
| 12 | External documents | Done | External register, submission status machine, comments with responses, transmittals, RFIs |
| 13 | Project / construction document control | Done | Project folders and grants, drawings and submittals via the external register, transmittals, RFIs, project register report |
| 14 | Retention, archiving, disposal | Done | Retention per category and per document; archive; disposal request with a separate approver (separation of duties); archived documents stay retrievable |
| 15 | Reporting | Done | 13 reports (register, by category, pending approvals, revision history, overdue reviews, expiring, obsolete, archived, acknowledgements, access, external, project register, transmittals) |
| 16 | Administration | Done | Categories, classifications, folders, grants, settings (`documents.*`) |
| 17 | Business rules | Done | All listed rules are enforced in services and covered by `tests/test_documents.py` |

## Known limits
- PDF content is not text-indexed; no in-app preview rendering (files download).
- Version comparison shows metadata and history, not a content diff.
- A published document requires a workflow definition for `documents.version`; without one, submission fails with `no_workflow`.
