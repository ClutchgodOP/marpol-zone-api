import pytest
from fastapi.testclient import TestClient

from app.main import app

PROBLEM_CONTENT_TYPE = "application/problem+json"


@pytest.fixture(scope="session")
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(scope="session")
def tolerant_client() -> TestClient:
    """Client that lets the app's 500 handler run instead of re-raising the
    exception into the test, so the problem+json body can be asserted."""
    return TestClient(app, raise_server_exceptions=False)


def assert_problem(response, status: int, type_suffix: str = None):
    """Assert an RFC 7807 problem document: content type, the five required
    members, and (optionally) the problem type slug."""
    assert response.status_code == status
    assert response.headers["content-type"].startswith(PROBLEM_CONTENT_TYPE)

    problem = response.json()
    for member in ("type", "title", "status", "detail", "instance"):
        assert member in problem, f"RFC 7807 member '{member}' missing from {problem}"

    assert problem["status"] == status
    assert isinstance(problem["title"], str) and problem["title"]
    assert isinstance(problem["detail"], str) and problem["detail"]
    assert problem["instance"].startswith("/")

    if type_suffix is not None:
        assert problem["type"].endswith(type_suffix), problem["type"]

    return problem
