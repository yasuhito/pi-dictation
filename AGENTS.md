# Repository guidelines

## Tests

- Each test case or named subtest must contain at most one assertion.
- When a scenario has multiple observable outcomes, share the scenario setup in a parent test and give each outcome its own clearly named subtest.

## Compatibility

- Backward compatibility is not a project constraint. Prefer the cleanest current interface and configuration, even when this requires existing users to migrate.

## macOS verification

- For issues requiring macOS validation, use `ssh mac` and perform every automatable setup, build, test, and diagnostic step on the Mac yourself.
- Ask the human only for actions that require physical presence or macOS UI interaction, such as speaking into the microphone or granting permission. Give the exact action and wait condition when requesting it.

## Documentation translations

- `README.md` is the authoritative README.
- Whenever `README.md` changes, update `README.ja.md` in the same change so both versions remain semantically aligned.
- Keep commands, configuration examples, links, and support boundaries aligned across both versions. Translate prose idiomatically rather than sentence by sentence.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
