# SACP Hermes Runtime Adapter

This directory contains the Sincelabs Agent Control Protocol (SACP) adapter for Hermes agents. The adapter implements the runtime side of the SACP v1 protocol, connecting to Mission Control and translating between SACP messages and Hermes operations.

## Components

- `adapter.py` - Main adapter implementation
- `__main__.py` - Command-line entry point

## Usage

```bash
cd hermes-agent
python -m sacp_adapter \
  --mission-control-url https://mission-control.example.com \
  --agent-id my-agent-1 \
  --agent-name "My Agent" \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem \
  --ca-cert /path/to/ca.pem
```

Environment variables can also be used instead of command line arguments:

- `MISSION_CONTROL_URL`
- `AGENT_ID` 
- `AGENT_NAME`
- `TLS_CERT_PATH`
- `TLS_KEY_PATH`
- `CA_CERT_PATH`