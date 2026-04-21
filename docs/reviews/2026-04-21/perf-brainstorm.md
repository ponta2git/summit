# Performance Review Findings (brainstorm) — perf-brainstorm (gpt-5.4)

(content saved from perf-brainstorm agent output; 22 sub-viewpoints covering Discord ack, cron tick budget, DB query efficiency, N+1, transaction scope, Neon pooler, cold boot/recovery, Fly rolling deploy/migrate latency, memory leaks, discord.js cache, Discord API call redundancy, logger overhead, healthcheck ping, shutdown latency, timeout consistency, retry/backoff, zod parse cost, neverthrow allocation, build artifact, test suite latency, member reconcile cost, reminder claim stuck edge)

Key priorities (High): 3s ack / cron tick budget / DB query efficiency / N+1 / Neon pooler / cold boot recovery / memory leaks / discord.js cache / timeout consistency / reminder stuck.

ROI note: individual-scale bot. Prefer wall-clock + query count measurement; avoid OTel/APM. Short-term measurement hooks only; never leave measurement code in hot path.
