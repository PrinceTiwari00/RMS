import pytest

from rms.db import connect, init_db


@pytest.fixture
def conn():
    c = connect(":memory:")
    init_db(c)
    return c
