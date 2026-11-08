#!/usr/bin/env python3
"""Provision a new experimental Gateway only; fixed host, no sudo or inference."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess

from gateway import Registry

REMOTE = r'''
from pathlib import Path
import base64,hashlib,json,os,secrets,sqlite3,ssl,subprocess,sys,time,urllib.request,uuid
p=PAYLOAD
base=Path.home()/'.local/share/bitovp-llm-lab'
if json.loads((base/'lab-identity.json').read_text())['owner']!='bitovp-dual-gpu-llm-20261104':raise RuntimeError('wrong lab owner')
if sys.version_info[:2]!=(3,12):raise RuntimeError('expected host Python 3.12')
folder=base/'gateway';unit=Path.home()/'.config/systemd/user/bitovp-semantic-gateway.service'
if folder.exists() or unit.exists():raise RuntimeError('gateway already exists; refuse overwrite')
if any(':11437 ' in line for line in subprocess.run(['ss','-lntH'],capture_output=True,text=True,check=True).stdout.splitlines()):raise RuntimeError('port already in use')
os.umask(0o077);folder.mkdir(mode=0o700)
(folder/'owner.json').write_text(json.dumps({'owner':'bitovp-local-story-integration-20261104','experimental':True}))
(folder/'gateway.py').write_bytes(base64.b64decode(p['source']))
(folder/'plamo_runtime.py').write_bytes(base64.b64decode(p['plamoRuntimeSource']))
(folder/'stages.json').write_text(json.dumps(p['registry'],ensure_ascii=False,indent=2))
token=secrets.token_urlsafe(48)
(folder/'config.json').write_text(json.dumps({'version':'bitovp-semantic-gateway-config-v1','organizationId':'00000000-0000-4000-8000-000000000001','tokenSha256':hashlib.sha256(token.encode()).hexdigest()}))
subprocess.run(['openssl','req','-x509','-newkey','rsa:3072','-nodes','-keyout',str(folder/'server-key.pem'),'-out',str(folder/'gateway-ca.pem'),'-days','365','-subj','/CN=bitovp-semantic-x1pro','-addext','subjectAltName=IP:192.168.68.62,DNS:x1pro-lan','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign','-addext','extendedKeyUsage=serverAuth'],check=True,capture_output=True)
client={'BITOVP_LOCAL_SEMANTIC_ENABLED':'1','BITOVP_LOCAL_SEMANTIC_GATEWAY_URL':'https://192.168.68.62:11437','BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN':token,'BITOVP_LOCAL_SEMANTIC_CA_FILE':'/run/bitovp-local-semantic/gateway-ca.pem','BITOVP_LOCAL_SEMANTIC_PROFILE':'nvidia','BITOVP_LOCAL_SEMANTIC_CONFIG_ID':str(uuid.uuid4())}
(folder/'gateway-client.env').write_text(''.join(k+'='+v+'\n' for k,v in client.items()))
text='\n'.join(['[Unit]','Description=BitOVP experimental local semantic Gateway','After=network-online.target','','[Service]','Type=simple','ExecStart=/usr/bin/python3 '+str(folder/'gateway.py')+' --directory '+str(folder),'WorkingDirectory='+str(folder),'Environment=PYTHONDONTWRITEBYTECODE=1','Environment=PYTHONUNBUFFERED=1','UMask=0077','NoNewPrivileges=true','LimitNOFILE=512','TasksMax=32','MemoryMax=256M','Restart=on-failure','RestartSec=3','TimeoutStopSec=90','KillMode=control-group','','[Install]','WantedBy=default.target',''])
unit.write_text(text)
subprocess.run(['systemctl','--user','daemon-reload'],check=True,capture_output=True)
subprocess.run(['systemctl','--user','enable','--now','bitovp-semantic-gateway.service'],check=True,capture_output=True)
context=ssl.create_default_context(cafile=str(folder/'gateway-ca.pem'))
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context))
for _ in range(60):
 try:
  req=urllib.request.Request('https://192.168.68.62:11437/health',headers={'Authorization':'Bearer '+token})
  with opener.open(req,timeout=2) as response:health=json.load(response)
  if health['status']=='ok':break
 except (OSError,ValueError):time.sleep(.2)
else:raise RuntimeError('new Gateway health failed')
report={'pass':True,'service':'bitovp-semantic-gateway.service','base':str(folder),'health':health,'sourceSha256':hashlib.sha256((folder/'gateway.py').read_bytes()).hexdigest(),'unitSha256':hashlib.sha256(unit.read_bytes()).hexdigest(),'certificateSha256':hashlib.sha256((folder/'gateway-ca.pem').read_bytes()).hexdigest(),'privateModes':{n:oct((folder/n).stat().st_mode&0o777) for n in ['config.json','server-key.pem','gateway-client.env']},'inferenceRequests':0,'sudo':False,'existingServiceMutations':False,'experimentalOperatorUser':True}
(folder/'provisioning-receipt.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
'''


def validate_initial_registry(registry):
    Registry(registry)
    if not {'LOCAL_LEDGER_V1', 'LOCAL_BLUEPRINT_V1'} <= set(registry['stages']):
        raise ValueError('both story stage schemas must be registered before deployment')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    registry = json.loads(args.registry.read_text())
    validate_initial_registry(registry)
    args.output.mkdir(parents=True, exist_ok=True)
    names = ['gateway-ca.pem', 'gateway-client.env', 'gateway-provisioning-receipt.json']
    if any((args.output / name).exists() for name in names):
        raise ValueError('local handoff files already exist; refuse overwrite')
    payload = {'source': base64.b64encode((Path(__file__).parent / 'gateway.py').read_bytes()).decode(),
               'plamoRuntimeSource': base64.b64encode((Path(__file__).parent / 'plamo_runtime.py').read_bytes()).decode(), 'registry': registry}
    script = REMOTE.replace('PAYLOAD', repr(payload), 1)
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', 'x1pro-lan']
    result = subprocess.run([*ssh, 'python3 -'], input=script, capture_output=True, text=True, check=True)
    receipt = json.loads(result.stdout)
    (args.output / 'gateway-provisioning-receipt.json').write_text(json.dumps(receipt, indent=2))
    for name in ['gateway-ca.pem', 'gateway-client.env']:
        path = args.output / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                        'x1pro-lan:/home/kazuhide/.local/share/bitovp-llm-lab/gateway/' + name, str(path)], check=True)
        path.chmod(0o600 if name.endswith('.env') else 0o644)
    print(json.dumps({'pass': receipt['pass'], 'service': receipt['service'], 'stages': len(receipt['health']['stages']),
                      'inferenceRequests': 0, 'privateClientFile': str(args.output / 'gateway-client.env')}))


if __name__ == '__main__':
    main()
