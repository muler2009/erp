from rest_framework.pagination import CursorPagination


class StandardPagination(CursorPagination):
    page_size = 50
    ordering = "-created_at"
    max_page_size = 200


def paginate(request, queryset, serialize, ordering="-created_at"):
    """Cursor-paginate `queryset` ordered by a stable key, serializing each row with `serialize`."""
    paginator = StandardPagination()
    paginator.ordering = ordering
    page = paginator.paginate_queryset(queryset, request)
    return paginator.get_paginated_response([serialize(obj) for obj in page])
