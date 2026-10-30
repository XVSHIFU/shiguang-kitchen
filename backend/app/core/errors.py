"""Envelope + ApiError. All responses follow the API_CONTRACT envelope."""
import uuid

from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def ok(data, status: int = 200):
    return JSONResponse(
        status_code=status,
        content={"data": data, "error": None, "request_id": str(uuid.uuid4())},
    )


def fail(status: int, code: str, message: str, details: dict | None = None):
    return JSONResponse(
        status_code=status,
        content={
            "data": None,
            "error": {"code": code, "message": message, "details": details or {}},
            "request_id": str(uuid.uuid4()),
        },
    )


async def api_error_handler(request: Request, exc: ApiError):
    return fail(exc.status, exc.code, exc.message, exc.details)
