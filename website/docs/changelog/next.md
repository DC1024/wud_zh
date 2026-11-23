---
title: Next (Unreleased)
description: Unreleased changes and upcoming features in WUD (What's Up Docker?).
---

# Next (Unreleased)

> Changes below are merged on `main` and will be included in the upcoming release.

---

- 🐛 [CORE] Move the fork's `watched_containers` migration off upstream's id space (9005) and key applied migrations by name, so an upstream migration can no longer collide with it
- 🐛 [REGISTRY] Fix Hub mirror failover corrupting the configured registry URL under concurrent scans
- 🐛 [REGISTRY] Harden the Hub mirror probe against SSRF: allow only http/https, disable redirect following (`maxRedirects: 0`), pin the resolved IP to defeat DNS-rebinding, and block private/loopback/link-local/CGNAT targets unless `WUD_REGISTRY_MIRROR_ALLOW_PRIVATE` is set
- 🐛 [TRIGGER] Preserve file ownership and permissions when updating Docker Compose files (fixes #1577)
- 🐛 [WATCHER] Honour the stored watch preference during targeted reconciliation so a restarted container is not pruned from the store
- 🐛 [WATCHER] Reconcile store containers when the Docker event stream reconnects (fixes #1575)
