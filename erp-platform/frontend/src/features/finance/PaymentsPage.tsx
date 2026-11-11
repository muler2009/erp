import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useListPaymentsQuery } from "../../shared/api/endpoints";
import type { Payment } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, PageHeader } from "../../shared/ui/primitives";

const columns: ColumnDef<Payment>[] = [
  { header: "Number", accessorKey: "number" },
  { header: "Type", cell: ({ row }) => <Badge tone={row.original.kind === "RECEIPT" ? "green" : "amber"}>{row.original.kind === "RECEIPT" ? "Receipt" : "Payment"}</Badge> },
  { header: "Date", accessorKey: "payment_date" },
  { header: "Amount", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.amount)} {row.original.currency}</span> },
  { header: "Invoices", cell: ({ row }) => row.original.allocations.length },
];

export function PaymentsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListPaymentsQuery({ cursor });
  return (
    <>
      <PageHeader title="Payments" description="Receipts from customers and payments to suppliers." />
      <DataTable caption="Payments" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No payments yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
    </>
  );
}
