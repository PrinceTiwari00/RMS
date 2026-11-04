"""EDI 850 (Purchase Order) generation for broadline distributors
(Sysco, US Foods) over SFTP — blueprint §13."""

from datetime import datetime


def build_edi_850(po_data: dict, now: datetime | None = None) -> str:
    """Build an ANSI X12 850 document from PO data.

    po_data: {"po_num": str, "sender": str, "receiver": str, "items": [{"qty", "price", "sku"}]}
    """
    now = now or datetime.now()
    now_date = now.strftime("%Y%m%d")
    now_time = now.strftime("%H%M")

    edi = []
    # Envelopes & Headers
    edi.append(f"ISA*00* *00* *ZZ*{po_data['sender']}*ZZ*{po_data['receiver']}"
               f"*{now_date[2:]}*{now_time}")
    edi.append(f"ST*850*{po_data['po_num']}~")
    edi.append(f"BEG*00*NE*{po_data['po_num']}**{now_date}~")

    # Line Items
    for idx, item in enumerate(po_data["items"], start=1):
        edi.append(f"PO1*{idx}*{item['qty']}*CA*{item['price']}**VN*{item['sku']}~")

    # Footer
    edi.append(f"CTT*{len(po_data['items'])}~")
    edi.append(f"SE*{len(edi) - 1}*{po_data['po_num']}~")

    return "\n".join(edi)
