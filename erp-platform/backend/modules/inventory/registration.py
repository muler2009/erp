from shared.events.services import register_event

register_event("inventory.goods_received", required=["receipt_id", "po_id", "lines"])
register_event("inventory.stock.adjusted", required=["product_id", "location_id", "delta"])
