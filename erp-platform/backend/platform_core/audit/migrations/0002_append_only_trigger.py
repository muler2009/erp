from django.db import migrations

FORWARD = """
CREATE OR REPLACE FUNCTION platform_audit_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'platform audit events are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER platform_audit_no_update_delete
    BEFORE UPDATE OR DELETE ON platform_audit_platformauditevent
    FOR EACH ROW EXECUTE FUNCTION platform_audit_immutable();
"""
REVERSE = """
DROP TRIGGER IF EXISTS platform_audit_no_update_delete ON platform_audit_platformauditevent;
DROP FUNCTION IF EXISTS platform_audit_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("platform_audit", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
