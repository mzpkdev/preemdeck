"""API tests — the HTTP layer over the frozen room core.

Drives create_app() through FastAPI's TestClient: the ungated probes, the
one-status-401 contract (three distinct bodies), the jackin -> send -> recv
loop, jackout, and the heartbeat. recv tests use wait=0 to stay fast — the
parked-wake concurrency is already proven at the unit layer (test_room.py).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from wire.app import create_app
from wire.config import Config

SECRET = "s3cret"
TOPIC = "test room"


@pytest.fixture
def client() -> TestClient:
    app = create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC))
    return TestClient(app)


# -- ungated probes -------------------------------------------------------


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_schema_is_openapi(client: TestClient):
    r = client.get("/schema")
    assert r.status_code == 200
    doc = r.json()
    assert doc["openapi"].startswith("3.")
    assert "/jackin" in doc["paths"]
    assert "/recv" in doc["paths"]


# -- /shard (markdown, self-checked secret) -------------------------------


def test_shard_wrong_secret_401_markdown(client: TestClient):
    r = client.get("/shard", params={"secret": "wrong"})
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.text == "You are not authorized to view this resource, your secret is invalid."


def test_shard_missing_secret_401_markdown(client: TestClient):
    r = client.get("/shard")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/markdown")


def test_shard_correct_secret_200_markdown(client: TestClient):
    r = client.get("/shard", params={"secret": SECRET})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.text.startswith("# WIRE")


# -- /jackin secret gate --------------------------------------------------


def test_jackin_wrong_secret_401(client: TestClient):
    r = client.post("/jackin", params={"secret": "wrong"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid secret"}


def test_jackin_missing_secret_401(client: TestClient):
    r = client.post("/jackin")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid secret"}


def test_jackin_correct_secret_200(client: TestClient):
    r = client.post("/jackin", params={"secret": SECRET})
    assert r.status_code == 200
    body = r.json()
    token = body["token"]
    assert token
    assert body["conversation_topic"] == TOPIC
    assert body["peers"] == ["peer-1"]
    # actions: send (POST, with body) + recv (GET); URLs carry the real token
    actions = body["actions"]
    assert len(actions) == 2
    send_action, recv_action = actions
    assert send_action["method"] == "POST"
    assert send_action["url"].endswith(f"/send?token={token}")
    assert send_action["body"] == "<message>"
    assert recv_action["method"] == "GET"
    assert recv_action["url"].endswith(f"/recv?token={token}")


# -- optional self-naming at /jackin --------------------------------------


def test_jackin_with_name_is_assigned(client: TestClient):
    r = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
    assert r.status_code == 200
    body = r.json()
    assert body["you_are"] == "alice"
    assert body["peers"] == ["alice"]


def test_jackin_taken_name_falls_back_to_peer_n(client: TestClient):
    first = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
    assert first.json()["you_are"] == "alice"
    second = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
    assert second.status_code == 200
    you_are = second.json()["you_are"]
    assert you_are.startswith("peer-")
    assert you_are == "peer-2"


def test_jackin_no_name_gives_peer_n(client: TestClient):
    r = client.post("/jackin", params={"secret": SECRET})
    assert r.status_code == 200
    assert r.json()["you_are"] == "peer-1"


def test_jackin_name_requires_secret(client: TestClient):
    # the name param does not bypass the secret gate — 401 contract untouched
    r = client.post("/jackin", params={"name": "alice"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid secret"}


def test_schema_documents_jackin_name_param(client: TestClient):
    doc = client.get("/schema").json()
    params = doc["paths"]["/jackin"]["post"].get("parameters", [])
    name = next((p for p in params if p["name"] == "name" and p["in"] == "query"), None)
    assert name is not None, "name query param missing on /jackin"
    assert name.get("required", False) is False  # optional
    assert "peer-N" in name.get("description", "")


# -- one-401 contract: token endpoints with a bogus token -----------------


def test_recv_bogus_token_401(client: TestClient):
    r = client.get("/recv", params={"token": "nope"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token"}


def test_send_bogus_token_401(client: TestClient):
    r = client.post("/send", params={"token": "nope"}, content=b"hi")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token"}


def test_jackout_bogus_token_401(client: TestClient):
    r = client.post("/jackout", params={"token": "nope"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token"}


def test_recv_missing_token_401(client: TestClient):
    r = client.get("/recv")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token"}


# -- guardrail: a MISSING credential must 401, never FastAPI's auto-422.
# The doc marks secret/token required, but the signatures stay optional so the
# handler sees None and returns 401. These pin that the params did NOT become
# required Query(...) params (which would auto-422 a missing one).


def test_send_missing_token_401_not_422(client: TestClient):
    r = client.post("/send", content=b"hi")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token"}


def test_jackout_missing_token_401_not_422(client: TestClient):
    r = client.post("/jackout")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token"}


# -- the loop: jackin x2, send, recv --------------------------------------


def _jackin(client: TestClient) -> str:
    r = client.post("/jackin", params={"secret": SECRET})
    assert r.status_code == 200
    return r.json()["token"]


def test_send_recv_loop(client: TestClient):
    # /jackin tells each joiner its own seat via you_are, in join order
    r1 = client.post("/jackin", params={"secret": SECRET})
    assert r1.json()["you_are"] == "peer-1"
    t1 = r1.json()["token"]
    r2 = client.post("/jackin", params={"secret": SECRET})
    assert r2.json()["you_are"] == "peer-2"
    t2 = r2.json()["token"]

    # peer-1 sends a raw-text message -> seq 1
    r = client.post("/send", params={"token": t1}, content=b"hello peer-2")
    assert r.status_code == 200
    assert r.json() == {"seq": 1}

    # peer-2 reads it (non-blocking wait=0)
    r = client.get("/recv", params={"token": t2, "wait": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["unread"][0] == {"seq": 1, "from": "peer-1", "message": "hello peer-2"}
    assert set(body["peers"]) == {"peer-1", "peer-2"}
    # peer-2 just read peer-1's last message, but that's reported to the SENDER:
    # peer-2 itself hasn't sent anything, so its own read_your_last_message is empty
    assert body["read_your_last_message"] == []

    # peer-1 polls: it must NOT see its own message echoed back (no-echo),
    # but peer-2 has now read peer-1's last message.
    r = client.get("/recv", params={"token": t1, "wait": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["unread"] == []
    assert body["read_your_last_message"] == ["peer-2"]


# -- jackout retires the token --------------------------------------------


def test_jackout_then_dead_token(client: TestClient):
    t1 = _jackin(client)  # peer-1
    t2 = _jackin(client)  # peer-2

    r = client.post("/jackout", params={"token": t2})
    assert r.status_code == 200
    assert r.json() == {"left": "peer-2"}

    # reusing the retired token -> the distinct "dead" body, instantly (no hang)
    for method, path in (("get", "/recv"), ("post", "/send"), ("post", "/jackout")):
        resp = getattr(client, method)(path, params={"token": t2})
        assert resp.status_code == 401
        assert resp.json() == {"detail": "token no longer valid, jackin again"}


# -- heartbeat ------------------------------------------------------------


def test_heartbeat_empty_unread(client: TestClient):
    t1 = _jackin(client)
    r = client.get("/recv", params={"token": t1, "wait": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["unread"] == []
    assert body["peers"] == ["peer-1"]
    assert body["read_your_last_message"] == []


# -- /schema is honest and self-explaining --------------------------------


def test_schema_documents_send_body(client: TestClient):
    doc = client.get("/schema").json()
    rb = doc["paths"]["/send"]["post"]["requestBody"]
    assert rb["required"] is True
    assert "text/plain" in rb["content"]
    assert rb["content"]["text/plain"]["schema"]["type"] == "string"
    assert "@peer" in rb["description"]


def test_schema_marks_credentials_required(client: TestClient):
    doc = client.get("/schema").json()
    paths = doc["paths"]

    def required(path: str, method: str, name: str) -> bool:
        for p in paths[path][method].get("parameters", []):
            if p["name"] == name and p["in"] == "query":
                return p.get("required", False)
        raise AssertionError(f"{name} param missing on {method} {path}")

    assert required("/jackin", "post", "secret")
    assert required("/shard", "get", "secret")
    assert required("/send", "post", "token")
    assert required("/recv", "get", "token")
    assert required("/jackout", "post", "token")


def test_schema_gated_routes_document_401(client: TestClient):
    doc = client.get("/schema").json()
    paths = doc["paths"]
    for path, method in (
        ("/shard", "get"),
        ("/jackin", "post"),
        ("/send", "post"),
        ("/recv", "get"),
        ("/jackout", "post"),
    ):
        assert "401" in paths[path][method]["responses"]


def test_schema_carries_descriptions(client: TestClient):
    doc = client.get("/schema").json()
    paths = doc["paths"]
    # every route has a description
    for path, method in (
        ("/health", "get"),
        ("/shard", "get"),
        ("/jackin", "post"),
        ("/jackout", "post"),
        ("/send", "post"),
        ("/recv", "get"),
    ):
        assert paths[path][method].get("description")
    # the wait param is described
    wait = next(p for p in paths["/recv"]["get"]["parameters"] if p["name"] == "wait")
    assert wait.get("description")
    # response fields are described, incl. the semantics-bearing one
    schemas = doc["components"]["schemas"]
    assert schemas["JackinResponse"]["properties"]["you_are"].get("description")
    assert schemas["MessageOut"]["properties"]["from"].get("description")
    rylm = schemas["RecvResponse"]["properties"]["read_your_last_message"]["description"]
    assert "read-cursor" in rylm and "receipt" in rylm
