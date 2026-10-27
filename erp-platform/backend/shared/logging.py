import contextvars
import json
import logging
from datetime import datetime, timezone

correlation_id_var = contextvars.ContextVar("correlation_id", default="-")
tenant_var = contextvars.ContextVar("tenant", default="-")
user_var = contextvars.ContextVar("user_id", default="-")


class CorrelationFilter(logging.Filter):
    def filter(self, record):
        record.correlation_id = correlation_id_var.get()
        record.tenant = tenant_var.get()
        record.user_id = user_var.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "correlation_id": getattr(record, "correlation_id", "-"),
            "tenant": getattr(record, "tenant", "-"),
            "user_id": getattr(record, "user_id", "-"),
        }
        for key, value in getattr(record, "extra_fields", {}).items():
            payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)
