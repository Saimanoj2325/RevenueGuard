"""SQLAlchemy 2 models. Every business table carries tenant_id; all queries are tenant scoped."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, EmbeddingType, JSONType, UTCDateTime, new_id, utcnow


def _id() -> Mapped[str]:
    return mapped_column(String(36), primary_key=True, default=new_id)


def _tenant() -> Mapped[str]:
    return mapped_column(String(36), ForeignKey("tenants.id"), index=True)


def _created() -> Mapped[datetime]:
    return mapped_column(UTCDateTime, default=utcnow)


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    case_seq: Mapped[int] = mapped_column(Integer, default=1041)
    created_at: Mapped[datetime] = _created()


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    email: Mapped[str] = mapped_column(String(200), unique=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(40))  # viewer|operator|finance_approver|admin
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _created()


class Case(Base):
    __tablename__ = "cases"
    __table_args__ = (
        UniqueConstraint("tenant_id", "case_number"),
        Index("ix_cases_tenant_state", "tenant_id", "state"),
        Index("ix_cases_tenant_ref", "tenant_id", "po_ref_norm"),
        Index("ix_cases_tenant_updated", "tenant_id", "updated_at"),
    )
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_number: Mapped[str] = mapped_column(String(40))
    state: Mapped[str] = mapped_column(String(40), default="INTAKE")
    exception_type: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    severity: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    customer: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    po_ref: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    po_ref_norm: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    amount: Mapped[Optional[float]] = mapped_column(Numeric(14, 2), nullable=True)
    evidence_version: Mapped[int] = mapped_column(Integer, default=0)
    correlation_id: Mapped[str] = mapped_column(String(36), default=new_id)
    budget_used: Mapped[dict] = mapped_column(JSONType, default=lambda: {"agent_runs": 0, "cost_inr": 0.0})
    retry_counts: Mapped[dict] = mapped_column(JSONType, default=dict)
    triage: Mapped[dict] = mapped_column(JSONType, default=dict)
    laya: Mapped[dict] = mapped_column(JSONType, default=dict)
    facts: Mapped[dict] = mapped_column(JSONType, default=dict)
    paused_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    paused_from: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    escalation_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    watch_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)
    awaiting_label: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)
    closed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)


class CaseCheckpoint(Base):
    __tablename__ = "case_checkpoints"
    __table_args__ = (UniqueConstraint("case_id", "seq"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    from_state: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    state: Mapped[str] = mapped_column(String(40))
    reason: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict] = mapped_column(JSONType, default=dict)
    evidence_version: Mapped[int] = mapped_column(Integer, default=0)
    correlation_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = _created()


class EvidenceNode(Base):
    __tablename__ = "evidence_nodes"
    __table_args__ = (
        UniqueConstraint("tenant_id", "case_id", "source", "source_id", name="uq_evidence_source"),
        Index("ix_evidence_case", "tenant_id", "case_id"),
    )
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("cases.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(40))
    source: Mapped[str] = mapped_column(String(20))  # gmail|whatsapp|sheets|drive|zoho|bank|media
    source_id: Mapped[str] = mapped_column(String(300))
    ts: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    excerpt: Mapped[str] = mapped_column(Text, default="")
    fields: Mapped[dict] = mapped_column(JSONType, default=dict)
    media_object_key: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    mime: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    derived_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    untrusted_flag: Mapped[bool] = mapped_column(Boolean, default=True)
    quarantined: Mapped[bool] = mapped_column(Boolean, default=False)
    injection_prob: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    content_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    evidence_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = _created()


class EvidenceEdge(Base):
    __tablename__ = "evidence_edges"
    __table_args__ = (UniqueConstraint("case_id", "from_id", "to_id", "label"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    from_id: Mapped[str] = mapped_column(String(36))
    to_id: Mapped[str] = mapped_column(String(36))
    label: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = _created()


class AgentRun(Base):
    __tablename__ = "agent_runs"
    id: Mapped[str] = _id()  # == run_id
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    agent: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="running")  # running|finished|failed
    runner: Mapped[str] = mapped_column(String(40), default="harness")
    correlation_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    input: Mapped[dict] = mapped_column(JSONType, default=dict)
    output: Mapped[Optional[dict]] = mapped_column(JSONType, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    budget: Mapped[dict] = mapped_column(JSONType, default=dict)
    evidence_version_in: Mapped[int] = mapped_column(Integer, default=0)
    evidence_version_after: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mode: Mapped[str] = mapped_column(String(20), default="adaptive")
    cost_inr: Mapped[float] = mapped_column(Float, default=0.0)
    tokens: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = _created()
    finished_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)


class AgentEvent(Base):
    __tablename__ = "agent_events"
    __table_args__ = (Index("ix_agent_events_case", "tenant_id", "case_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = _tenant()
    run_id: Mapped[str] = mapped_column(String(36), index=True)
    case_id: Mapped[str] = mapped_column(String(36))
    type: Mapped[str] = mapped_column(String(40))
    agent: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(JSONType, default=dict)
    ts: Mapped[datetime] = _created()


class ToolCall(Base):
    __tablename__ = "tool_calls"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[Optional[str]] = mapped_column(String(36), index=True, nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    agent: Mapped[str] = mapped_column(String(40))
    tool: Mapped[str] = mapped_column(String(60))
    args: Mapped[dict] = mapped_column(JSONType, default=dict)
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    result_summary: Mapped[dict] = mapped_column(JSONType, default=dict)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    correlation_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = _created()


class Proposal(Base):
    __tablename__ = "proposals"
    __table_args__ = (UniqueConstraint("case_id", "version"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSONType)  # the exact action
    payload_hash: Mapped[str] = mapped_column(String(64))
    claims: Mapped[list] = mapped_column(JSONType, default=list)
    uncertainty: Mapped[list] = mapped_column(JSONType, default=list)
    risk: Mapped[str] = mapped_column(String(20), default="medium")
    validation: Mapped[dict] = mapped_column(JSONType, default=dict)
    evidence_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active|superseded|rejected|invalid
    created_by: Mapped[str] = mapped_column(String(80), default="agent:resolution")
    created_at: Mapped[datetime] = _created()


class Approval(Base):
    __tablename__ = "approvals"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    proposal_id: Mapped[str] = mapped_column(String(36), ForeignKey("proposals.id"))
    payload_hash: Mapped[str] = mapped_column(String(64))
    evidence_version: Mapped[int] = mapped_column(Integer)
    amount: Mapped[Optional[float]] = mapped_column(Numeric(14, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="pending")
    required_approvers: Mapped[int] = mapped_column(Integer, default=1)
    approvers: Mapped[list] = mapped_column(JSONType, default=list)
    expires_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    rejected_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)


class Action(Base):
    __tablename__ = "actions"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    approval_id: Mapped[str] = mapped_column(String(36), ForeignKey("approvals.id"))
    proposal_id: Mapped[str] = mapped_column(String(36))
    type: Mapped[str] = mapped_column(String(40))
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|succeeded|failed|unknown
    target_system: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    request: Mapped[dict] = mapped_column(JSONType, default=dict)
    response: Mapped[dict] = mapped_column(JSONType, default=dict)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    executed_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class Verification(Base):
    __tablename__ = "verifications"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    action_id: Mapped[str] = mapped_column(String(36), ForeignKey("actions.id"))
    status: Mapped[str] = mapped_column(String(10))  # pass|fail
    checks: Mapped[list] = mapped_column(JSONType, default=list)
    read_back: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = _created()


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = _tenant()
    seq: Mapped[int] = mapped_column(Integer)
    case_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    correlation_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(200))
    event: Mapped[str] = mapped_column(String(80))
    data: Mapped[dict] = mapped_column(JSONType, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()
    __table_args__ = (
        Index("ix_audit_tenant_case", "tenant_id", "case_id"),
        UniqueConstraint("tenant_id", "seq", name="uq_audit_tenant_seq"),
    )


class Connector(Base):
    __tablename__ = "connectors"
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    name: Mapped[str] = mapped_column(String(40))  # gmail|sheets|drive|zoho|whatsapp|bank
    status: Mapped[str] = mapped_column(String(20), default="disconnected")
    mode: Mapped[str] = mapped_column(String(10), default="mock")  # mock|live
    auth_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Fernet-encrypted JSON
    config: Mapped[dict] = mapped_column(JSONType, default=dict)
    cursor: Mapped[dict] = mapped_column(JSONType, default=dict)
    authorized_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    authorized_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class TriageQueueItem(Base):
    __tablename__ = "triage_queue"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    triage: Mapped[dict] = mapped_column(JSONType, default=dict)
    confidence: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    label: Mapped[Optional[dict]] = mapped_column(JSONType, nullable=True)
    labeled_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = _created()


class Escalation(Base):
    __tablename__ = "escalations"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    reason: Mapped[str] = mapped_column(String(60))
    detail: Mapped[dict] = mapped_column(JSONType, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="open")
    resolved_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    resolution: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()
    resolved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)


class CaseLearning(Base):
    __tablename__ = "case_learnings"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    text: Mapped[str] = mapped_column(Text)
    tags: Mapped[list] = mapped_column(JSONType, default=list)
    embedding: Mapped[Optional[list]] = mapped_column(EmbeddingType, nullable=True)
    created_at: Mapped[datetime] = _created()


class WaMessage(Base):
    __tablename__ = "wa_messages"
    __table_args__ = (UniqueConstraint("tenant_id", "message_id"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    message_id: Mapped[str] = mapped_column(String(200))
    chat_id: Mapped[str] = mapped_column(String(200))
    from_jid: Mapped[str] = mapped_column(String(200), default="")
    from_name: Mapped[str] = mapped_column(String(200), default="")
    ts: Mapped[datetime] = mapped_column(UTCDateTime)
    text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    media_mime: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    media_object_key: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    derived_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()


class IntakeRecord(Base):
    """Dedup ledger for secure intake: one row per (tenant, source, source_id)."""

    __tablename__ = "intake_records"
    __table_args__ = (UniqueConstraint("tenant_id", "source", "source_id", name="uq_intake_source"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    source: Mapped[str] = mapped_column(String(20))
    source_id: Mapped[str] = mapped_column(String(300))
    content_hash: Mapped[str] = mapped_column(String(64))
    case_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    node_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="accepted")  # accepted|quarantined|rejected|unlinked
    created_at: Mapped[datetime] = _created()


class KvFlag(Base):
    """Per-tenant runtime flags: kill switch, chaos toggles, virtual clock offset."""

    __tablename__ = "kv_flags"
    tenant_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONType)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


# ============================================================================ UX v2 business layer
class TenantSetting(Base):
    """Per-tenant business settings (company GSTIN, UPI VPA, digest, reminder ladder, GST defaults, language)."""

    __tablename__ = "tenant_settings"
    tenant_id: Mapped[str] = mapped_column(String(36), ForeignKey("tenants.id"), primary_key=True)
    data: Mapped[dict] = mapped_column(JSONType, default=dict)
    updated_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class ChatMemory(Base):
    """What one WhatsApp chat has told us so far: the POs/cases it talks about, challans it sent, and its recent
    statements as read by the LLM. The reader LLM, case matching and the agents (read_chat_memory) all use it."""

    __tablename__ = "chat_memory"
    __table_args__ = (UniqueConstraint("tenant_id", "chat_id", name="uq_chat_memory"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    chat_id: Mapped[str] = mapped_column(String(200))
    chat_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    active_case_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    customer: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    cases: Mapped[list] = mapped_column(JSONType, default=list)  # [{case_id, case_number, po, customer, last_seen}]
    challans: Mapped[list] = mapped_column(JSONType, default=list)  # [{no, po, qty, case_number, ts}]
    events: Mapped[list] = mapped_column(JSONType, default=list)  # last 20 statements [{ts, po, said, read_as, by}]
    # written by the timeline agent (write_chat_memory): {active_po, open_questions, pending, summary}
    state: Mapped[dict] = mapped_column(JSONType, default=dict)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Alias(Base):
    """Learned spellings: 'Exmpl Cust' = Example Customer Pvt Ltd, '184' = PO-184. Used by intake matching."""

    __tablename__ = "aliases"
    __table_args__ = (UniqueConstraint("tenant_id", "kind", "alias_norm", name="uq_alias"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    kind: Mapped[str] = mapped_column(String(20))  # customer | po
    alias: Mapped[str] = mapped_column(String(200))
    alias_norm: Mapped[str] = mapped_column(String(200))
    canonical: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[str] = mapped_column(String(200), default="system")
    created_at: Mapped[datetime] = _created()


class UnlinkedItem(Base):
    """Intake items that could not be matched to a PO/case (Unlinked inbox)."""

    __tablename__ = "unlinked_items"
    __table_args__ = (UniqueConstraint("tenant_id", "source", "source_id", name="uq_unlinked_source"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    source: Mapped[str] = mapped_column(String(20))
    source_id: Mapped[str] = mapped_column(String(300))
    node_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    received_at: Mapped[datetime] = _created()
    sender: Mapped[str] = mapped_column(String(300), default="")
    preview: Mapped[str] = mapped_column(Text, default="")
    extracted: Mapped[dict] = mapped_column(JSONType, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | linked | ignored
    linked_case_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    decided_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = _created()


class NotBillableMark(Base):
    __tablename__ = "not_billable_marks"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), index=True)
    reason: Mapped[str] = mapped_column(String(40))  # sample|replacement|returned|billed_elsewhere|other
    note: Mapped[str] = mapped_column(Text, default="")
    marked_by: Mapped[str] = mapped_column(String(200))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _created()


class Snooze(Base):
    __tablename__ = "snoozes"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    invoice_number: Mapped[str] = mapped_column(String(80), index=True)
    customer_id: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    until: Mapped[datetime] = mapped_column(UTCDateTime)
    reason: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = _created()


class Reminder(Base):
    """Payment reminder ladder per invoice. Sending always goes through approval + gateway (approval_id)."""

    __tablename__ = "reminders"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    invoice_number: Mapped[str] = mapped_column(String(80), index=True)
    customer_id: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    stage: Mapped[int] = mapped_column(Integer, default=7)
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft|sent|read|replied|rejected|expired
    amount: Mapped[Optional[float]] = mapped_column(Numeric(14, 2), nullable=True)
    message: Mapped[str] = mapped_column(Text, default="")
    upi_link: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    case_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    approval_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(200), default="system")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class UserPhone(Base):
    """Approver phone linked for WhatsApp approvals / digest (E.164 digits, no '+')."""

    __tablename__ = "user_phones"
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    tenant_id: Mapped[str] = _tenant()
    phone: Mapped[str] = mapped_column(String(20), index=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class NotificationPref(Base):
    __tablename__ = "notification_prefs"
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    tenant_id: Mapped[str] = _tenant()
    data: Mapped[dict] = mapped_column(JSONType, default=dict)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class SheetMapping(Base):
    __tablename__ = "sheet_mappings"
    __table_args__ = (UniqueConstraint("tenant_id", "sheet_id", "tab", name="uq_sheet_mapping"),)
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    sheet_id: Mapped[str] = mapped_column(String(200))
    tab: Mapped[str] = mapped_column(String(200), default="Sheet1")
    columns: Mapped[list] = mapped_column(JSONType, default=list)  # proposal [{header, meaning, confidence, sample}]
    mapping: Mapped[dict] = mapped_column(JSONType, default=dict)  # confirmed {header: meaning}
    confirmed_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class BackfillJob(Base):
    __tablename__ = "backfill_jobs"
    id: Mapped[str] = _id()
    tenant_id: Mapped[str] = _tenant()
    days: Mapped[int] = mapped_column(Integer, default=90)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|running|done|failed
    sources: Mapped[list] = mapped_column(JSONType, default=list)  # [{name, done, total, status}]
    first_case_ref: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = _created()
    finished_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime, nullable=True)
