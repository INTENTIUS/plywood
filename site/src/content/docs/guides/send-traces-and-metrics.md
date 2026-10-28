---
title: 'Send traces and metrics'
description: 'Each run is an OpenTelemetry trace with a span per stack.'
---

```yaml
telemetry:
  endpoint: https://otel.acme.internal:4318
  headers_env: OTEL_HEADERS
```

Each run sends one OpenTelemetry trace over OTLP/HTTP to the endpoint, with `/v1/traces` added. The run is the root span. Below it sit a span per wave, then per stack and phase, then per step. A resource the engine timed gets a span of its own under its step. Span attributes carry the `plywood.` prefix, such as `plywood.stack` and `plywood.up.result`. Tracing is chant's [observability](https://intentius.io/chant/components/observability/).

| Key | Sets |
|---|---|
| `headers_env` | the variable holding the OTLP headers, `k=v,k2=v2` |
| `service_name` | the trace's `service.name`, `plywood` by default |
| `traces` | `false` turns traces off |
 An `OTEL_*` variable the job already sets wins over plywood.yml.
