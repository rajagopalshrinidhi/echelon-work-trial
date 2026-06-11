# SKILLS.md

Reference these skills when working on the corresponding parts of the
project. Each skill encodes a specific, non-obvious pattern — read it
before implementing the related component, not after something breaks.

## skill: slack-signature-verification

When: implementing the gateway's inbound request handler.

- Read raw request body BEFORE calling `request.json()`. The HMAC is
  computed over raw bytes; once the body stream is consumed for JSON
  parsing, you cannot recompute the signature correctly.
- Reject if `|now - X-Slack-Request-Timestamp| > 300` seconds (replay
  guard) BEFORE computing HMAC — cheaper check, fail fast.
- Use `hmac.compare_digest()` for the signature comparison. Never `==`.
- Return bare `403` on any verification failure — no error detail in the
  response body that could help an attacker.

## skill: llm-intent-extraction

When: implementing the natural language → structured command parser.

- System prompt must include: allowed command list, full argument schema
  with `Literal` types, 3-4 few-shot examples covering edge cases
  (ambiguous input, out-of-scope request), and explicit instruction to
  return ONLY JSON with no markdown fences or preamble.
- Output Pydantic model always includes `confidence: float` (0.0-1.0).
  Confidence < 0.6 → do not proceed to RBAC/execution; return a
  clarification message to the user instead.
- Run the injection screen (see skill below) on raw input BEFORE this
  step — never send unscreened input to the LLM.
- One LLM call per request. If you find yourself wanting multiple calls
  or tool-use loops, that's the MCP agent pattern, not this one — confirm
  with the user before switching architectures mid-project.

## skill: prompt-injection-screen

When: implementing the first gate in the gateway pipeline, before
tokenization or any LLM call.

- Pure regex/string matching — zero LLM involvement. Patterns to check:
  "ignore previous instructions", "disregard", "you are now", "system
  prompt", "new instructions", "reveal your prompt".
- Enforce a length cap (e.g. 500 chars) on raw input before it reaches
  the LLM.
- On match: reject with a generic message, log the attempt with
  `trace_id` and `slack_user_id`, do not echo the offending text back.

## skill: cli-subprocess-execution

When: implementing the executor's CLI invocation.

- `subprocess.run(cmd_list, shell=False, timeout=30, capture_output=True,
  text=True)` — `cmd_list` is always a list built from validated Pydantic
  fields, never a formatted string.
- Cap captured stdout — if `len(result.stdout) > 10_000_000`, truncate and
  flag in the response rather than passing the full output downstream.
- Set `env` explicitly: base env + STS credentials
  (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`),
  and explicitly clear `AWS_PROFILE` so the CLI cannot fall back to
  broader executor credentials.
- On non-zero exit code, capture both stdout and stderr in the structured
  log — don't discard stderr.

## skill: jwt-claims-and-sts

When: implementing the auth service's JWT minting and the executor's
STS AssumeRole call.

- JWT signed with RS256 (asymmetric). Auth service holds private key;
  executor holds only public key. Never use HS256 for this — a
  compromised executor must not be able to mint its own tokens.
- Required claims: `iss`, `sub` (slack_user_id), `iat`, `exp` (15 min TTL),
  `jti`, `team_id`, `channel_id`, `role`, `iam_role_arn`,
  `allowed_commands`, `trace_id`, `job_id`, `command`, `args`.
- Executor verification order: signature → expiry → `jti` not in revoked
  set (Redis) → `command in allowed_commands` (belt-and-suspenders check
  even though auth service already verified this).
- STS AssumeRole session tags: `SlackUserId`, `SlackTeamId`,
  `SlackChannel`, `SlackRole`, `TraceId`, `JobId` — sourced directly from
  JWT claims, nothing invented at the executor.

## skill: structured-logging

When: writing any log statement anywhere in the codebase.

- Every log line is a JSON object via the standard `logging` module with
  a JSON formatter — never an f-string passed to `logger.info()`.
- Minimum fields: `timestamp`, `level`, `event`, `trace_id`. Add
  `slack_user_id`, `command`, `duration_ms`, `exit_code` where relevant.
- `event` values are snake_case and stable across the codebase
  (`slack_event_received`, `auth_verified`, `intent_parsed`,
  `rbac_denied`, `cli_invoked`, `excel_formatted`, `slack_delivered`) —
  these double as span names if OpenTelemetry is added later.

## skill: excel-output-formatting

When: implementing the formatter that converts CLI stdout to Excel.

- Define an explicit output schema per command type (column names, types,
  ordering) — do not dump raw stdout into a single cell.
- Validate the formatted workbook (correct sheet name, header row present,
  no empty workbook) before handing off to Slack upload — fail loudly if
  the CLI output didn't match the expected shape, rather than uploading a
  broken file.
- Keep formatter logic separate from execution logic — the formatter
  should be unit-testable with a fixture stdout string and no subprocess
  involved.

## skill: testing-with-moto

When: writing tests for anything that touches AWS (STS, SQS, DynamoDB).

- Use `moto` decorators (`@mock_aws`) — never real AWS credentials in
  tests, never `pytest.mark.skip` for AWS-dependent tests.
- For STS AssumeRole tests, assert the session tags passed match the JWT
  claims exactly — this is the audit chain, test it explicitly.
- For SQS tests, assert message structure (required fields present) not
  just "message was sent". 