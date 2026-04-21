# Security Review Findings (brainstorm) — sec-brainstorm (gpt-5.3-codex)

24 sub-viewpoints: secrets handling (commit leak), Fly/CI token mgmt, log redaction, interaction payload over-logging, interaction trust boundary (cheap-first), reject message info leak, custom_id tamper (HMAC rejected / DB re-fetch defense), unknown/stale custom_id no-op, SQL injection (sql.raw / dynamic ORDER BY), env validation, interaction/DB-row narrowing, authn/authz (MEMBER_USER_IDS fail-closed), Discord minimum privilege, DB role separation, migration push-prohibited + drift detection, supply chain (dependabot/lockfile), CI workflow hardening, deploy token revoke/rotate, healthcheck URL misuse, output encoding / mention injection, DoS/rate-limit resilience, ops guard (deploy window/production destructive ops), prompt injection (AI agent), PII/IR runbook.

Threat model: in-scope = misops/secret leak/non-member interaction/tamper/supply chain/ops accident; out-of-scope = enterprise DDoS/WAF/IAM.
Approach order: static audit (grep/config) → code-path review → ops procedure review. Standardize findings with reproduction command / impact / fix / priority.
