---
title: 'Send traces and metrics'
description: 'Each run is an OpenTelemetry trace with a span per stack.'
needs: [plywood#1]
draft: true
---

```yaml
telemetry:
  endpoint: https://otel.acme.internal:4318
```

Each run sends one OpenTelemetry trace over OTLP. The stage is the root span. Each stack gets a span below it, and Pulumi's engine events nest inside the stack's span. Tracing is chant's [observability](https://intentius.io/chant/components/observability/).
