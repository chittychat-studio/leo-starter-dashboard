<!-- governor:start (generated; edit governance.yaml and re-render) -->
# Governor rules for Codex (tier 3)

## Enforced rules
- none

## Advisory rules
- P6-secret-read: Do not read secret files (.env*, private keys, cloud credentials).
- P6-rm-rf: Recursive force delete is blocked.
- P6-force-push: Force push is blocked.
- P6-prod-deploy: Production deploy and infrastructure apply commands need human approval.
- P8-paid-cli: Commands that call paid AI APIs need human approval.
- P9-guardrail-self-edit: The agent cannot change its own guardrails (.claude/settings*.json, .claude/hooks/, governance.yaml, Governor state) or run Governor's exception tools.
- P7-obfuscated-exec: Encoded or downloaded commands piped into a shell are blocked (they hide what runs).
- P9-db-dump: Database dump commands need human approval.
- P9-destructive-migration: Destructive schema changes need human approval.
- P9-no-pii-in-logs: Never log request bodies or personal-data fields, and never put real personal data in fixtures.
- P10-dependency-add: Adding or installing dependencies needs human approval.
- P10-env-dump: Dumping the environment (env, printenv, set) needs human approval.
- P10-synthetic-fixtures: Fixtures use provider test tokens and synthetic records only; never real card, health or personal records.
- P11-supabase-rls: Keep Row Level Security on for every Supabase table, and never use the Supabase service-role key in browser code.

## Disabled rules
- none

## Commands
- Tests: none recorded yet (test_cmd: none), so the Stop-hook test gate is inactive (I1c). Do not add placeholder tests to satisfy it.

## Working agreement (advisory)
- Keep replies short and on the goal the user stated. Read and run only what the task needs; every extra file and re-run spends the user's token budget.
- If the request is unclear, or a step would hit a rule above that blocks or asks, stop and ask the user one short question first. Never look for another way round a blocked action.
- Before saying you are done, check the work against the rules above and the Commands line, and say which you checked and which you could not.
- Thank you. Careful work that stays inside these rules is noticed and appreciated.

These are instructions. Governor installs no hooks or permission rules for Codex, so none of them is enforced for Codex.
<!-- governor:end -->
