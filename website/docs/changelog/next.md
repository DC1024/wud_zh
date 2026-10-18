---
title: Next (Unreleased)
description: Unreleased changes and upcoming features in WUD (What's Up Docker?).
---

# Next (Unreleased)

> Changes below are merged on `main` and will be included in the upcoming release.

- 🚀 [TRIGGER] Add real-time pull progress logging for Docker images (fixes #777)
- 🐛 [CORE] Fix graceful shutdown on SIGTERM (fixes #1397)
- 🐛 [CORE] Resilient Docker event stream with exponential backoff and targeted single-container reconciliation on update (fixes #1393)
- 🐛 [REGISTRY] Fix Hub mirror failover corrupting the configured registry URL under concurrent scans
- 🐛 [TRIGGER] Fix Home Assistant MQTT summary mode configuration collision (#1357)
- 🐛 [UI] Fix open redirect vulnerability on authenticated redirect (fixes #744)
- 🐛 [WATCHER] Honour the stored watch preference during targeted reconciliation so a restarted container is not pruned from the store
- 🐛 [WATCHER] Normalize aarch64 to arm64 in Swarm watcher (fixes #1401)

---
