import os
import sys
import argparse
import asyncio
from sacp_adapter.adapter import HermesRuntimeAdapter

def main():
    parser = argparse.ArgumentParser(description='SACP Hermes Runtime Adapter')
    parser.add_argument('--mission-control-url', 
                       default=os.environ.get('MISSION_CONTROL_URL', 'https://localhost:3000'),
                       help='Mission Control server URL')
    parser.add_argument('--agent-id',
                       default=os.environ.get('AGENT_ID', 'hermes-local'),
                       help='Agent ID to register as')
    parser.add_argument('--agent-name',
                       default=os.environ.get('AGENT_NAME', 'Local Hermes'),
                       help='Human readable agent name')
    parser.add_argument('--tls-cert', 
                       default=os.environ.get('TLS_CERT_PATH'),
                       help='Path to TLS client certificate')
    parser.add_argument('--tls-key',
                       default=os.environ.get('TLS_KEY_PATH'),
                       help='Path to TLS client private key')
    parser.add_argument('--ca-cert',
                       default=os.environ.get('CA_CERT_PATH'),
                       help='Path to CA certificate for verification')
    parser.add_argument('--hermes-state-path',
                       default='.hermes/state.json',
                       help='Path to Hermes state file')

    args = parser.parse_args()

    adapter = HermesRuntimeAdapter(
        mission_control_url=args.mission_control_url,
        agent_id=args.agent_id,
        agent_name=args.agent_name,
        tls_cert_path=args.tls_cert,
        tls_key_path=args.tls_key,
        ca_cert_path=args.ca_cert,
    )

    async def run():
        try:
            await adapter.start(args.hermes_state_path)
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            await adapter.stop()

    asyncio.run(run())

if __name__ == '__main__':
    main()