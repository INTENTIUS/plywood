---
title: 'Run a day-2 action'
description: 'Declare a command resource as an action, and run it on request once a second person approves its preview.'
needs: [chant#4654]
draft: true
---

A day-2 action is an operation you run on a stack after it is up, such as rotating a key or flushing a cache. In plywood an action is a `command:local:Command` or `command:remote:Command` resource in the stack, and running it means replacing that resource. Declare it once under the stack in `plywood.yml`:

```yaml
stacks:
  shop/prod-us:
    dir: infra
    actions:
      - name: rotate
        urn: urn:pulumi:prod-us::shop::command:local:Command::rotate
        description: rotate the signing key
```

`plywood config check` refuses a URN that names another type of resource or another stack, and an action name used twice in one stack. `pulumi stack --show-urns` lists the URNs.

To ask for the action, run `npx plywood action shop/prod-us rotate`.

plywood previews the replacement of that one resource with `--target <urn> --replace <urn>`. A preview that changes anything else is refused with `action-scope`, which names the other URNs. That happens when another resource reads the command's output. Nothing is recorded then. A clean preview gets a request bound to its digest. plywood exits 3 and prints the line that approves it:

```sh
npx plywood approve action:prod-us:rotate --op pulumi-stack-ops --plan sha256:4f1c...
```

A second person runs that line, since your own approval does not count. Then you run `plywood action shop/prod-us rotate` again. The update replaces the resource, and the run is recorded on the workspace ledger. It exits 0. With `--json` the first call prints `"status": "waiting"` with the digest and the approve line, and the run prints `"status": "done"`.

A request runs once. Add `--anew` to run the action again later. It asks for a new request, which waits for a new approval.

## From the forge

On GitHub and Forgejo, `plywood ci` adds an action job to the workflow when any stack declares an action. Start it with a comment on an issue or a pull request:

```text
/plywood action shop/prod-us rotate
```

You can also dispatch the workflow by hand with the `stack` and `action` inputs. The job runs `plywood action --from-event` at the target branch's commit, and the commenter is the requester. Each comment asks for a new request. The first job ends green while the request waits. After the approval, a second comment runs the action. A GitLab pipeline does not start on a comment, so run `plywood action` from a pipeline of your own.
