"""Chat memory layer: per-WhatsApp-chat memory of cases, challans and recent statements.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-16 08:40:00
"""
from alembic import op
import sqlalchemy as sa
import app.db


revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('chat_memory',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), sa.ForeignKey('tenants.id'), nullable=False),
        sa.Column('chat_id', sa.String(length=200), nullable=False),
        sa.Column('chat_name', sa.String(length=200), nullable=True),
        sa.Column('active_case_id', sa.String(length=36), nullable=True),
        sa.Column('customer', sa.String(length=300), nullable=True),
        sa.Column('cases', app.db.JSONType(), nullable=False),
        sa.Column('challans', app.db.JSONType(), nullable=False),
        sa.Column('events', app.db.JSONType(), nullable=False),
        sa.Column('updated_at', app.db.UTCDateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('tenant_id', 'chat_id', name='uq_chat_memory'))
    op.create_index('ix_chat_memory_tenant_id', 'chat_memory', ['tenant_id'])


def downgrade() -> None:
    op.drop_index('ix_chat_memory_tenant_id', table_name='chat_memory')
    op.drop_table('chat_memory')
