---
title: Next (Unreleased)
description: Unreleased changes and upcoming features in WUD (What's Up Docker?).
---

# Next (Unreleased)

> Changes below are merged on `main` and will be included in the upcoming release.

- 🚀 [TRIGGER] Add real-time pull progress logging for Docker images (fixes #777)
- 🚀 [TRIGGER] Log stdout/stderr on error and expose compose_project in command trigger (fixes #594, fixes #595)
- 🚀 [TRIGGER] Support click URL in Ntfy trigger and expose hostname in batch templates (fixes #660, fixes #725)
- 🚀 [UI] Display and search container metadata in log view (fixes #1419)
- 🐛 [AUTH] Invalidate active sessions when user is deleted
- 🐛 [CORE] Fix graceful shutdown on SIGTERM (fixes #1397)
- 🐛 [CORE] Move the fork's `watched_containers` migration off upstream's id space (9005) and key applied migrations by name, so an upstream migration can no longer collide with it
- 🐛 [CORE] Resilient Docker event stream with exponential backoff and targeted single-container reconciliation on update (fixes #1393)
- 🐛 [REGISTRY] Fix Hub mirror failover corrupting the configured registry URL under concurrent scans
- 🐛 [REGISTRY] Harden the Hub mirror probe against SSRF: allow only http/https, disable redirect following (`maxRedirects: 0`), pin the resolved IP to defeat DNS-rebinding, and block private/loopback/link-local/CGNAT targets unless `WUD_REGISTRY_MIRROR_ALLOW_PRIVATE` is set
- 🐛 [TRIGGER] Apply Docker Compose digest-only updates for floating tags without changing the image reference (fixes #1404)
- 🐛 [TRIGGER] Fix Home Assistant MQTT summary mode configuration collision (#1357)
- 🐛 [TRIGGER] Fix self-update disabled error message to reflect trigger type (fixes #1414)
- 🐛 [TRIGGER] Fix trigger exclude threshold evaluation (fixes #652)
- 🐛 [TRIGGER] Preserve YAML format when updating compose file (fixes #1409)
- 🐛 [TRIGGER] Queue Docker trigger image pulls per registry and retry rate-limited pulls (fixes #1406)
- 🐛 [TRIGGER] Update com.docker.compose.image label to new image ID on container recreation (fixes #1422)
- 🐛 [UI] Fix last grouped item expansion by paginating by group (fixes #1420)
- 🐛 [UI] Fix open redirect vulnerability on authenticated redirect (fixes #744)
- 🐛 [WATCHER] Honour the stored watch preference during targeted reconciliation so a restarted container is not pruned from the store
- 🐛 [WATCHER] Normalize aarch64 to arm64 in Swarm watcher (fixes #1401)
- 📚 [TRIGGER] Document self-update configuration options for Docker Compose trigger (fixes #1414)
- 🚀 [AUTH] Support a configured session secret via `WUD_AUTH_SESSION_SECRET`, while preserving the version and MAC-bound fallback when unset.
- 🚀 [CONTAINER] Add option to override update cooldown and trigger update immediately (fixes #1463)
- 🐛 [E2E] Update expected Home Assistant image version to 2026.10.4 in E2E scenarios
- 🐛 [TRIGGER] Do not copy Docker-generated MAC address when recreating container (#1464)
- 🐛 [WATCHER] Allow tag candidates with different version segment count when wud.tag.include is defined (fixes #1465)
- 🐛 [WATCHER] Index containers created while WUD was stopped during startup reconciliation (fixes #1466)

---
