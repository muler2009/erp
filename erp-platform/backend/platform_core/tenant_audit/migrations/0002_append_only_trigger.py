from django.db import migrations

# Runs inside each tenant schema (search_path = tenant schema first), so the function and trigger
# are created per tenant.
FORWARD = """
CREATE OR REPLACE FUNCTION tenant_audit_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'tenant audit events are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tenant_audit_no_update_delete
    BEFORE UPDATE OR DELETE ON tenant_audit_tenantauditevent
    FOR EACH ROW EXECUTE FUNCTION tenant_audit_immutable();
"""
REVERSE = """
DROP TRIGGER IF EXISTS tenant_audit_no_update_delete ON tenant_audit_tenantauditevent;
DROP FUNCTION IF EXISTS tenant_audit_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("tenant_audit", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
