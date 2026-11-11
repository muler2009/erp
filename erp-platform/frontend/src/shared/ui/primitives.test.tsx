import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { Modal } from "./primitives";

function Host() {
  const [n, setN] = useState(0);
  return (
    <Modal title="Dlg" open onClose={() => setN(n + 1)}>
      <input aria-label="a" />
      <input aria-label="b" onChange={() => setN((x) => x + 100)} />
      <p>{n}</p>
    </Modal>
  );
}

describe("Modal", () => {
  it("is a labelled dialog and keeps focus while the parent re-renders", async () => {
    render(<Host />);
    expect(screen.getByRole("dialog", { name: "Dlg" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("b"), "xyz");
    expect(screen.getByLabelText("b")).toHaveFocus();
    expect(screen.getByLabelText("b")).toHaveValue("xyz");
  });
  it("closes on Escape", async () => {
    render(<Host />);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
