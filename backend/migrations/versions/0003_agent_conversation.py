"""Add assistant personas and quoted conversation context."""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    if "persona" not in {c["name"] for c in sa.inspect(conn).get_columns("agent_preferences")}:
        op.add_column("agent_preferences", sa.Column(
            "persona", sa.String(16), server_default="custom", nullable=False))
    for table in ("agent_threads", "agent_runs"):
        if "context_json" not in {c["name"] for c in sa.inspect(conn).get_columns(table)}:
            op.add_column(table, sa.Column("context_json", sa.JSON(), nullable=True))


def downgrade():
    for table, col in (("agent_runs", "context_json"), ("agent_threads", "context_json"),
                       ("agent_preferences", "persona")):
        with op.batch_alter_table(table) as batch:
            batch.drop_column(col)
