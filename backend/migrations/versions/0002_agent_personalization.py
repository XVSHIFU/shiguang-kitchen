"""Store chat title ownership and per-user assistant preferences."""

from alembic import op
from sqlalchemy import Column, String, inspect

from app.models import AgentPreferences

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = inspect(bind).get_columns("agent_threads")
    if not any(column["name"] == "title_origin" for column in columns):
        op.add_column("agent_threads", Column("title_origin", String(12), nullable=False, server_default="legacy"))
    AgentPreferences.__table__.create(bind=bind, checkfirst=True)


def downgrade():
    bind = op.get_bind()
    AgentPreferences.__table__.drop(bind=bind, checkfirst=True)
    with op.batch_alter_table("agent_threads") as batch:
        batch.drop_column("title_origin")
