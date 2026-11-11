import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useCreateProductMutation, useListProductsQuery, useListUnitsQuery } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { Product } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { Can } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

export const productSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required").max(60),
  name: z.string().trim().min(1, "Name is required").max(200),
  uom: z.string().min(1, "Choose a unit"),
  tracking: z.enum(["NONE", "LOT", "SERIAL"]),
  is_stocked: z.boolean(),
  barcode: z.string().trim().max(100),
  category: z.string().trim().max(100),
});
type ProductForm = z.infer<typeof productSchema>;

const columns: ColumnDef<Product>[] = [
  { header: "SKU", accessorKey: "sku" },
  { header: "Name", accessorKey: "name" },
  { header: "Unit", accessorKey: "uom" },
  { header: "Tracking", cell: ({ row }) => (row.original.tracking === "NONE" ? "—" : row.original.tracking.toLowerCase()) },
  { header: "On hand", cell: ({ row }) => <span className="block text-right">{row.original.is_stocked ? formatMoney(row.original.on_hand) : "n/a"}</span> },
  { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "Active" : "Inactive"}</Badge> },
];

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const units = useListUnitsQuery(undefined, { skip: !open });
  const [create, state] = useCreateProductMutation();
  const { register, handleSubmit, setError, reset, setValue, formState } = useForm<ProductForm>({
    resolver: zodResolver(productSchema),
    defaultValues: { sku: "", name: "", uom: "", tracking: "NONE", is_stocked: true, barcode: "", category: "" },
  });
  useEffect(() => { if (units.data?.length) setValue("uom", units.data.find((u) => u.code === "unit")?.code ?? units.data[0]!.code); }, [units.data, setValue]);
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (v) => {
    try {
      await create({ ...v, barcode: v.barcode || undefined, category: v.category || undefined }).unwrap();
      close();
    } catch (e) {
      const fe = fieldErrors(e);
      const known = Object.keys(fe).filter((k) => k in v);
      known.forEach((k) => setError(k as keyof ProductForm, { message: fe[k] }));
      if (known.length === 0) setError("root", { message: errorMessage(e) });
    }
  });
  return (
    <Modal title="New product" open={open} onClose={close}>
      <form onSubmit={submit} noValidate>
        <FormField label="SKU" htmlFor="p-sku" error={formState.errors.sku?.message}><input id="p-sku" className={inputClass} {...register("sku")} /></FormField>
        <FormField label="Name" htmlFor="p-name" error={formState.errors.name?.message}><input id="p-name" className={inputClass} {...register("name")} /></FormField>
        <FormField label="Unit of measure" htmlFor="p-uom" error={formState.errors.uom?.message}>
          <select id="p-uom" className={inputClass} {...register("uom")}>{units.data?.map((u) => <option key={u.code} value={u.code}>{u.name || u.code}</option>)}</select>
        </FormField>
        <FormField label="Tracking" htmlFor="p-tracking">
          <select id="p-tracking" className={inputClass} {...register("tracking")}><option value="NONE">None</option><option value="LOT">By lot</option><option value="SERIAL">By serial number</option></select>
        </FormField>
        <FormField label="Barcode" htmlFor="p-barcode" error={formState.errors.barcode?.message}><input id="p-barcode" className={inputClass} {...register("barcode")} /></FormField>
        <FormField label="Category" htmlFor="p-category"><input id="p-category" className={inputClass} {...register("category")} /></FormField>
        <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" {...register("is_stocked")} /> Stock is tracked for this product</label>
        {formState.errors.root && <p role="alert" className="mb-3 text-sm text-red-700">{formState.errors.root.message}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={state.isLoading}>Create product</Button></div>
      </form>
    </Modal>
  );
}

export function ProductsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => { setSearch(text.trim()); setCursor(null); }, 300); return () => clearTimeout(t); }, [text]);
  const { data, isLoading, error, refetch } = useListProductsQuery({ cursor, search });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Products" actions={<Can permission="inventory.product.manage"><Button onClick={() => setCreating(true)}>New product</Button></Can>} />
      <label className="mb-3 flex items-center gap-2 text-sm">Search
        <input type="search" className={`${inputClass} w-64`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Product name" />
      </label>
      <DataTable caption="Products" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No products" emptyHint={search ? "Try a different name." : undefined} onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
