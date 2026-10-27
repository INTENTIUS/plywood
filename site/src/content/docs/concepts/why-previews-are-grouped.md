---
title: 'Why previews are grouped'
description: 'One note and one digest across stacks keep a reviewer''s approval tied to the whole change.'
needs: [plywood#1, chant#4541, chant#4550]
draft: true
---

A change to a shared component often reaches many stacks. One comment per stack makes a reviewer approve each piece alone, and a piece can merge while its siblings wait.

plywood groups every stack's preview into one [change set](https://intentius.io/chant/reference/change-set/), chant's format. It has a digest per stack and one over the set. The note shows each distinct change once and lists the stacks that take it. One approval binds the set's digest, so the whole change is reviewed as one.
