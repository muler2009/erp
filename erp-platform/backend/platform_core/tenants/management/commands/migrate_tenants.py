from django.core.management.base import BaseCommand, CommandError

from platform_core.tenants.migrations_fanout import migrate_tenants


class Command(BaseCommand):
    help = "Run pending migrations for every serving tenant schema; failures mark the tenant MIGRATION_FAILED and exit non-zero."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", action="append", dest="slugs", help="Limit to this tenant slug (repeatable).")

    def handle(self, *args, **opts):
        result = migrate_tenants(opts.get("slugs"))
        for slug in result["ok"]:
            self.stdout.write(self.style.SUCCESS(f"migrated {slug}"))
        for slug, err in result["failed"].items():
            self.stderr.write(self.style.ERROR(f"FAILED {slug}: {err}"))
        if result["failed"]:
            raise CommandError(f"{len(result['failed'])} tenant(s) failed to migrate")
