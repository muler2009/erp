from modules.documents import core, review


def run_daily():
    return review.daily(core.today())
