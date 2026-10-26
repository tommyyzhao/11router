#!/usr/bin/env python3
"""Source-only Claude Code PreToolUse syntax guard; nothing installed/configured.

Intended command hook matcher: TaskStop; JSON arrives on stdin. Manual config
example only (not installed; replace the path before any authorized setup):
{"hooks":{"PreToolUse":[{"matcher":"TaskStop","hooks":[{"type":"command",
 "command":"python3 -I /absolute/path/to/claude-taskstop-guard.py"}]}]}}
No shell interpolation of hook input. Hook protocol documentation:
https://code.claude.com/docs/en/hooks#pretooluse-decision-control
Allow emits {}; deny emits this documented JSON shape (both exit 0):
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
 "permissionDecision": "deny", "permissionDecisionReason": "..."}}

Syntax only: ASCII letters/digits/underscore/hyphen, 1..256 characters. Native
ID ceiling is unverified (Agent names have a 64-character ceiling); 256 is a
local generous bound, not a claimed native limit. No lookup/ownership check.
A plausible bogus handle such as a86d2aca3499aac34_20261024realPLEASESTOPNOW
passes syntax; native exact lookup remains authoritative. This mitigates, not
fully prevents, cancellation loops. Never trims, guesses, rewrites, relaunches,
stops tasks, changes permissions, reads settings, or calls models/services.

Self-check: python3 -I scripts/claude-taskstop-guard.py --self-test
"""

import io
import json
import re
import sys

MAX_INPUT_BYTES = 64 * 1024
# ponytail: syntax-only 256-character ceiling; native lookup validates handles.
HANDLE = re.compile(r"[A-Za-z0-9_-]{1,256}")
REASON = (
    "TaskStop syntax denied. Use the exact returned task ID or Agent name; "
    "do not trim, guess, or relaunch."
)


def deny():
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": REASON,
    }}


def reject_constant(_value):
    raise ValueError("Invalid JSON constant")


def guard(stream):
    try:
        raw = stream.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            return deny()
        event = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
    except (OSError, UnicodeError, ValueError, RecursionError):
        return deny()
    if not isinstance(event, dict):
        return deny()
    if event.get("tool_name") != "TaskStop":
        return {}
    args = event.get("tool_input")
    if not isinstance(args, dict):
        return deny()
    handles = [args[key] for key in ("task_id", "shell_id") if key in args]
    if not handles or any(
        not isinstance(handle, str) or HANDLE.fullmatch(handle) is None
        for handle in handles
    ):
        return deny()
    if len(handles) == 2 and handles[0] != handles[1]:
        return deny()
    return {}


def self_test():
    def check(event):
        return guard(io.BytesIO(json.dumps(event).encode("utf-8")))

    def stop(args):
        return check({"tool_name": "TaskStop", "tool_input": args})

    for handle in (
        "a86d2aca3499aac34", "b123456", "worker", "sol-fix-review",
        "worker_2", "A-Z_09", "x" * 64, "x" * 65, "x" * 256,
        "a86d2aca3499aac34_20261024realPLEASESTOPNOW",
    ):
        assert stop({"task_id": handle}) == {}
        assert stop({"shell_id": handle}) == {}
        assert stop({"task_id": handle, "shell_id": handle}) == {}
    for handle in (
        "", " worker", "worker ", "work er", "worker\n", "work\ter",
        "work\rer", "work\x00er", "work\x1fer", "work\x7fer", "wörker",
        "工人", "worker ", "worker​", "worker.please-stop!",
        "worker: stop", "worker/2", "worker [abc123]", "worker;stop",
        "a86d2aca3499aac34_" + "x" * 1000, "x" * 257,
        None, 123, True, [], {},
    ):
        assert stop({"task_id": handle}) == deny()
        assert stop({"shell_id": handle}) == deny()
        assert stop({"task_id": "worker", "shell_id": handle}) == deny()
    assert stop({"task_id": "worker", "shell_id": "other"}) == deny()
    for args in ({}, None, [], "worker"):
        assert stop(args) == deny()
    assert check({"tool_name": "TaskStop"}) == deny()
    assert check({"tool_name": "Read", "tool_input": {"task_id": "bad id!"}}) == {}
    assert check({"tool_name": "Agent", "tool_input": None}) == {}
    for raw in (
        b"", b"{", b"null", b"[]", b"\xff", b'{"tool_name": NaN}',
        b'{"tool_name": Infinity}', b'{"tool_name":"TaskStop"} trailing',
        b"[" * 2000 + b"]" * 2000,
        b" " * (MAX_INPUT_BYTES + 1),
        b'{"tool_name":"Read"}' + b" " * MAX_INPUT_BYTES,
    ):
        assert guard(io.BytesIO(raw)) == deny()
    boundary = b'{"tool_name":"Read"}'
    assert guard(io.BytesIO(boundary + b" " * (MAX_INPUT_BYTES - len(boundary)))) == {}
    secret = "DO_NOT_ECHO_SECRET!"
    result = stop({"task_id": secret})
    assert result == deny() and secret not in json.dumps(result)
    assert "updatedInput" not in json.dumps(result)
    assert set(result) == {"hookSpecificOutput"}
    print("self-test: passed")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        json.dump(guard(sys.stdin.buffer), sys.stdout)
        sys.stdout.write("\n")
