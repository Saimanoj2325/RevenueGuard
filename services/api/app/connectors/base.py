"""Connector adapter interfaces. Vendor details stay behind these; investigation logic never sees them."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

CONNECTOR_NAMES = ("gmail", "sheets", "drive", "zoho", "whatsapp", "bank")


class ConnectorError(Exception):
    def __init__(self, connector: str, message: str, retryable: bool = True):
        super().__init__(f"{connector}: {message}")
        self.connector = connector
        self.retryable = retryable


class ConnectorUnavailable(ConnectorError):
    """Connector down / timeout / auth revoked. Orchestrator pauses the case."""


class ConnectorTimeout(ConnectorUnavailable):
    """Write may or may not have happened; caller must read back before retrying."""


class NotConnected(ConnectorError):
    def __init__(self, connector: str):
        super().__init__(connector, "not connected", retryable=False)


class GmailAdapter(ABC):
    @abstractmethod
    async def list_new_messages(self, cursor: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]: ...

    @abstractmethod
    async def search(self, query: str, limit: int = 20) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def send(self, to: str, subject: str, body: str, idempotency_key: str) -> str: ...


class SheetsAdapter(ABC):
    @abstractmethod
    async def read_delivery(self, ref: str | None = None) -> list[dict[str, Any]]: ...


class DriveAdapter(ABC):
    @abstractmethod
    async def search_docs(self, query: str, limit: int = 5) -> list[dict[str, Any]]: ...


class ZohoAdapter(ABC):
    @abstractmethod
    async def list_contacts(self, search: str | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def list_salesorders(self, search: str | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def list_invoices(self, search: str | None = None, customer_id: str | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def list_creditnotes(self, search: str | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def list_payments(self, search: str | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def create_invoice(self, payload: dict[str, Any], idempotency_key: str) -> dict[str, Any]: ...

    @abstractmethod
    async def get_invoice(self, invoice_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    async def find_invoices_by_reference(self, reference: str) -> list[dict[str, Any]]: ...


class BankAdapter(ABC):
    @abstractmethod
    async def payments(self, ref: str | None = None, amount: float | None = None) -> list[dict[str, Any]]: ...


class WhatsAppAdapter(ABC):
    @abstractmethod
    async def search(self, q: str | None = None, chat: str | None = None, since: str | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def send(self, to: str, text: str, idempotency_key: str, approval_id: str) -> str: ...

    async def lookup_send(self, idempotency_key: str) -> dict[str, Any] | None:
        """Read-check before a (re)send: {status: sent|pending|failed, message_id} if the key was used, else None."""
        return None

    @abstractmethod
    async def status(self) -> dict[str, Any]: ...
