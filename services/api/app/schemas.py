"""Agent output schemas (CONTRACT §Output schemas), re-validated by the API even after Harness zod validation."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

ExceptionType = Literal["missing_invoice", "partial_delivery", "duplicate_invoice", "partial_payment", "quantity_conflict", "billing_not_due", "none"]
Severity = Literal["low", "medium", "high", "critical"]
Link = Literal["order", "delivery", "invoice", "payment"]


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class TriageRefs(_Base):
    po: Optional[str] = None
    customer: Optional[str] = None
    amount: Optional[float] = None
    qty: Optional[float] = None


class TriageOutput(_Base):
    exception_type: ExceptionType
    severity: Severity
    genuine_prob: float = Field(ge=0, le=1)
    needs_review_prob: float = Field(ge=0, le=1)
    laya: dict[str, Any] = Field(default_factory=dict)
    refs: TriageRefs
    summary: str


class EvidenceOutput(_Base):
    nodes_added: list[str]
    missing_links: list[Link]
    summary: str


class InvestigationStep(_Base):
    tool: str
    why: str
    added_evidence: bool
    evidence_node_ids: list[str] = Field(default_factory=list)


class InvestigationOutput(_Base):
    steps: list[InvestigationStep]
    findings: list[str]
    stop_reason: Literal["gap_closed", "no_new_evidence", "conflict", "budget"]
    conflict: bool


class LineItem(_Base):
    item: str
    qty: float = Field(ge=0)
    rate: float = Field(ge=0)


class ProposedAction(_Base):
    type: Literal["create_invoice", "send_reminder", "none"]
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    reference: Optional[str] = None
    line_items: list[LineItem] = Field(default_factory=list)
    amount: float = 0
    message: Optional[str] = None
    channel: Optional[Literal["whatsapp", "gmail"]] = None
    top_up_of: Optional[list[str]] = None  # invoices this one tops up (extra delivery); validator-checked, hash-bound


class Claim(_Base):
    text: str
    evidence_node_ids: list[str]


class ResolutionOutput(_Base):
    action: ProposedAction
    claims: list[Claim]
    uncertainty: list[str]
    risk: Literal["low", "medium", "high"]


# ------------------------------------------------------------------ timeline agent (CONTRACT_V3 §1)
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TimelineLink(_Strict):
    action: Literal["existing_case", "new_case", "ask_which_po", "not_business"]
    case_ref: Optional[str] = None
    po_ref: Optional[str] = None
    why: str = Field(min_length=1, max_length=600)


class TimelineEvent(_Strict):
    node_id: str = Field(min_length=1)
    qty: float
    role: str = Field(pattern=r"^(counts|replaced|ignored|duplicate_of:.+)$")
    why: str = Field(min_length=1, max_length=400)


class TimelineDelivered(_Strict):
    total: Optional[float] = None
    events: list[TimelineEvent] = Field(default_factory=list)


class TimelineDecision(_Strict):
    link: TimelineLink
    meaning: Literal["delivery", "extra_delivery", "correction", "duplicate", "edit", "retraction", "payment", "order", "question", "noise"]
    delivered: TimelineDelivered
    memory_patch: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(ge=0, le=1)
    explanation_for_owner: str = Field(min_length=1, max_length=400)


AGENT_SCHEMAS: dict[str, type[BaseModel]] = {
    "timeline": TimelineDecision,
    "triage": TriageOutput,
    "evidence": EvidenceOutput,
    "investigation": InvestigationOutput,
    "resolution": ResolutionOutput,
}
