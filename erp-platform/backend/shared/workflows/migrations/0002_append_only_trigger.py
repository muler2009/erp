from django.db import migrations

FORWARD = """
CREATE OR REPLACE FUNCTION workflow_action_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'workflow action history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_action_no_update_delete
    BEFORE UPDATE OR DELETE ON workflows_workflowaction
    FOR EACH ROW EXECUTE FUNCTION workflow_action_immutable();
"""
REVERSE = """
DROP TRIGGER IF EXISTS workflow_action_no_update_delete ON workflows_workflowaction;
DROP FUNCTION IF EXISTS workflow_action_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("workflows", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
