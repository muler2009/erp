from modules.analytics import core, dashboards, kpis, schedules


def run_daily():
    on = core.today()
    dashboards.ensure_defaults()
    return {"kpis": kpis.daily(on), "schedules": schedules.run_due(on)}
