# Security Policy

## Current state

coldrig is **live in production**: real sending runs for activated tenants, alongside a sandbox for demo tenants. There is no bug bounty program at this stage, but security reports are very welcome — auth, tenant isolation and billing are where a report is most valuable.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.** Instead, email:

**security@coldrig.dev**

Include:

- A description of the issue and its potential impact.
- Steps to reproduce (a minimal repro against the hosted API or this repo's CLI, ideally).
- Whether you believe it affects tenant isolation, auth/token handling, billing, or credential handling — these are the highest-severity classes.

We aim to acknowledge reports within 5 business days; a report affecting tenant isolation or token/auth handling is prioritized above all else.

## Scope

In scope:

- The hosted API and MCP endpoint (`api.coldrig.dev`), the dashboard, and the site (`coldrig.dev`) — e.g. XSS, header misconfiguration.
- This repository's CLI, skills and plugins.
- Anything that could break per-tenant isolation, forge or replay a bearer token, or corrupt billing.

Out of scope:

- Anything requiring physical access, social engineering of EpiphanyMade staff, or denial-of-service.

## Secrets handling

Secrets are never committed to this repository. This repo has no local dev secrets of its own — the CLI takes your bearer token via a flag or an environment variable at runtime, never a checked-in file. If you find a committed secret anywhere in this repo's history, please report it immediately via the address above — that alone is a valid, high-priority report.
