import { safeReturnTo } from "./returnTo";

describe("safeReturnTo", () => {
  it("keeps same-site paths", () => {
    expect(safeReturnTo("/app/settings/users?x=1")).toBe("/app/settings/users?x=1");
  });
  it.each(["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/signin-callback", "/signin-callback?code=1", "/a\nb", ""])(
    "rejects %j",
    (v) => expect(safeReturnTo(v, "/home")).toBe("/home"),
  );
  it("rejects overly long values", () => expect(safeReturnTo("/" + "a".repeat(2100), "/")).toBe("/"));
  it("handles null/undefined", () => expect(safeReturnTo(undefined, "/x")).toBe("/x"));
});
