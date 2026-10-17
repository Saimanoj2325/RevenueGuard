from app.db import session_scope
from app.gateway import execute
from app.models import Case, Proposal

from .helpers import approvals, case_by_ref, latest_approval, play, suppress, user


async def test_evidence_change_expires_approval_and_reinvestigates(db):
    from app.approvals import ApprovalError, approve

    await play(7)  # PO-184 through AWAITING_APPROVAL (₹60,000)
    case = await case_by_ref()
    old = await latest_approval(case.id)
    assert old.status == "pending" and old.evidence_version == case.evidence_version
    await play(10)  # "Correction: 70 delivered" + sheet update
    aps = await approvals(case.id)
    first = next(a for a in aps if a.id == old.id)
    assert first.status == "expired" and "evidence_version" in first.expires_reason
    newest = aps[-1]
    assert newest.status == "pending" and float(newest.amount) == 70000.0 and newest.evidence_version > old.evidence_version
    case = await case_by_ref()
    assert case.state == "AWAITING_APPROVAL"
    # stale approval can be neither approved nor executed
    try:
        await approve(old.id, await user("finance@demo.in"))
        raise AssertionError("expired approval must not be approvable")
    except ApprovalError as e:
        assert e.status == 409
    r = await execute(old.id, "t")
    assert r.status in ("stale", "blocked")


async def test_approved_but_not_executed_expires_when_evidence_changes(db):
    from app.approvals import approve
    from app import case_service as cs

    await play(7)  # PO-184 through AWAITING_APPROVAL (₹60,000)
    case = await case_by_ref()
    ap = await latest_approval(case.id)
    async with suppress():
        await approve(ap.id, await user("finance@demo.in"))
    # new material evidence lands before the gateway runs
    async with session_scope() as s:
        c = await s.get(Case, case.id)
        await cs.add_evidence(s, c, c.tenant_id, kind="delivery_record", source="sheets", source_id="late-row", title="late", fields={"po_ref": "PO-184", "qty_delivered": 60})
    r = await execute(ap.id, "t")
    assert r.status in ("stale", "blocked")
    assert (await latest_approval(case.id)).status == "expired"


async def test_quarantined_injection_does_not_expire_or_change_case(db):
    await play(7)  # PO-184 through AWAITING_APPROVAL (₹60,000)
    case = await case_by_ref()
    ap = await latest_approval(case.id)
    res = await play(8)
    intake = res[0]["detail"]["intake"][0]
    assert intake["status"] == "quarantined" and intake["injection_prob"] >= 0.5
    case2 = await case_by_ref()
    assert case2.evidence_version == case.evidence_version and case2.state == "AWAITING_APPROVAL"
    assert (await latest_approval(case.id)).status == "pending" and (await latest_approval(case.id)).id == ap.id


async def test_human_edit_creates_new_version_and_revalidates(db):
    from app.approvals import edit

    await play(7)  # PO-184 through AWAITING_APPROVAL (₹60,000)
    case = await case_by_ref()
    ap = await latest_approval(case.id)
    async with session_scope() as s:
        p = await s.get(Proposal, ap.proposal_id)
        action = dict(p.payload)
    action["amount"] = 65000
    action["line_items"] = [{"item": "Model X", "qty": 65, "rate": 1000}]
    async with suppress():
        out = await edit(ap.id, await user("finance@demo.in"), action, "customer asked for 65")
    assert out["approval"]["status"] == "expired" and out["version"] == 2
    from app.orchestrator.engine import drive_case

    state = await drive_case(case.id)
    assert state == "AWAITING_APPROVAL"
    newest = await latest_approval(case.id)
    # validator facts override numbers: delivered 60 x 1000
    assert float(newest.amount) == 60000.0 and newest.id != ap.id
