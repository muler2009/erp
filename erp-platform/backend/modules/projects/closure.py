"""Extra conditions that must hold before a project can be completed. Later slices (issues, expenses) register checks here."""

CHECKS = []  # callables(project) that raise DomainError to veto completion


def check_can_complete(project):
    for c in CHECKS:
        c(project)
