import { render, screen } from "@testing-library/react";

import { me } from "../../test/utils";
import { AccessProvider, Can, permissionCodes, useAccess } from "./usePermissions";

function Probe() {
  const a = useAccess();
  return <p>{`${a.can("users.view")}|${a.canAny(["x", "roles.view"])}|${a.hasModule("organization")}|${a.hasModule("finance")}`}</p>;
}

describe("permissions", () => {
  it("answers from /me", () => {
    render(<AccessProvider me={me(["users.view", "roles.view"])}><Probe /></AccessProvider>);
    expect(screen.getByText("true|true|true|false")).toBeInTheDocument();
  });
  it("<Can> hides content without the permission and shows the fallback", () => {
    render(
      <AccessProvider me={me(["users.view"])}>
        <Can permission="users.create" fallback={<span>no</span>}><button>Invite</button></Can>
      </AccessProvider>,
    );
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.getByText("no")).toBeInTheDocument();
  });
  it("<Can> shows content with the permission", () => {
    render(<AccessProvider me={me(["users.create"])}><Can permission="users.create"><button>Invite</button></Can></AccessProvider>);
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
  });

  it("reads the backend's object shape and the platform's list", () => {
    expect(permissionCodes(["a", "b"])).toEqual(["a", "b"]);
    expect(permissionCodes({ "users.view": { tenant_wide: true, scopes: [] }, "hr.view": { tenant_wide: false, scopes: [{ type: "DEPARTMENT", id: "d1" }] }, "none.here": { tenant_wide: false, scopes: [] } })).toEqual(["users.view", "hr.view"]);
  });
  it("a scoped-only permission still shows the page, and one with no reach does not", () => {
    const me2 = { ...me([]), permissions: { "users.view": { tenant_wide: false, scopes: [{ id: "d1" }] }, "roles.view": { tenant_wide: false, scopes: [] } } };
    render(<AccessProvider me={me2}><Probe /></AccessProvider>);
    expect(screen.getByText("true|false|true|false")).toBeInTheDocument();
  });
});
