"""Timeline agent: chat memory state written by the agent (active_po, open_questions, pending, summary).

Message lifecycle data (versions, status, duplicate_of, hashes) lives in evidence_nodes.fields JSON: no new columns.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-16 09:30:00
"""
from alembic import op
import sqlalchemy as sa
import app.db


revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('chat_memory', sa.Column('state', app.db.JSONType(), nullable=True))


def downgrade() -> None:
    op.drop_column('chat_memory', 'state')
