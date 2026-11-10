---
title: 'Sign the checks'
description: 'The wave jobs sign their plan and policy checks keyless or with a runner key; plywood init writes the trust file that verifies them.'
---

plywood switches on chant's [check evidence](https://intentius.io/chant/cli/ci/) with one key in `plywood.yml`. Sign keyless, from each job's OIDC token:

```yaml
evidence:
  identity: oidc
```

Or with a runner key kept in a secret (a CI/CD variable on GitLab):

```yaml
evidence:
  runner_key_secret: CHANT_RUNNER_KEY_PEM
```

Run `plywood ci` (or `plywood init`) after you set it.

## The signed checks

Each wave job that decides a wave signs `plan:<wave>` once the wave is planned, and `policy:<wave>` when the wave's policy ran and denied nothing. The evidence is a git note under `refs/notes/chant/evidence`, bound to the commit's tree. For keyless evidence the job asks the forge for an OIDC token. On GitHub that is the `id-token: write` permission. GitLab jobs get an `id_tokens` entry; Forgejo jobs get `enable-openid-connect`. With `runner_key_secret` the job reads the key from the secret instead.

`plywood check` runs chant's check stage. In a job with `CHANT_RUNNER_IDENTITY=oidc` or `CHANT_RUNNER_KEY` set, each check hook that passed gets evidence under the hook's name, such as `pre-commit`.

With the key, the pull request workflow signs too. Its note job signs `plan:<member>` and `policy:<member>` for the pull request's commit, where `<member>` is the workspace member at the repository's root (`shop` for a project named `shop`). Another job runs the hooks through `chant ci check` on that commit and signs each one that passed under its name. A ref gate job then reads the evidence against the rule for the default branch and sets the `chant/ref-gate` status on the pull request.

## The trust file

When `plywood.yml` has the key, `plywood init` writes `.chant/trust.json`, which chant reads at the base commit:

- For `identity: oidc` on GitHub or GitLab, the waves workflow's identity on the default branch, under `keyless.identities`, with its principal `ci` in `roles.runner`. Put sigstore's `trusted_root.json` at `.chant/trusted_root.json`, the path the file names. A Forgejo job's certificate comes from an authority you run; add its issuer and subject yourself.
- For `runner_key_secret`, no identity. Add the runner key's public half under `runners`, and its PEM to the secret. `plywood init` prints chant's commands for making and listing the key.
- A rule for the default branch under `refs`, naming each check hook, `plan:<member>` and `policy:<member>`. chant writes the rule (its `refGateInitPlan`), and the ref gate's status is chant's default, `chant/ref-gate`.

A trust file already there is merged into, and the entries it has stay as they are. A file that already has a rule for the default branch keeps it.

## The ref gate

`plywood init` installs chant's [ref gate](https://intentius.io/chant/cli/workspace-ref-gate/) in `.git/hooks/pre-push` of the clone it runs in, where it runs `npx chant workspace ref-gate pre-push`. A `pre-push` file that is not chant's is left as it is, and init says so. Git never commits that directory, so each other clone installs the gate with:

```sh
npx chant workspace ref-gate install --hook pre-push
```

The hook refuses a push to the default branch whose commit has no current evidence for a check the rule names, and names each missing check and the command that produces it. On a pull request the ref gate job sets `chant/ref-gate`, so make that the required status on the default branch, as `plywood init` reminds you. `plywood forge check` then expects the default branch to require it. A policy at base that does not read sets the status to failure.

## Local evidence

```yaml
evidence:
  identity: oidc
  local: true
```

`local: true` has `plywood init` name each check hook under `local.checks`. The ref gate's rule then leaves the hooks out, since a hook CI skips has no runner evidence. A hook a person already proved on their machine for the same tree is then skipped in CI. Add each person's `ssh-ed25519` key under `local.keys`, and sign on the machine with the key in `CHANT_LOCAL_EVIDENCE_KEY` while `plywood check` runs. Without `local`, no check takes local evidence. `plan` and `policy` never do.
