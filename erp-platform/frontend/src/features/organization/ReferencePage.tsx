import { useState } from "react";

import { useAccess } from "../../shared/permissions/usePermissions";
import { PageHeader } from "../../shared/ui/primitives";
import { CurrenciesTab, RatesTab } from "./CurrenciesTab";
import { FiscalTab } from "./FiscalTab";
import { HolidaysTab } from "./HolidaysTab";

const TABS = ["Currencies", "Exchange rates", "Fiscal calendar", "Holidays"] as const;

/** Currencies, rates, fiscal years and periods, holidays. */
export function ReferencePage() {
  const { can } = useAccess();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Currencies");
  const manage = can("org.reference.manage");
  return (
    <>
      <PageHeader title="Currencies and calendar" description="Reference data that finance, HR and sales rely on." />
      <div role="tablist" aria-label="Reference data" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm ${t === tab ? "border-b-2 border-indigo-600 font-medium text-indigo-700" : "text-slate-600 hover:text-slate-900"}`}>{t}</button>
        ))}
      </div>
      {tab === "Currencies" && <CurrenciesTab canManage={manage} />}
      {tab === "Exchange rates" && <RatesTab canManage={manage} />}
      {tab === "Fiscal calendar" && <FiscalTab canManage={manage} canClose={can("org.fiscal.close")} />}
      {tab === "Holidays" && <HolidaysTab canManage={manage} />}
    </>
  );
}
