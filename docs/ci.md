# CI: PR Reviewer triggers & token strategy

Scope: `.github/workflows/pr-review.yml`

## 1) Why `pull_request_target` + listened event types
We use `pull_request_target` so the workflow runs in the *base repo* context, which is required to:
- post PR reviews
- read/write Issue comments + labels (feedback loop)
- access CI secrets needed by the reviewer tool

To keep feedback timely, we listen to:
- `opened` / `reopened`: start reviewing when the PR appears again
- `synchronize`: new commits pushed to the PR branch
- `head_ref_force_pushed`: branch history rewritten (force-push)
- `labeled`: allows enabling the reviewer after PR creation (via gating label)

## 2) Why auto PRs must include the `auto-pr` label
`pull_request_target` can be dangerous if it processes untrusted PRs. We gate the job to:
- only PRs whose head repo is this repository (no forks)
- only PRs that explicitly carry the `auto-pr` label

That label is the explicit “safe to run reviewer automation” opt-in for auto-generated PRs.

## 3) Why self-review is blocked + how token choice avoids it
GitHub blocks self-review: the PR author cannot submit a review (especially `REQUEST_CHANGES`) on their own PR.

So we split tokens:
- PRs authored by a human: submit review with `GITHUB_TOKEN`
- PRs authored by `github-actions[bot]`: submit review with a PAT so the reviewer identity differs from the author

We also use a PAT when writing back to Issues/labels so the downstream label-triggered workflow actually fires.

## 4) Feedback loop (review -> marker comment -> label -> auto-work)
When the reviewer returns `REQUEST_CHANGES`, it:
1) comments on the linked Issue with marker `<!-- AI_PR_REVIEW_FEEDBACK -->` (used for dedupe + round counting)
2) toggles the Issue label `auto-work` (remove then add) to trigger the Issue handler workflow

This creates a bounded loop (max 5 rounds) until the PR is approved or automation stops.
