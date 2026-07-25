"""RFC 7807 "Problem Details for HTTP APIs" support.

https://www.rfc-editor.org/rfc/rfc7807

Every error the API emits — domain rejections raised deep in the geospatial
layer, FastAPI request-validation failures, and unhandled exceptions alike —
is serialised as a problem document with the five RFC 7807 members
(``type``, ``title``, ``status``, ``detail``, ``instance``) and the
``application/problem+json`` content type. Problem-specific extension members
(e.g. ``latitude``/``longitude`` on an on-land rejection, ``errors`` on a
validation failure) are merged into the top-level object, as RFC 7807 §3.2
permits.
"""

from typing import Any, Dict, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_CONTENT_TYPE = "application/problem+json"

# Base URI for the problem type registry. Dereferenceable documentation lives
# under /problems/{slug} in the API docs; per RFC 7807 §3.1 the URI is primarily
# an identifier, so clients must match on it rather than on the human-readable
# title.
PROBLEM_TYPE_BASE = "https://volteo-maritime.example/problems"

# Problem types raised by this service.
TYPE_ON_LAND = "coordinates-on-land"
TYPE_INVALID_COORDINATES = "invalid-coordinates"
TYPE_INVALID_ROUTE = "invalid-route-definition"
TYPE_PORT_NOT_FOUND = "port-not-found"
TYPE_VALIDATION = "request-validation-error"
TYPE_INTERNAL = "internal-server-error"

_DEFAULT_TITLES = {
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    415: "Unsupported Media Type",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
}


def problem_type_uri(slug: str) -> str:
    return f"{PROBLEM_TYPE_BASE}/{slug}"


class ProblemException(Exception):
    """Raise anywhere in the stack to emit an RFC 7807 response.

    Domain modules (``geo_utils``, ``route_checker``, routers) raise this instead
    of ``HTTPException`` so that the problem type, title and extension members
    travel with the error rather than being reconstructed at the edge.
    """

    def __init__(
        self,
        status: int,
        title: str,
        detail: str,
        problem_type: str = "about:blank",
        extensions: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.title = title
        self.detail = detail
        self.problem_type = (
            problem_type
            if problem_type == "about:blank" or "://" in problem_type
            else problem_type_uri(problem_type)
        )
        self.extensions = extensions or {}


def build_problem(
    status: int,
    detail: str,
    instance: str,
    title: Optional[str] = None,
    problem_type: str = "about:blank",
    extensions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble an RFC 7807 problem document as a plain dict."""
    document: Dict[str, Any] = {
        "type": (
            problem_type
            if problem_type == "about:blank" or "://" in problem_type
            else problem_type_uri(problem_type)
        ),
        "title": title or _DEFAULT_TITLES.get(status, "Error"),
        "status": status,
        "detail": detail,
        "instance": instance,
    }
    if extensions:
        document.update(extensions)
    return document


def problem_response(
    status: int,
    detail: str,
    instance: str,
    title: Optional[str] = None,
    problem_type: str = "about:blank",
    extensions: Optional[Dict[str, Any]] = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        media_type=PROBLEM_CONTENT_TYPE,
        content=build_problem(
            status=status,
            detail=detail,
            instance=instance,
            title=title,
            problem_type=problem_type,
            extensions=extensions,
        ),
    )


def on_land_problem(lat: float, lon: float, instance: str) -> ProblemException:
    return ProblemException(
        status=400,
        title="Coordinates are on land",
        detail=(
            f"Coordinates ({lat}, {lon}) are on land. "
            "Please provide valid sea coordinates."
        ),
        problem_type=TYPE_ON_LAND,
        extensions={"latitude": lat, "longitude": lon},
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Install handlers so that *every* error path emits problem+json."""

    @app.exception_handler(ProblemException)
    async def _handle_problem(request: Request, exc: ProblemException) -> JSONResponse:
        return problem_response(
            status=exc.status,
            detail=exc.detail,
            instance=str(request.url.path),
            title=exc.title,
            problem_type=exc.problem_type,
            extensions=exc.extensions,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_exception(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return problem_response(
            status=exc.status_code,
            detail=detail,
            instance=str(request.url.path),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = [
            {
                "field": ".".join(str(part) for part in error.get("loc", [])),
                "message": error.get("msg", "Invalid value"),
                "type": error.get("type", "value_error"),
            }
            for error in exc.errors()
        ]
        first = errors[0]["field"] if errors else "request body"
        return problem_response(
            status=422,
            title="Request validation failed",
            detail=(
                f"The request payload failed validation ({len(errors)} error(s)); "
                f"first offending field: {first}."
            ),
            instance=str(request.url.path),
            problem_type=TYPE_VALIDATION,
            extensions={"errors": errors},
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        # Deliberately does not leak the exception message or traceback to the
        # client; the class name is enough for correlation with server logs.
        return problem_response(
            status=500,
            title="Internal server error",
            detail=(
                "The compliance engine failed to complete the evaluation. "
                "The incident has been logged; please retry or contact support."
            ),
            instance=str(request.url.path),
            problem_type=TYPE_INTERNAL,
            extensions={"exception": type(exc).__name__},
        )
