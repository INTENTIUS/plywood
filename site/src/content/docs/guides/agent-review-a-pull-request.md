---
title: 'Have an agent review a pull request'
description: 'A model compares the pull request''s description with its previews and posts one note.'
---

plywood switches on chant's [review agent](https://intentius.io/chant/guide/review-agent/).

```yaml
review: true
```

`plywood ci` then writes a review job for each pull request. It previews the change and hands the description, the diff and the change set to the model, which answers with one note: the risk, and any mismatch between the stated intent and the previews. The model's job holds no forge write token; a second job posts the note. On GitLab the note job runs from a schedule on the default branch. The review approves and gates nothing.

As a mapping, `review` takes four keys:

| Key | Default |
|---|---|
| `instructions`: the instructions file on the base branch | `.chant/review.md` |
| `command`: the model command, prompt on stdin and answer on stdout | chant's |
| `key_env`: the variable holding the model's key | `ANTHROPIC_API_KEY` |
| `timeout`: minutes the command may run | chant's |
