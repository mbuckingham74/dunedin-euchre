# Security Scanning

This repository uses a repo-local Trivy workflow to fail on `HIGH` and `CRITICAL` findings in both source/config and the built Docker image.

## Local Usage

Run the full scan:

```bash
npm run security:scan
```

Run only the filesystem/config scan:

```bash
npm run security:scan:fs
```

Run only the Docker image scan:

```bash
npm run security:scan:image
```

The scanner runs `ghcr.io/aquasecurity/trivy:latest` in Docker, scans the repository with Trivy `fs`, then builds and scans a local image tagged `dunedin-euchre:trivy-scan`.

## What Gets Scanned

- Repository dependencies and checked-in config via Trivy filesystem scanning
- Docker image vulnerabilities and image-level misconfiguration via Trivy image scanning

To reduce noise, the filesystem scan skips runtime and generated artifacts such as `node_modules/`, `data/`, `uploads/`, `logs/`, and local SQLite database files.

## CI Behavior

GitHub Actions runs on pull requests and pushes to `main`. The workflow installs dependencies, runs `npm test`, then runs the same `npm run security:scan` command used locally.

Any `HIGH` or `CRITICAL` finding causes the script and CI job to exit non-zero.

## Exceptions

No suppressions are configured by default.

If a future finding needs to be suppressed, add a `.trivyignore` entry only when there is a documented reason, an owner, and a planned removal date. Keep the suppression as narrow as possible and update this file with the rationale for each entry.
