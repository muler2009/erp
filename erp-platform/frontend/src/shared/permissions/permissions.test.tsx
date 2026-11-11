import { render, screen } from "@testing-library/react";

import { me } from "../../test/utils";
import { AccessProvider, Can, useAccess } from "./usePermissions";

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
});
