"""Persistent human approval for a fixed meal replacement on PostgreSQL."""

from typing import Literal, TypedDict

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models import AgentAction, AgentRun

Decision = Literal["approve", "reject"]


class ApprovalState(TypedDict, total=False):
    action_id: str
    payload_hash: str
    decision: Decision


def wait_for_approval(state: ApprovalState) -> ApprovalState:
    decision = interrupt({
        "type": "approval.required",
        "action_id": state["action_id"],
        "payload_hash": state["payload_hash"],
    })
    return {"decision": decision}


_graph = StateGraph(ApprovalState)
_graph.add_node("wait_for_approval", wait_for_approval)
_graph.add_edge(START, "wait_for_approval")
_graph.add_edge("wait_for_approval", END)


def setup_checkpointer(engine: Engine) -> None:
    if engine.dialect.driver != "psycopg":
        return
    # PostgresSaver migrations use CREATE INDEX CONCURRENTLY.
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        lock = "shiguang.langgraph.checkpoint.setup"
        conn.execute(text("SELECT pg_advisory_lock(hashtext(:lock))"), {"lock": lock})
        try:
            PostgresSaver(conn.connection.driver_connection).setup()
        finally:
            conn.execute(text("SELECT pg_advisory_unlock(hashtext(:lock))"), {"lock": lock})


def _saver(db: Session) -> PostgresSaver:
    # Keep the checkpoint and the meal-change transaction on the same connection.
    # A rollback restores both the approval interrupt and the business rows.
    return PostgresSaver(db.connection().connection.driver_connection)


def pause(db: Session, run: AgentRun, action: AgentAction) -> None:
    if action.action_type != "replace_meal" or db.get_bind().dialect.driver != "psycopg":
        return
    # One chat can contain later revisions or follow-up runs with their own approval.
    action.checkpoint_thread_id = f"{run.thread_id}:{action.id}"
    state = _graph.compile(checkpointer=_saver(db)).invoke(
        {"action_id": action.id, "payload_hash": action.payload_hash},
        {"configurable": {"thread_id": action.checkpoint_thread_id}},
        durability="sync",
    )
    if not state.get("__interrupt__"):
        raise RuntimeError("Meal approval workflow did not pause")


def resume(db: Session, action: AgentAction, decision: Decision) -> Decision:
    """Resume only after the API has authenticated and locked the pending approval."""
    config = {"configurable": {"thread_id": action.checkpoint_thread_id}}
    workflow = _graph.compile(checkpointer=_saver(db))
    pending = workflow.get_state(config)
    if (pending.next != ("wait_for_approval",)
            or pending.values.get("action_id") != action.id
            or pending.values.get("payload_hash") != action.payload_hash):
        raise ApiError(409, "APPROVAL_CHECKPOINT_MISSING", "这张修改单无法恢复，请重新发起换餐")
    state = workflow.invoke(Command(resume=decision), config, durability="sync")
    if state.get("decision") != decision or state.get("__interrupt__"):
        raise RuntimeError("Meal approval workflow did not resume")
    return state["decision"]
