# OMNIBOARD migration workflow

## Four-outcome workflow

Every agent and environment uses the same workflow. Progress labels describe
implementation milestones; the computed workflow decision controls the next action.

| Outcome | Meaning | Next action |
| --- | --- | --- |
| Complete | The migration is merged | Stop; leave retained local edits untouched |
| Dismissed | The migration is no longer required | Stop; close any linked open MR with an explanation |
| Waiting | No useful work can proceed now | Report the reason and continue another project |
| Actionable | The agent can advance delivery | Prepare, implement or repair, validate, and publish |

`progress.workflow` contains `outcome`, `reason`, `instruction`, `nextAction`, and
`maintenance`. The API owns the evaluator and candidate selection; the dashboard
and MCP consume its decisions. MCP checks fresh facts before checkout operations.
This release requires a manual SQL migration followed by matching API/app and MCP
versions. Existing milestone snapshots remain milestone history.

The authoritative [state contract and detailed lifecycle charts](https://github.com/omniboard-dev/omniboard/blob/main/docs/runbooks/agentic-runner-state-model.md)
cover ownership, transitions, retries, reconciliation, and the manual cutover.

### Continue loop

The API selects pending projects first, started/published work second, and
failed/blocked/needs-input work third, smallest source size first
within each group. Explicit status filters override that ordering. Complete and
dismissed records are excluded, including when a status filter includes done.
Waiting, stopped and failed preparations do not consume the actionable batch limit.
An empty batch is not proof that all migrations merged.

```mermaid
flowchart TD
    Start[Continue migration] --> Maintain[Assess retries and reconcile dismissed cleanup]
    Maintain --> Select[API selects next unfinished candidate]
    Select --> Assess[Refresh facts and assess]
    Assess --> Outcome{Outcome}
    Outcome -- Complete --> Next[Next candidate]
    Outcome -- Dismissed --> Next
    Outcome -- Waiting --> Defer[Report reason and revisit later]
    Defer --> Next
    Outcome -- Actionable --> Execute[Execute next useful step]
    Execute --> Assess
    Next --> Select
```

### Assessment

Merged evidence takes precedence over local files and old progress labels.
Dismissed is terminal until an explicit retry clears the resolution through the
retry assessment. A progress report cannot reopen a terminal migration or
replace its MR. Milestones alone never establish completion; the SQL cutover
normalizes historical ambiguous records once.

No recorded MR is normal for new work. A failed lookup of a recorded MR, or failed
discovery, leaves required provider facts unknown and prevents migration work.
The existing reconciliation policy determines applicability for recorded work;
a changed analyzer result alone does not override a confirmed merge. Fresh
projects must match the configured target. Explicit retries are reassessed.

```mermaid
flowchart TD
    Facts[Refresh project and provider facts] --> Terminal{Terminal outcome?}
    Terminal -- Merged --> Complete[Complete]
    Terminal -- Dismissed --> Dismissed[Dismissed]
    Terminal -- Neither --> Available{Required facts available?}
    Available -- No --> Unknown[Waiting: state unknown]
    Available -- Yes --> Applicable{Applicable to this run?}
    Applicable -- No --> Dismissed
    Applicable -- Yes --> Useful{Useful next step?}
    Useful -- Yes --> Actionable[Actionable]
    Useful -- No --> Waiting[Waiting: external dependency]
    Dismissed -. Explicit retry .-> Facts
```

Agent work ends when an open MR has successful CI and is mergeable. Keep the
existing mr_created milestone and return waiting/merge_request_ready; merging
belongs to the user or consuming team. Running or pending CI also waits. Failed
CI becomes repair work when no newer pipeline is running. Conflicts or a required
rebase remain actionable even with green CI: rebase onto the target branch,
resolve conflicts, validate and push the existing MR. Approval and external
blockers wait. Infrastructure-only CI failures retain their external-blocker
classification. Waiting preparation never touches a retained checkout or creates
new work by rebasing an already-green MR.

```mermaid
flowchart TD
    MR[Open MR] --> Conflict{Conflicts or rebase required?}
    Conflict -- Yes --> Repair[Rebase onto target and resolve conflicts]
    Conflict -- No --> CI{Current CI}
    CI -- Running or pending --> Wait[Waiting]
    CI -- Application failure --> Fix[Repair CI failure]
    CI -- Infrastructure failure --> Wait
    CI -- Unknown or absent --> Wait
    CI -- Successful --> Ready{Mergeable?}
    Ready -- Yes --> Green[Waiting: green mergeable MR]
    Ready -- Concrete review or draft repair --> Fix
    Ready -- Approval, external checks, or unknown --> Wait
    Repair --> Verify[Validate and push existing MR]
    Fix --> Verify
    Verify --> MR
    Wait -- Next refresh after provider or operator event --> MR
    Green -- Later conflict or failed CI --> MR
    Green -- Human merges --> Complete[Record Merged]
```

### Inside actionable

Always call preparation before editing a retained checkout. Only a continue
result with a workspace permits migration work. Preparation reuses compatible
local edits or recreates disposable state from the remote branch/current target.
Use finalization for publication; do not replay stale whole files via a provider
commit API. Finalization repeats preparation. A recreated checkout or changed HEAD
after synchronization, including rebase recovery, returns without publishing so
the agent can review and rerun checks. After publication, assess CI and mergeability; do not merge automatically.

```mermaid
flowchart TD
    Prepare[Prepare and synchronize workspace] --> Step{Next useful step}
    Step -- Implement or repair --> Edit[Edit and resolve conflicts]
    Edit --> Validate[Run relevant checks]
    Validate -- Failed --> Edit
    Validate -- Passed --> Refresh[Synchronize source and target, including rebase recovery]
    Step -- Unpublished changes --> Validate
    Refresh -- Checkout changed --> Validate
    Refresh -- Still actionable and validated --> Publish[Publish or update MR]
    Refresh -- Terminal or waiting --> Assess[Return to assessment]
    Publish --> Assess
```

Dismissal cleanup preserves the dismissed resolution. Comment/closure failures
remain provider sync errors and retry on reconciliation; already closed or merged
MRs are left alone. Cleanup results are saved only if the dismissal version is
still current, preserving explicit retries made while closure was in flight.
Discovery never substitutes a new MR for a terminal record.
Replacing an unfinished MR clears the old provider identity, pipeline evidence,
and completion timestamps.

### Deployment contract

Run the manual SQL cutover with API/runner writers stopped, then deploy the matching
API/app before using this MCP release. A missing workflow decision is a contract
error; there is no runtime legacy-state conversion or fallback classifier.
The action values continue/wait/stop map directly from the API next action.

Retry dispositions are pending, accepted, consumed, no_work, excluded, and
superseded. Pending assessment suspends dismissal cleanup. A ready or merged MR
settles unneeded guidance as no_work; accepted guidance is consumed with the next
runner report. Provider refresh preserves explicit human holds. An explicit retry
releases the hold and asks the API to reassess current facts.

Read-only list/state calls do not reconcile or write. Explicit refresh, preparation,
and batch selection invoke reconciliation. Dashboard initial load reconciles
applicability and cleanup; dashboard refresh also observes providers. There is no
new background polling service. External waits require their named owner/event and
a refresh; they do not authorize application changes.
