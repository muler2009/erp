from django.db import migrations

FORWARD = """
CREATE OR REPLACE FUNCTION inventory_movement_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'stock movements are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_movement_no_update_delete
    BEFORE UPDATE OR DELETE ON inventory_stockmovement
    FOR EACH ROW EXECUTE FUNCTION inventory_movement_immutable();
"""
REVERSE = """
DROP TRIGGER IF EXISTS inventory_movement_no_update_delete ON inventory_stockmovement;
DROP FUNCTION IF EXISTS inventory_movement_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("inventory", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
