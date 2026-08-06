# Domain Docs

This is a single-context repository.

## Before exploring

Read:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

If a file or directory does not exist, proceed silently. Domain-modeling skills create documents lazily when terminology or architectural decisions are resolved.

## Layout

    /
    ├── CONTEXT.md
    ├── docs/
    │   └── adr/
    └── extensions/

## Use the glossary vocabulary

When naming a domain concept in issues, plans, tests, or code, use the term defined in `CONTEXT.md`. Do not replace terms with synonyms that the glossary explicitly rejects.

If a required concept is missing, reconsider whether the new term is necessary or record the gap for domain modeling.

## ADR conflicts

If proposed work contradicts an existing ADR, identify the conflict explicitly rather than silently overriding the decision.
