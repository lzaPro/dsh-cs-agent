---
name: cte-rancher-support
description: Diagnose CTE customer, usage, billing, and OpenClaw incidents by logging into Grafana Explore through the browser tool to run a focused read-only SQL query directly, interpreting the results, then continuing with Rancher/Kubernetes workload checks and sanitized logs. Use when support starts from a phone number, email, organization, pool ID, pod, or deployment; keep database and cluster access read-only unless an exact remediation is explicitly authorized.
---

# CTE Rancher Support

Route CTE support investigations through the minimum required data source: resolve customer and business context with a Grafana SQL query that the Agent runs itself via the browser tool, then use Rancher/Kubernetes only when a workload investigation is needed. Begin read-only and keep identifiers, time zones, cluster targets, and time windows explicit.

## Grafana browser query protocol

The Agent logs into Grafana itself using `mcp__sophcode_browser__*` tools and a dedicated read-only account configured by the operator via environment variables (see [references/setup.md](references/setup.md)). The Grafana base URL is fixed:

- Base URL: `http://grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com`
- `CTE_GRAFANA_USERNAME` — read-only account username or email
- `CTE_GRAFANA_PASSWORD` — read-only account password

Steps:

1. Pick exactly one focused template from [references/grafana-query-cookbook.md](references/grafana-query-cookbook.md). Validate the identifier (11-digit phone, single email, numeric org/pool ID, `YYYY-MM-DD HH:MM:SS` UTC bounds) and fill it in.
2. If not already logged in, navigate to `http://grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com/login`. The controlled browser is agent-driven — the operator cannot type into it, so the Agent must fill the form itself. If `CTE_GRAFANA_USERNAME`/`CTE_GRAFANA_PASSWORD` are absent from the shell session, read them from the OS user-level store (on Windows: `[Environment]::GetEnvironmentVariable('<NAME>', 'User')` via `powershell.exe`). Reading the password value into the local tool-call transcript is unavoidable for form filling — obtain the operator's approval before reading it, then `type` the username into the email/username field and the password into the password field, and click the login button. Never repeat the password value in responses, reports, or files. Take a `snapshot` afterward to confirm the login page is gone and no error banner is shown. If login fails, stop and tell the operator to check `CTE_GRAFANA_USERNAME`/`CTE_GRAFANA_PASSWORD`; do not retry more than once.
3. Navigate to `http://grafana-cn-c6k4gh5ju01-vpc.grafana.aliyuncs.com/explore`, select from the picker the exact data source named in the template (e.g. `prod_mysql`, not the similarly named `app_prod_mysql`), and switch the query editor to Code/SQL mode. The SQL editor is Monaco and silently ignores `type` into its textarea; set the single validated `SELECT` via `evaluate` instead: `window.monaco.editor.getEditors()[0].setValue('<sql>')`. Run the query, then use `snapshot` to read the result table.
4. Interpret only the returned rows: total row count, distinct non-null `moltbot_service_pool_id` values, per-row subscription status. Map the target Pool ID to the `moltbot-<pool-id>-` prefix and continue with the read-only Rancher workflow.
5. Never start a Rancher search from a guessed or remembered Pool ID. A valid Pool ID comes only from the ticket itself or from a query result run for this ticket. Historical log files, previous tickets, and memory are not valid sources.
6. "No data" is not the same as zero rows. First confirm the query actually registered — the editor holds the SQL and the Explore URL contains a non-empty `rawSql` — otherwise the editor lost the statement and no query ran. On genuine zero rows, re-verify the identifier and data source once, then report not found. Do not iterate through guessed identities.
7. Never paste the query result screenshot or raw page content anywhere except your interpretation in this conversation; do not save Grafana session cookies or credentials to disk.

Skip this protocol entirely when the ticket already provides a pool ID, pod, or Deployment name.

## First use

Before accessing a cluster or Grafana, read and follow [references/setup.md](references/setup.md), which walks the operator through configuring the `CTE_GRAFANA_USERNAME`/`CTE_GRAFANA_PASSWORD` environment variables. Never copy another operator's kubeconfig, browser session, token, or credentials. If access is already configured, validate it without changing the active context.

Environment routing hints are in [references/local-environment.md](references/local-environment.md). Treat them as hints and verify data sources, placement, and RBAC at runtime.

## Inputs and scope

Start from a phone number, email, organization ID, OpenClaw pool ID (normally matching `moltbot-<pool-id>-`), exact pod, or Deployment.

