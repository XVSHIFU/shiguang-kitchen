"""Associate PostgreSQL meal-change proposals with their workflow checkpoints."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    columns = sa.inspect(op.get_bind()).get_columns("agent_actions")
    if all(column["name"] != "checkpoint_thread_id" for column in columns):
        op.add_column("agent_actions", sa.Column("checkpoint_thread_id", sa.String(65)))


def downgrade():
    with op.batch_alter_table("agent_actions") as batch:
        batch.drop_column("checkpoint_thread_id")
