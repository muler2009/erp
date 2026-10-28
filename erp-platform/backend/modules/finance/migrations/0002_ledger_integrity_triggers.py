from django.db import migrations

# Runs in every tenant schema. Defence in depth behind the service layer: even a direct SQL/ORM write cannot
# unbalance or alter the posted ledger.
FORWARD = """
CREATE OR REPLACE FUNCTION finance_guard_lines() RETURNS trigger AS $$
DECLARE st text;
BEGIN
    SELECT status INTO st FROM finance_journalentry WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
    IF st IS NOT NULL AND st <> 'DRAFT' THEN
        RAISE EXCEPTION 'journal lines of a posted entry are immutable';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER finance_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_journalline
    FOR EACH ROW EXECUTE FUNCTION finance_guard_lines();

CREATE OR REPLACE FUNCTION finance_guard_entry() RETURNS trigger AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'posted journal entries cannot be deleted'; END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'reversed journal entries are immutable'; END IF;
    IF OLD.status = 'POSTED' THEN
        IF NEW.status NOT IN ('POSTED', 'REVERSED')
           OR (NEW.number, NEW.entry_date, NEW.period_id, NEW.memo, NEW.source_type, NEW.source_id, NEW.posted_by, NEW.posted_at)
              IS DISTINCT FROM (OLD.number, OLD.entry_date, OLD.period_id, OLD.memo, OLD.source_type, OLD.source_id, OLD.posted_by, OLD.posted_at) THEN
            RAISE EXCEPTION 'posted journal entries are immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.status = 'POSTED' THEN
        SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*) INTO d, c, n FROM finance_journalline WHERE entry_id = NEW.id;
        IF n < 2 OR d <> c OR d = 0 THEN RAISE EXCEPTION 'cannot post an unbalanced journal entry (debit %, credit %)', d, c; END IF;
    ELSIF NEW.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'invalid journal status transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER finance_entry_guard BEFORE UPDATE OR DELETE ON finance_journalentry
    FOR EACH ROW EXECUTE FUNCTION finance_guard_entry();
"""
REVERSE = """
DROP TRIGGER IF EXISTS finance_entry_guard ON finance_journalentry;
DROP TRIGGER IF EXISTS finance_lines_guard ON finance_journalline;
DROP FUNCTION IF EXISTS finance_guard_entry();
DROP FUNCTION IF EXISTS finance_guard_lines();
"""


class Migration(migrations.Migration):
    dependencies = [("finance", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
