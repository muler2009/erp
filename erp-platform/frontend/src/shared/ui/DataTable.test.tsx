import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "./DataTable";

interface Row { id: string; name: string }
const columns: ColumnDef<Row>[] = [{ header: "Name", accessorKey: "name" }];
const base = { columns, caption: "People", emptyTitle: "Nothing here", onCursor: () => {}, isLoading: false };

describe("DataTable", () => {
  it("shows loading", () => {
    render(<DataTable<Row> {...base} isLoading page={undefined} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("shows an error with retry", async () => {
    const retry = vi.fn();
    render(<DataTable<Row> {...base} page={undefined} error={{ status: 500, code: "x", message: "Boom", details: [] }} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });
  it("shows the empty state", () => {
    render(<DataTable<Row> {...base} page={{ results: [], next: null, previous: null }} />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
  it("renders rows and pages by cursor", async () => {
    const onCursor = vi.fn();
    render(<DataTable<Row> {...base} onCursor={onCursor} page={{ results: [{ id: "1", name: "Ada" }], next: "c2", previous: null }} />);
    expect(screen.getByRole("table", { name: "People" })).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onCursor).toHaveBeenCalledWith("c2");
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
  });
  it("disables Next on the last page", () => {
    render(<DataTable<Row> {...base} page={{ results: [{ id: "1", name: "Ada" }], next: null, previous: null }} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
