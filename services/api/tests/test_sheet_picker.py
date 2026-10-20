"""Sheet picker: list sheets + tabs (suggested tab), save shows title/tab, links accepted, NIM auto-pick."""
import pytest
from httpx import ASGITransport, AsyncClient

from .test_business_api import Api


@pytest.fixture
async def api(db):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t", timeout=300) as c:
        yield Api(c)

from app.routers.connectors import _sheet_id_of, _tab_score


def test_sheet_id_of_link_and_bare():
    assert _sheet_id_of("https://docs.google.com/spreadsheets/d/1UIhRx3Kwxn-M75_MJ/edit#gid=0") == "1UIhRx3Kwxn-M75_MJ"
    assert _sheet_id_of(" 1abcDEF_-x ") == "1abcDEF_-x"


def test_tab_score_prefers_delivery_headers():
    assert _tab_score(["PO No", "Party", "Qty", "Disp.", "Bal"]) >= 3
    assert _tab_score(["Note"]) == 0


def test_range_quoting():
    from app.connectors.google import _q

    assert _q("Oct!A1:Z21") == "%27Oct%27%21A1%3AZ21"
    assert _q("Dispatch Oct!A1:Z21").startswith("%27Dispatch%20Oct%27")


def test_nim_candidates_auto_and_list(monkeypatch):
    from app.config import get_settings
    from app.llm import nim_models

    s = get_settings()
    monkeypatch.setattr(s, "nim_model", "auto")
    assert nim_models.candidates("text")[0] == nim_models.BUILTIN["text"][0]
    monkeypatch.setattr(s, "nim_model", "z-ai/glm-5.3-flash, openai/gpt-oss-20b")
    c = nim_models.candidates("text")
    assert c[:2] == ["z-ai/glm-5.3-flash", "openai/gpt-oss-20b"] and len(c) == len(set(c))
    assert nim_models.looks_gone("Error code: 404 - Not found for account")
    assert nim_models.looks_gone("TimeoutError")
    assert not nim_models.looks_gone("Error code: 401")


@pytest.mark.asyncio
async def test_nim_pick_skips_gone_model(monkeypatch):
    from app.config import get_settings
    from app.llm import nim_models

    s = get_settings()
    nim_models.reset()
    monkeypatch.setattr(s, "nvidia_api_key", "k")
    monkeypatch.setattr(s, "nim_model", "gone/model,good/model")

    async def fake_probe(m, timeout=1):
        return (m == "good/model", 5, None if m == "good/model" else "NotFoundError: 404")
    monkeypatch.setattr(nim_models, "_probe", fake_probe)
    assert await nim_models.pick("text") == "good/model"
    assert nim_models.is_bad("gone/model")
    nim_models.reset()


async def test_sheet_files_tabs_and_saved_config(api, db):
    assert (await api.get("/connectors/sheets/files")).status_code == 409  # Google not connected
    assert (await api.get("/connectors/sheets/config")).json()["spreadsheet_id"] is None
    await api.post("/connectors/sheets/mock-connect")
    files = (await api.get("/connectors/sheets/files")).json()["files"]
    assert files[0]["name"] == "Dispatch Register"
    t = (await api.get(f"/connectors/sheets/tabs?sheet_id={files[0]['id']}")).json()
    assert [x["title"] for x in t["tabs"]] == ["Sep", "Oct", "Notes"] and t["suggested"] == "Oct"
    link = f"https://docs.google.com/spreadsheets/d/{files[0]['id']}/edit#gid=0"
    r = (await api.post("/connectors/sheets/propose-mapping", {"sheet_id": link, "tab": "Oct"})).json()
    assert r["title"] == "Dispatch Register" and r["tab"] == "Oct" and r["rows"] >= 0
    mapping = {c["header"]: c["meaning"] for c in r["columns"]}
    ok = await api.post("/connectors/sheets/config", {"spreadsheet_id": link, "range": "Oct!A1:Z1000", "mapping": mapping, "title": "Dispatch Register"})
    assert ok.status_code == 200
    cfg = (await api.get("/connectors/sheets/config")).json()
    assert cfg["spreadsheet_id"] == files[0]["id"] and cfg["tab"] == "Oct" and cfg["title"] == "Dispatch Register" and cfg["mapping"] == mapping


async def test_nim_pick_skips_slow_model(monkeypatch):
    from app.config import get_settings
    from app.llm import nim_models

    s = get_settings()
    nim_models.reset()
    monkeypatch.setattr(s, "nvidia_api_key", "k")
    monkeypatch.setattr(s, "nim_model", "slow/model,fast/model")

    async def fake_probe(m, timeout=1):
        return (True, 9000 if m == "slow/model" else 400, None)
    monkeypatch.setattr(nim_models, "_probe", fake_probe)
    assert await nim_models.pick("text") == "fast/model"
    nim_models.reset()
