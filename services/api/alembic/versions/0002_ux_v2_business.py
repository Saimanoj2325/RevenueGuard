"""UX v2 business layer: settings, aliases, unlinked inbox, not-billable marks, snoozes, reminders,
user phones, notification prefs, sheet mappings, backfill jobs.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-15 22:45:00
"""
from alembic import op
import sqlalchemy as sa
import app.db


revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None

J = app.db.JSONType
T = lambda: app.db.UTCDateTime(timezone=True)  # noqa: E731


def _tenant():
    return sa.Column('tenant_id', sa.String(length=36), sa.ForeignKey('tenants.id'), nullable=False)


def upgrade() -> None:
    op.create_table('tenant_settings',
        sa.Column('tenant_id', sa.String(length=36), sa.ForeignKey('tenants.id'), primary_key=True),
        sa.Column('data', J(), nullable=False),
        sa.Column('updated_by', sa.String(length=200), nullable=True),
        sa.Column('updated_at', T(), nullable=False))
    op.create_table('aliases',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('alias', sa.String(length=200), nullable=False),
        sa.Column('alias_norm', sa.String(length=200), nullable=False),
        sa.Column('canonical', sa.String(length=200), nullable=False),
        sa.Column('created_by', sa.String(length=200), nullable=False),
        sa.Column('created_at', T(), nullable=False),
        sa.UniqueConstraint('tenant_id', 'kind', 'alias_norm', name='uq_alias'))
    op.create_index('ix_aliases_tenant_id', 'aliases', ['tenant_id'])
    op.create_table('unlinked_items',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('source_id', sa.String(length=300), nullable=False),
        sa.Column('node_id', sa.String(length=36), nullable=True),
        sa.Column('received_at', T(), nullable=False),
        sa.Column('sender', sa.String(length=300), nullable=False),
        sa.Column('preview', sa.Text(), nullable=False),
        sa.Column('extracted', J(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('linked_case_id', sa.String(length=36), nullable=True),
        sa.Column('decided_by', sa.String(length=200), nullable=True),
        sa.Column('decided_at', T(), nullable=True),
        sa.Column('created_at', T(), nullable=False),
        sa.UniqueConstraint('tenant_id', 'source', 'source_id', name='uq_unlinked_source'))
    op.create_index('ix_unlinked_items_tenant_id', 'unlinked_items', ['tenant_id'])
    op.create_table('not_billable_marks',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('case_id', sa.String(length=36), sa.ForeignKey('cases.id'), nullable=False),
        sa.Column('reason', sa.String(length=40), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('marked_by', sa.String(length=200), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.Column('created_at', T(), nullable=False))
    op.create_index('ix_not_billable_marks_tenant_id', 'not_billable_marks', ['tenant_id'])
    op.create_index('ix_not_billable_marks_case_id', 'not_billable_marks', ['case_id'])
    op.create_table('snoozes',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('invoice_number', sa.String(length=80), nullable=False),
        sa.Column('customer_id', sa.String(length=80), nullable=True),
        sa.Column('until', T(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('created_by', sa.String(length=200), nullable=False),
        sa.Column('created_at', T(), nullable=False))
    op.create_index('ix_snoozes_tenant_id', 'snoozes', ['tenant_id'])
    op.create_index('ix_snoozes_invoice_number', 'snoozes', ['invoice_number'])
    op.create_table('reminders',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('invoice_number', sa.String(length=80), nullable=False),
        sa.Column('customer_id', sa.String(length=80), nullable=True),
        sa.Column('stage', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('amount', sa.Numeric(14, 2), nullable=True),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('upi_link', sa.Text(), nullable=True),
        sa.Column('case_id', sa.String(length=36), nullable=True),
        sa.Column('approval_id', sa.String(length=36), nullable=True),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_by', sa.String(length=200), nullable=False),
        sa.Column('created_at', T(), nullable=False),
        sa.Column('updated_at', T(), nullable=False))
    op.create_index('ix_reminders_tenant_id', 'reminders', ['tenant_id'])
    op.create_index('ix_reminders_invoice_number', 'reminders', ['invoice_number'])
    op.create_table('user_phones',
        sa.Column('user_id', sa.String(length=36), sa.ForeignKey('users.id'), primary_key=True), _tenant(),
        sa.Column('phone', sa.String(length=20), nullable=False),
        sa.Column('created_at', T(), nullable=False),
        sa.Column('updated_at', T(), nullable=False))
    op.create_index('ix_user_phones_tenant_id', 'user_phones', ['tenant_id'])
    op.create_index('ix_user_phones_phone', 'user_phones', ['phone'])
    op.create_table('notification_prefs',
        sa.Column('user_id', sa.String(length=36), sa.ForeignKey('users.id'), primary_key=True), _tenant(),
        sa.Column('data', J(), nullable=False),
        sa.Column('updated_at', T(), nullable=False))
    op.create_index('ix_notification_prefs_tenant_id', 'notification_prefs', ['tenant_id'])
    op.create_table('sheet_mappings',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('sheet_id', sa.String(length=200), nullable=False),
        sa.Column('tab', sa.String(length=200), nullable=False),
        sa.Column('columns', J(), nullable=False),
        sa.Column('mapping', J(), nullable=False),
        sa.Column('confirmed_by', sa.String(length=200), nullable=True),
        sa.Column('created_at', T(), nullable=False),
        sa.Column('updated_at', T(), nullable=False),
        sa.UniqueConstraint('tenant_id', 'sheet_id', 'tab', name='uq_sheet_mapping'))
    op.create_index('ix_sheet_mappings_tenant_id', 'sheet_mappings', ['tenant_id'])
    op.create_table('backfill_jobs',
        sa.Column('id', sa.String(length=36), primary_key=True), _tenant(),
        sa.Column('days', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('sources', J(), nullable=False),
        sa.Column('first_case_ref', sa.String(length=40), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_by', sa.String(length=200), nullable=False),
        sa.Column('created_at', T(), nullable=False),
        sa.Column('finished_at', T(), nullable=True))
    op.create_index('ix_backfill_jobs_tenant_id', 'backfill_jobs', ['tenant_id'])


def downgrade() -> None:
    for t in ('backfill_jobs', 'sheet_mappings', 'notification_prefs', 'user_phones', 'reminders', 'snoozes',
              'not_billable_marks', 'unlinked_items', 'aliases', 'tenant_settings'):
        op.drop_table(t)
