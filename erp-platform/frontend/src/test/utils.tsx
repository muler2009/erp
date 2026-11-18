import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router";

import { makeStore } from "../app/store";
import type { TenantMe } from "../shared/api/types";
import { AccessProvider } from "../shared/permissions/usePermissions";

export const me = (permissions: string[]): TenantMe => ({
  context: "tenant",
  user: { id: "u1", email: "a@acme.test", display_name: "Ada" },
  tenant: { id: "t1", name: "Acme", slug: "acme", status: "ACTIVE" },
  modules: ["organization"],
  // The real API shape (an object keyed by code), so every test exercises what the backend actually sends.
  permissions: Object.fromEntries(permissions.map((p) => [p, { tenant_wide: true, scopes: [] }])),
});

export function renderWithProviders(ui: ReactElement, opts: { permissions?: string[]; route?: string } = {}) {
  const store = makeStore();
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>
        <AccessProvider me={me(opts.permissions ?? [])}>{ui}</AccessProvider>
      </MemoryRouter>
    </Provider>,
  );
}
