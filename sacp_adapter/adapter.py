import asyncio
import json
import ssl
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
import httpx
from websockets.client import connect as ws_connect

@dataclass
class RuntimeIdentity:
    agent_id: str
    runtime_instance_id: str
    access_token: str
    expires_in: int

@dataclass
class ActualState:
    status: str
    crons: list[dict[str, Any]] = field(default_factory=list)
    mcps: list[dict[str, Any]] = field(default_factory=list)
    skills: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

@dataclass
class DesiredStateEnvelope:
    revision: int
    desired_state: dict[str, Any]
    created_at: str

class HermesRuntimeAdapter:
    def __init__(
        self,
        mission_control_url: str,
        agent_id: str,
        agent_name: str,
        tls_cert_path: Optional[str] = None,
        tls_key_path: Optional[str] = None,
        ca_cert_path: Optional[str] = None,
    ):
        self.mission_control_url = mission_control_url.rstrip('/')
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.tls_cert_path = tls_cert_path
        self.tls_key_path = tls_key_path
        self.ca_cert_path = ca_cert_path
        self.identity: Optional[RuntimeIdentity] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._ws = None
        self._running = False

    def _build_ssl_context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        if self.tls_cert_path and self.tls_key_path:
            ctx.load_cert_chain(self.tls_cert_path, self.tls_key_path)
        if self.ca_cert_path:
            ctx.load_verify_locations(self.ca_cert_path)
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
        return ctx

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            kwargs = {'timeout': 30.0, 'base_url': self.mission_control_url}
            if self.tls_cert_path and self.tls_key_path:
                kwargs['verify'] = self._build_ssl_context()
            self._client = httpx.AsyncClient(**kwargs)
        return self._client

    async def register(self) -> RuntimeIdentity:
        client = await self._get_client()
        payload = {
            'identity': {
                'agentId': self.agent_id,
                'agentName': self.agent_name,
                'runtimeType': 'hermes',
                'runtimeVersion': '0.1.0',
                'adapterVersion': '1.0.0',
                'protocolVersions': ['sacp-v1'],
            },
            'capabilities': {
                'drivingMode': ['desired-state'],
                'modelConfig': True,
                'memoryConfig': True,
                'crontab': True,
                'mcp': True,
                'skills': True,
            },
        }
        resp = await client.post('/v1/register', json=payload)
        resp.raise_for_status()
        data = resp.json()
        self.identity = RuntimeIdentity(
            agent_id=data['agentId'],
            runtime_instance_id=data['runtimeInstanceId'],
            access_token=data['accessToken'],
            expires_in=data['expiresIn'],
        )
        return self.identity

    async def heartbeat(self) -> bool:
        if not self.identity:
            raise RuntimeError('Not registered')
        client = await self._get_client()
        resp = await client.post(
            '/v1/heartbeat',
            json={'timestamp': datetime.now(timezone.utc).isoformat()},
            headers={'Authorization': f'Bearer {self.identity.access_token}'},
        )
        return resp.status_code == 200

    async def get_actual_state(self, hermes_state_path: str = '.hermes/state.json') -> ActualState:
        try:
            with open(hermes_state_path, 'r') as f:
                hermes_state = json.load(f)
        except FileNotFoundError:
            hermes_state = {}

        crons = []
        mcps = []
        skills = []

        # Parse cron jobs
        if 'crons' in hermes_state:
            for cron in hermes_state['crons']:
                crons.append({
                    'id': cron.get('id', cron.get('name', '')),
                    'name': cron.get('name', ''),
                    'prompt': cron.get('prompt', ''),
                    'schedule': {
                        'kind': 'cron',
                        'expr': cron.get('schedule', ''),
                        'display': cron.get('schedule', ''),
                    },
                    'enabled': cron.get('enabled', True),
                })

        # Parse MCP servers
        if 'mcps' in hermes_state:
            for mcp in hermes_state['mcps']:
                mcps.append({
                    'name': mcp.get('name', ''),
                    'url': mcp.get('url', ''),
                    'enabled': mcp.get('enabled', True),
                })

        # Parse skills
        if 'skills' in hermes_state:
            for skill in hermes_state['skills']:
                skills.append({
                    'name': skill.get('name', ''),
                    'description': skill.get('description', ''),
                    'enabled': skill.get('enabled', True),
                })

        # Get additional runtime information
        import platform
        import psutil
        import os
        
        # Get process info
        process = psutil.Process(os.getpid())
        memory_info = process.memory_info()
        
        # Get system info
        system_info = {
            'platform': platform.system(),
            'platform_version': platform.version(),
            'architecture': platform.machine(),
            'cpu_count': psutil.cpu_count(),
            'memory_total': psutil.virtual_memory().total,
        }

        # Get Hermes specific info
        hermes_info = {
            'version': hermes_state.get('version', 'unknown'),
            'model_provider': hermes_state.get('model_provider', {}),
            'memory_provider': hermes_state.get('memory_provider', {}),
        }

        return ActualState(
            status='running',
            crons=crons,
            mcps=mcps,
            skills=skills,
            metadata={
                'process': {
                    'pid': process.pid,
                    'memory_rss': memory_info.rss,
                    'memory_vms': memory_info.vms,
                    'cpu_percent': process.cpu_percent(),
                },
                'system': system_info,
                'hermes': hermes_info,
            }
        )

    async def report_actual_state(self, state: ActualState) -> bool:
        if not self.identity:
            raise RuntimeError('Not registered')
        client = await self._get_client()
        resp = await client.post(
            '/v1/actual-state',
            json={
                'agentId': self.agent_id,
                'report': {
                    'status': state.status,
                    'crons': state.crons,
                    'mcps': state.mcps,
                    'skills': state.skills,
                    'timestamp': state.timestamp,
                },
            },
            headers={'Authorization': f'Bearer {self.identity.access_token}'},
        )
        return resp.status_code == 200

    async def get_desired_state(self) -> Optional[DesiredStateEnvelope]:
        if not self.identity:
            raise RuntimeError('Not registered')
        client = await self._get_client()
        resp = await client.get(
            '/v1/desired-state',
            params={'agentId': self.agent_id},
            headers={'Authorization': f'Bearer {self.identity.access_token}'},
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        return DesiredStateEnvelope(
            revision=data['envelope']['revision'],
            desired_state=data['envelope']['desiredState'],
            created_at=data['envelope']['createdAt'],
        )

    async def start_event_loop(self):
        if not self.identity:
            raise RuntimeError('Not registered')

        ws_url = self.mission_control_url.replace('https://', 'wss://').replace('http://', 'ws://')
        ws_url = f'{ws_url}/v1/events'

        ssl_ctx = None
        if self.tls_cert_path and self.tls_key_path:
            ssl_ctx = self._build_ssl_context()

        self._running = True
        while self._running:
            try:
                async with ws_connect(
                    ws_url,
                    extra_headers={'Authorization': f'Bearer {self.identity.access_token}'},
                    ssl=ssl_ctx,
                ) as ws:
                    async for msg in ws:
                        try:
                            data = json.loads(msg)
                            await self._handle_event(data)
                        except json.JSONDecodeError:
                            pass
            except Exception as e:
                if self._running:
                    await asyncio.sleep(5)

    async def _handle_event(self, event: dict[str, Any]):
        event_type = event.get('type', '')
        if event_type == 'desired_state_changed':
            new_state = await self.get_desired_state()
            if new_state:
                await self.apply_desired_state(new_state)
        elif event_type == 'command':
            await self._handle_command(event)

    async def _handle_command(self, event: dict[str, Any]):
        """
        Handle commands sent from Mission Control
        """
        command_id = event.get('commandId')
        action = event.get('action')
        payload = event.get('payload', {})
        
        print(f"Received command {command_id}: {action}")
        
        # Send acknowledgment
        response = {
            'commandId': command_id,
            'status': 'processing',
            'result': {}
        }
        
        # TODO: Implement actual command handling based on action
        # For now, we'll just acknowledge and complete the command
        response['status'] = 'completed'
        response['result'] = {'message': f'Command {action} processed successfully'}
        
        # Send response back to Mission Control
        # In a real implementation, this would be sent via WebSocket or HTTP
        print(f"Command {command_id} completed: {response}")

    async def apply_desired_state(self, envelope: DesiredStateEnvelope) -> bool:
        """
        Apply desired state to the Hermes agent.
        This method should update the Hermes configuration based on the desired state.
        """
        try:
            # Extract configuration from desired state
            desired_crons = envelope.desired_state.get('crons', [])
            desired_mcps = envelope.desired_state.get('mcps', [])
            desired_skills = envelope.desired_state.get('skills', [])
            
            # Update Hermes state file
            hermes_state_path = '.hermes/state.json'
            
            # Load current state
            try:
                with open(hermes_state_path, 'r') as f:
                    current_state = json.load(f)
            except FileNotFoundError:
                current_state = {}
            
            # Update crons
            if desired_crons is not None:
                current_state['crons'] = desired_crons
            
            # Update MCPs
            if desired_mcps is not None:
                current_state['mcps'] = desired_mcps
            
            # Update skills
            if desired_skills is not None:
                current_state['skills'] = desired_skills
            
            # Save updated state
            os.makedirs(os.path.dirname(hermes_state_path), exist_ok=True)
            with open(hermes_state_path, 'w') as f:
                json.dump(current_state, f, indent=2)
            
            print(f"Applied desired state revision {envelope.revision}")
            return True
        except Exception as e:
            print(f"Error applying desired state: {e}")
            return False

    async def start(self, hermes_state_path: str = '.hermes/state.json'):
        await self.register()
        # Start periodic actual state reporting
        asyncio.create_task(self._periodic_report(hermes_state_path))
        # Start event loop for commands and desired state changes
        asyncio.create_task(self.start_event_loop())

    async def _periodic_report(self, hermes_state_path: str, interval: int = 60):
        """Periodically report actual state to Mission Control"""
        while self._running:
            try:
                state = await self.get_actual_state(hermes_state_path)
                success = await self.report_actual_state(state)
                if not success:
                    print(f"Failed to report actual state")
            except Exception as e:
                print(f"Error reporting actual state: {e}")
            await asyncio.sleep(interval)

    async def _periodic_report(self, hermes_state_path: str, interval: int = 60):
        while self._running:
            try:
                state = await self.get_actual_state(hermes_state_path)
                await self.report_actual_state(state)
            except Exception:
                pass
            await asyncio.sleep(interval)

    async def stop(self):
        self._running = False
        if self._client:
            await self._client.aclose()
            self._client = None

async def main():
    import os
    adapter = HermesRuntimeAdapter(
        mission_control_url=os.environ.get('MISSION_CONTROL_URL', 'https://localhost:3000'),
        agent_id=os.environ.get('AGENT_ID', 'hermes-local'),
        agent_name=os.environ.get('AGENT_NAME', 'Local Hermes'),
        tls_cert_path=os.environ.get('TLS_CERT_PATH'),
        tls_key_path=os.environ.get('TLS_KEY_PATH'),
        ca_cert_path=os.environ.get('CA_CERT_PATH'),
    )
    try:
        await adapter.start()
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await adapter.stop()

if __name__ == '__main__':
    asyncio.run(main())