import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

import type { Page } from "../api/types";
import { Button, EmptyState, ErrorState, Spinner } from "./primitives";

interface Props<T> {
  columns: ColumnDef<T, any>[];
  page: Page<T> | undefined;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle: string;
  emptyHint?: string;
  caption: string;
  /** Called with the cursor of the page to load (null = first page). The server decides ordering. */
  onCursor: (cursor: string | null) => void;
  hasPrevious?: boolean;
  onFirst?: () => void;
}

/**
 * Server-paginated table. Sorting/filtering belong to the API (cursor pagination), so this renders rows as
 * given and offers Next / First navigation. Handles loading, empty and error states.
 */
export function DataTable<T>({ columns, page, isLoading, error, onRetry, emptyTitle, emptyHint, caption, onCursor, hasPrevious, onFirst }: Props<T>) {
  const table = useReactTable({ data: page?.results ?? [], columns, getCoreRowModel: getCoreRowModel() });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!page || page.results.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} scope="col" className="px-3 py-2 text-left font-medium text-slate-600">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 text-slate-800">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Pagination" className="mt-3 flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={!hasPrevious} onClick={onFirst}>
          First page
        </Button>
        <Button variant="secondary" disabled={!page.next} onClick={() => onCursor(page.next)}>
          Next
        </Button>
      </nav>
    </div>
  );
}