- For Bot, organization, collaboration, consumption, API-key attribution, or settlement questions, read [references/grafana-query-cookbook.md](references/grafana-query-cookbook.md) and choose one focused template, then run it per the Grafana browser query protocol above.
- If Rancher diagnosis is needed, resolve the pool ID first (via the browser query protocol or from the ticket itself), then continue with the read-only workflow below.
- Do not run every query in the cookbook. Select only the query and columns required by the request.
- For service-unavailable, configuration, storage, scale-to-zero, missing-history, or balance incidents, read [references/support-workflows.md](references/support-workflows.md) and follow the matching playbook.

## Safety boundary

- Start read-only: context discovery, `auth can-i`, pod/deployment metadata, events, EndpointSlices, metrics, and logs.
- Grafana queries must be a single focused `SELECT`. Validate identifiers and time bounds before composing the query; the Agent runs it in Explore using the read-only account from `CTE_GRAFANA_USERNAME`/`CTE_GRAFANA_PASSWORD`, never a personal or admin account. Never compose queries that select credential values, tokens, Secret columns, or `SELECT *` from sensitive tables. Never print, log, or echo the Grafana password.
- A phone number, email, IP address, usage record, billing amount, API-key metadata, or customer name is sensitive. Include it in a query only when the ticket already contains that identifier for this investigation. Do not transmit it anywhere else.
- Never read Kubernetes Secrets or print tokens, passwords, cookies, authorization headers, kubeconfig contents, or complete environment-variable values.
- Do not patch or scale workloads, delete or restart pods, exec into containers, change contexts, or persist credentials unless the user explicitly authorizes that exact remediation after seeing its impact and rollback.
- Treat `pods/exec`, customer filenames, and unauthenticated file services as sensitive. Use exec only when the requester explicitly asks for an in-container inspection or action; inspect metadata and sizes instead of file contents unless contents are necessary and separately authorized.
- Preserve TLS verification. Do not bypass certificate warnings or use insecure TLS flags.
- For destructive work, resolve the exact cluster, namespace, pod, PVC, and path first. Never delete a PVC/PV or customer data as a shortcut for workload recovery.

## Read-only workflow

1. Verify the named context and namespace without changing the current context:

   ```powershell
   kubectl config get-contexts
   kubectl --context <context> auth can-i get pods -n <namespace>
   kubectl --context <context> auth can-i get pods/log -n <namespace>
   ```

2. Locate matching pods by exact name or `moltbot-<pool-id>-` prefix. Prefer the newest Running pod; record readiness, creation time, node, restart count, container names, and current/last container state. Resolve the owning Deployment through `metadata.ownerReferences` (Pod → ReplicaSet → Deployment, normally named `moltbot-<pool-id>` without the ReplicaSet hash suffix) instead of guessing the name.
3. Collect a bounded window, starting with 60 minutes unless specified otherwise. On Windows use `scripts/Collect-RancherLogs.ps1`; on Linux/macOS use `scripts/collect-rancher-logs.sh`. Both write sanitized UTF-8 logs.
4. When a container restarted, collect both current and `--previous` logs. Inspect warning events, Deployment availability, and metrics when available.
5. For page, SSH, SFTP, or file-service failures, inspect the Service, EndpointSlice, and Ingress host/port mappings and compare them with the expected endpoint host. Never print an embedded gateway token or URL query string.
6. Correlate timestamps and at least two signals before stating a root cause. Read [references/error-patterns.md](references/error-patterns.md) for lock, compaction, timeout, memory, disk, authentication, or stalled-session symptoms.
7. Separate observed facts, inferences, missing evidence, remediation options, and user-facing guidance. Internal details such as pod failure or redeployment are not automatically appropriate customer-facing text. State impact and rollback before requesting authorization for a mutation.

Do not dump a complete Deployment or Pod specification merely to diagnose an issue because environment values may be sensitive. Select only required fields with `jsonpath` or `custom-columns`.

## Cross-platform log collection

Windows PowerShell:

```powershell
& scripts/Collect-RancherLogs.ps1 `
  -Context sophnet-openclaw-prod `
  -Namespace openclaw3 `
  -MoltbotId 19860 `
  -SinceMinutes 60
```

Use `-PodName` instead of `-MoltbotId` when the exact pod is known. Add `-Container` for multi-container pods and `-Previous` only after confirming a restart. Review sanitized logs before sharing them outside the support team.

Linux/macOS Bash:

```bash
./scripts/collect-rancher-logs.sh \
  --context sophnet-openclaw-prod \
  --namespace openclaw3 \
  --moltbot-id 19860 \
  --since-minutes 60
```

Use `--pod-name`, `--container`, and `--previous` for the equivalent Bash options.

## Reporting

Report the exact target and time window; health, readiness, restarts, resource usage, and material event timestamps; the evidence-backed timeline and confidence level; missing evidence; and remediation choices with impact and rollback.

Keyword presence alone is not a root cause. A lock timeout, failed compaction, high memory, aborted request, or probe failure may be a consequence of an earlier failure.
