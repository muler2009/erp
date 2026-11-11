/** The backend's error envelope: {"error": {"code", "message", "details": [{field, code, message}], "correlation_id"}}. */
export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details: FieldError[];
  correlationId?: string;
}

interface Envelope {
  error?: { code?: string; message?: string; details?: FieldError[]; correlation_id?: string };
}

export function toApiError(status: number | string, data: unknown): ApiError {
  const numeric = typeof status === "number" ? status : 0;
  const env = (data ?? {}) as Envelope;
  if (env.error) {
    return {
      status: numeric,
      code: env.error.code ?? "error",
      message: env.error.message ?? "Something went wrong.",
      details: Array.isArray(env.error.details) ? env.error.details : [],
      correlationId: env.error.correlation_id,
    };
  }
  if (status === "FETCH_ERROR") return { status: 0, code: "network_error", message: "Cannot reach the server. Check your connection and try again.", details: [] };
  if (status === "PARSING_ERROR") return { status: numeric, code: "bad_response", message: "The server sent an unreadable response.", details: [] };
  return { status: numeric, code: "error", message: numeric >= 500 ? "The server had a problem. Please try again." : "The request could not be completed.", details: [] };
}

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value && "status" in value;
}

export function errorMessage(value: unknown): string {
  return isApiError(value) ? value.message : "Something went wrong.";
}

/** Field errors keyed by field name, for forms. */
export function fieldErrors(value: unknown): Record<string, string> {
  if (!isApiError(value)) return {};
  const out: Record<string, string> = {};
  for (const d of value.details) if (d.field && !out[d.field]) out[d.field] = d.message;
  return out;
}
