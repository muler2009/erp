from celery import shared_task

from platform_core.tenants.provisioning import run_provisioning


@shared_task(name="tenants.provision", bind=True, max_retries=0)
def provision_tenant_task(self, job_id):
    """Failures are recorded on the ProvisioningJob/Step rows (and alerted), never swallowed here."""
    run_provisioning(job_id)
