import { useCreateCrmContactMutation, useUpdateCrmContactMutation } from "../../shared/api/endpoints";
import type { CrmContact } from "../../shared/api/types";
import { ActionDialog } from "../hr/ActionDialog";
import { CHANNELS, CONTACT_ROLES } from "./options";

/** Create (account preset or chosen) or edit a contact. */
export function ContactDialog({ contact, accountId, accounts, onClose }: { contact: CrmContact | null; accountId?: string; accounts?: [string, string][]; onClose: () => void }) {
  const [create] = useCreateCrmContactMutation();
  const [update] = useUpdateCrmContactMutation();
  const fields = [
    { name: "first_name", label: "First name", required: true }, { name: "last_name", label: "Last name" },
    { name: "email", label: "Email", type: "email" }, { name: "phone", label: "Phone" }, { name: "job_title", label: "Job title" },
    { name: "role", label: "Role", options: CONTACT_ROLES }, { name: "preferred_channel", label: "Preferred channel", options: CHANNELS },
    ...(accounts ? [{ name: "account", label: "Account", options: accounts }] : []),
  ];
  const initial: Record<string, string> = contact ? { first_name: contact.first_name, last_name: contact.last_name, email: contact.email, phone: contact.phone, job_title: contact.job_title, role: contact.role, preferred_channel: contact.preferred_channel, account: contact.account ?? "" } : { account: accountId ?? "" };
  return (
    <ActionDialog title={contact ? "Edit contact" : "New contact"} cta={contact ? "Save contact" : "Add contact"} open onClose={onClose} initial={initial} fields={fields}
      submit={async (v) => {
        const email = (v.email ?? "").trim();
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
        const base = { first_name: v.first_name!.trim(), last_name: (v.last_name ?? "").trim(), email, phone: (v.phone ?? "").trim(), job_title: (v.job_title ?? "").trim() };
        if (contact) await update({ id: contact.id, body: { ...base, role: v.role ?? "", preferred_channel: v.preferred_channel ?? "", account_id: v.account || null } }).unwrap();
        else {
          const made = await create({ ...base, account: v.account || null }).unwrap();
          if (v.role || v.preferred_channel) await update({ id: made.id, body: { role: v.role ?? "", preferred_channel: v.preferred_channel ?? "" } }).unwrap();
        }
      }} />
  );
}
