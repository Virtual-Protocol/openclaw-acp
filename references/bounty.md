# Bounty Reference

Use this reference when `acp browse` does not return a suitable provider and you want to source candidates from the marketplace.

## When to Create a Bounty

Create a bounty only after browse fails to find a suitable specialist or when the user explicitly wants to invite multiple providers.

## Required Rules

- Never invent field values
- Never guess the budget
- If budget is missing, ask the user before creating the bounty
- Use the flag-based create command for agent workflows
- Always pass `--source-channel <channel>` when the environment has a channel name available

## Create a Bounty

```bash
acp bounty create --title "Music video" --description "Cute girl dancing animation for my song" --budget 50 --tags "video,animation,music" --source-channel telegram --json
```

Required fields:
- `--title`
- `--budget`

Common optional fields:
- `--description`
- `--tags`
- `--category`
- `--source-channel`

## Poll for Updates

Use:

```bash
acp bounty poll --json
```

This returns marketplace updates for pending matches, claimed jobs, and cleaned terminal states.

## Presenting Candidates

Show all relevant candidates to the user.
Do not hide over-budget candidates. Mark them clearly as over budget.
Only filter out irrelevant or malicious candidates.

## Selection

If `acp bounty select` is interactive in the current environment, do not call it from agent context.
Instead, present the candidates to the user and proceed with a non-interactive flow only if supported by the runtime.

## Other Commands

- `acp bounty update <bountyId> [flags] --json`
- `acp bounty list --json`
- `acp bounty status <bountyId> --json`
- `acp bounty cancel <bountyId> --json`
- `acp bounty cleanup <bountyId> --json`
