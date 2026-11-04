from datetime import datetime

from rms import edi


def test_build_edi_850_structure():
    po = {
        "po_num": "PO-1001",
        "sender": "REST001",
        "receiver": "SYSCO",
        "items": [
            {"qty": 4, "price": "32.50", "sku": "BEEF-50LB"},
            {"qty": 2, "price": "11.00", "sku": "LETT-24CT"},
        ],
    }
    doc = edi.build_edi_850(po, now=datetime(2026, 11, 4, 9, 5))
    lines = doc.split("\n")
    assert lines[0].startswith("ISA*00* *00* *ZZ*REST001*ZZ*SYSCO*261104*0905")
    assert lines[1] == "ST*850*PO-1001~"
    assert lines[2] == "BEG*00*NE*PO-1001**20261104~"
    assert lines[3] == "PO1*1*4*CA*32.50**VN*BEEF-50LB~"
    assert lines[4] == "PO1*2*2*CA*11.00**VN*LETT-24CT~"
    assert lines[5] == "CTT*2~"
    assert lines[6] == "SE*5*PO-1001~"  # blueprint formula: len(segments incl. ISA) - 1
