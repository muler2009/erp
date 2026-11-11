from modules.quality import audits, calibration, core, ncr, planning, risks, suppliers


def run_daily():
    on = core.today()
    return {"actions": core.action_reminders(on), "capa": ncr.reminders(on), "audit": audits.reminders(on), "calibration": calibration.reminders(on),
            "certificates": suppliers.reminders(on), "risks": risks.reminders(on), "compliance": planning.compliance_reminders(on)}
