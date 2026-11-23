import { useRef, useState } from "react";

import { useListAssetDocumentsQuery, useUploadAssetDocumentMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { downloadFile } from "../../shared/lib/fileDownload";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, inputClass, Modal, Spinner } from "../../shared/ui/primitives";
import { pretty } from "../hr/EmployeeDialogs";

export const ASSET_DOC_TYPES = ["IMAGE", "INVOICE", "WARRANTY", "CERTIFICATE", "MANUAL", "OTHER"];

export function assetDocProblem(docType: string, hasFile: boolean): string | null {
  if (!ASSET_DOC_TYPES.includes(docType)) return "Choose the kind of document.";
  if (!hasFile) return "Choose a file to attach.";
  return null;
}

function UploadDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [upload, { isLoading }] = useUploadAssetDocumentMutation();
  const [type, setType] = useState("OTHER");
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const go = async () => {
    const f = file.current?.files?.[0];
    const p = assetDocProblem(type, !!f);
    if (p || !f) { setErr(p); return; }
    const form = new FormData();
    form.append("file", f);
    form.append("doc_type", type);
    if (title.trim()) form.append("title", title.trim());
    try { await upload({ id, form }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Attach a document" open onClose={onClose}>
      <FormField label="Kind" htmlFor="ad-type"><select id="ad-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>{ASSET_DOC_TYPES.map((t) => <option key={t} value={t}>{pretty(t)}</option>)}</select></FormField>
      <FormField label="Title (optional)" htmlFor="ad-title"><input id="ad-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
      <FormField label="File" htmlFor="ad-file"><input id="ad-file" ref={file} type="file" className={inputClass} /></FormField>
      {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={isLoading} onClick={() => void go()}>Attach</Button></div>
    </Modal>
  );
}

export function AssetDocumentsCard({ id }: { id: string }) {
  const { can } = useAccess();
  const manage = can("assets.asset.manage");
  const { data, isLoading, error, refetch } = useListAssetDocumentsQuery(id);
  const [open, setOpen] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const get = async (fileId: string, name: string) => { setFail(null); try { await downloadFile(fileId, name); } catch (e) { setFail(e instanceof Error ? e.message : "The file could not be opened."); } };
  return (
    <Card title="Documents" actions={manage ? <Button variant="secondary" onClick={() => setOpen(true)}>Attach a document</Button> : undefined}>
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : data.results.length === 0 ? <EmptyState title="No documents attached" hint="Invoices, manuals, certificates and photos for this asset go here." /> : (
        <ul className="text-sm">{data.results.map((d) => <li key={d.id} className="flex items-center justify-between border-b border-slate-100 py-1"><span>{d.title} <span className="text-slate-500">({pretty(d.type)})</span></span><button type="button" className="text-xs underline" aria-label={`Download ${d.title}`} onClick={() => void get(d.file_id, d.title)}>Download</button></li>)}</ul>
      )}
      {fail && <p role="alert" className="mt-2 text-sm text-red-700">{fail}</p>}
      {open && <UploadDialog id={id} onClose={() => setOpen(false)} />}
    </Card>
  );
}
