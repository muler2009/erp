import { cursorOf, normalizePage, withCursor } from "./cursor";
import { errorMessage, fieldErrors, toApiError } from "./errors";

describe("cursor helpers", () => {
  it("extracts the cursor from a full URL", () => {
    expect(cursorOf("http://acme.localhost/api/v1/users?cursor=abc%3D")).toBe("abc=");
    expect(cursorOf(null)).toBeNull();
  });
  it("normalizes pages", () => {
    const p = normalizePage({ results: [1], next: "http://h/x?cursor=n1", previous: null });
    expect(p).toEqual({ results: [1], next: "n1", previous: null });
  });
  it("builds query strings", () => {
    expect(withCursor("api/v1/users")).toBe("api/v1/users");
    expect(withCursor("api/v1/users", "c1")).toBe("api/v1/users?cursor=c1");
  });
});

describe("error normalization", () => {
  const envelope = {
    error: { code: "validation_error", message: "Invalid input.", details: [{ field: "email", code: "invalid", message: "Bad email" }], correlation_id: "cid-1" },
  };
  it("reads the backend envelope", () => {
    const e = toApiError(400, envelope);
    expect(e.code).toBe("validation_error");
    expect(e.correlationId).toBe("cid-1");
    expect(fieldErrors(e)).toEqual({ email: "Bad email" });
    expect(errorMessage(e)).toContain("Invalid input");
  });
  it("copes with non-envelope bodies", () => {
    const e = toApiError(502, "<html>bad gateway</html>");
    expect(e.status).toBe(502);
    expect(errorMessage(e).length).toBeGreaterThan(0);
  });
  it("reads the message of a plain Error and falls back for anything else", () => {
    expect(errorMessage(new Error("The report could not be loaded."))).toBe("The report could not be loaded.");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
  });
  it("copes with network errors", () => {
    expect(errorMessage(toApiError("FETCH_ERROR", undefined)).length).toBeGreaterThan(0);
  });
});
