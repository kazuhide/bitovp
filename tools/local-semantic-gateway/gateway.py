#!/usr/bin/env python3
"""Experimental, authenticated local semantic jobs; fixed runtimes and no model tools."""
from __future__ import annotations

from contextlib import contextmanager
import argparse
import fcntl
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import ssl
import threading
import time
import uuid

from gpu_capability import RuntimeGpuCapability

MODEL = 'qwen3.8:27b-q8_0'
MODEL_DIGEST = '8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039'
RUNTIME_VERSION = '0.40.14'
PORTS = {'amd': 11436, 'nvidia': 11435}
STAGES = {'LOCAL_LEDGER_V1': 1024, 'LOCAL_BLUEPRINT_V1': 1536, 'LOCAL_CAPTION_JA_V1': 1536, 'LOCAL_CAPTION_JA_V2': 1536,
          'LOCAL_FLOW_CONTEXT_V1': 1536, 'LOCAL_FLOW_ROUTE_V1': 1536, 'LOCAL_STORY_CHOICE_V1': 512}
LEGACY_STAGES = frozenset(('LOCAL_LEDGER_V1', 'LOCAL_BLUEPRINT_V1', 'LOCAL_CAPTION_JA_V1', 'LOCAL_CAPTION_JA_V2'))
FLOW_STAGES = frozenset(('LOCAL_FLOW_CONTEXT_V1', 'LOCAL_FLOW_ROUTE_V1'))
CHOICE_STAGES = frozenset(('LOCAL_STORY_CHOICE_V1',))
PROMPT_VERSIONS = {'LOCAL_LEDGER_V1': 'local-story-v1', 'LOCAL_BLUEPRINT_V1': 'local-story-v1',
                   'LOCAL_CAPTION_JA_V1': 'caption-ja-v1', 'LOCAL_CAPTION_JA_V2': 'caption-ja-v2',
                   'LOCAL_FLOW_CONTEXT_V1': 'local-story-flow-context-v1', 'LOCAL_FLOW_ROUTE_V1': 'local-story-flow-route-v1',
                   'LOCAL_STORY_CHOICE_V1': 'local-story-choice-v1'}
ACTIVE = ('LOADING', 'RUNNING', 'VALIDATING', 'CANCELLING')
TERMINAL = ('SUCCEEDED', 'FAILED', 'CANCELLED')
MAX_BODY = 128 * 1024
SHA = re.compile(r'^[a-f0-9]{64}$')
UNCONFIRMED_ERRORS = ('CLEANUP_FAILED', 'RUNTIME_STOP_UNCONFIRMED', 'RESTARTED', 'RUNTIME_FAILED', 'LEASE_LOST')


def runtime_release_bindings(row):
    payload = json.loads(row['payload'], parse_constant=reject_nonfinite)
    if (not isinstance(payload, dict) or canonical_hash(payload) != row['request_hash']
            or payload.get('organizationId') != row['organization'] or payload.get('requestKey') != row['request_key']
            or payload.get('stage') != row['stage'] or payload.get('profile') not in PORTS):
        raise GatewayError('INVALID_RELEASE_PROOF', 422)
    return {'jobId': row['id'], 'organizationId': row['organization'], 'profile': payload['profile'],
            'requestHash': row['request_hash'], 'payloadHash': hashlib.sha256(row['payload'].encode()).hexdigest(),
            'terminalRowHash': canonical_hash(dict(row)), 'errorCode': row['error_code']}


def validate_runtime_release(proof, row):
    fields = {'version', 'releaseId', 'jobId', 'organizationId', 'profile', 'requestHash', 'payloadHash',
              'terminalRowHash', 'errorCode', 'quarantineHash', 'captureHash', 'confirmedAt', 'operatorUid', 'bootId', 'units'}
    if (row['stage'] not in STAGES or not isinstance(proof, dict) or set(proof) != fields or proof['version'] != 'bitovp-runtime-release-v1'
            or not valid_uuid(proof['releaseId']) or not valid_uuid(proof['bootId'])
            or type(proof['operatorUid']) is not int or proof['operatorUid'] != os.getuid()
            or type(proof['confirmedAt']) not in (int, float) or not math.isfinite(proof['confirmedAt'])
            or not row['created'] <= proof['confirmedAt'] <= time.time() + 5
            or row['state'] != 'FAILED' or row['cleanup_confirmed'] != 0 or row['error_code'] not in UNCONFIRMED_ERRORS
            or any(not isinstance(proof[key], str) or not SHA.fullmatch(proof[key]) for key in ('quarantineHash', 'captureHash'))):
        raise GatewayError('INVALID_RELEASE_PROOF', 422)
    if any(proof.get(key) != value for key, value in runtime_release_bindings(row).items()):
        raise GatewayError('INVALID_RELEASE_PROOF', 422)
    expected = ['bitovp-semantic-gateway.service', 'bitovp-llm-' + proof['profile'] + '.service']
    if not isinstance(proof['units'], list) or len(proof['units']) != 2:
        raise GatewayError('INVALID_RELEASE_PROOF', 422)
    for unit, name in zip(proof['units'], expected):
        unit_fields = {'unitName', 'cgroup', 'unitFileHash', 'effectiveConfigHash', 'mainProcessExeHash', 'mainProcessArgvHash', 'beforeMainPid', 'oldProcesses', 'observedStoppedAt',
                       'activeState', 'mainPid', 'cgroupEmpty', 'oldPidsGone'}
        group = f'/user.slice/user-{proof["operatorUid"]}.slice/user@{proof["operatorUid"]}.service/app.slice/{name}'
        if (not isinstance(unit, dict) or set(unit) != unit_fields or unit['unitName'] != name or unit['cgroup'] != group
                or any(not isinstance(unit[key], str) or not SHA.fullmatch(unit[key])
                       for key in ('unitFileHash', 'effectiveConfigHash', 'mainProcessExeHash', 'mainProcessArgvHash'))
                or type(unit['beforeMainPid']) is not int or unit['beforeMainPid'] <= 0
                or unit['activeState'] != 'inactive' or type(unit['mainPid']) is not int or unit['mainPid'] != 0
                or unit['cgroupEmpty'] is not True or unit['oldPidsGone'] is not True
                or type(unit['observedStoppedAt']) not in (int, float) or not math.isfinite(unit['observedStoppedAt'])
                or not row['created'] <= unit['observedStoppedAt'] <= proof['confirmedAt']
                or not isinstance(unit['oldProcesses'], list) or not 1 <= len(unit['oldProcesses']) <= 256):
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        processes = unit['oldProcesses']
        if (any(not isinstance(p, dict) or set(p) != {'pid', 'startTicks'} or type(p['pid']) is not int
                or p['pid'] <= 0 or type(p['startTicks']) is not int or p['startTicks'] <= 0 for p in processes)
                or len({p['pid'] for p in processes}) != len(processes)
                or unit['beforeMainPid'] not in {p['pid'] for p in processes}):
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
    return proof


def validate_runtime_capture(capture, row):
    fields = {'version', 'capturedAt', 'operatorUid', 'bootId', 'bindings', 'quarantineHash', 'units'}
    if (not isinstance(capture, dict) or set(capture) != fields
            or capture['version'] != 'bitovp-runtime-release-capture-v1'
            or capture['bindings'] != runtime_release_bindings(row)
            or not isinstance(capture['units'], list)):
        raise GatewayError('INVALID_RELEASE_PROOF', 422)
    stop_keys = {'observedStoppedAt', 'activeState', 'mainPid', 'cgroupEmpty', 'oldPidsGone'}
    proof = {'version': 'bitovp-runtime-release-v1', 'releaseId': str(uuid.uuid4()), **capture['bindings'],
             'quarantineHash': capture['quarantineHash'], 'captureHash': canonical_hash(capture),
             'confirmedAt': capture['capturedAt'], 'operatorUid': capture['operatorUid'], 'bootId': capture['bootId'],
             'units': [{**unit, 'observedStoppedAt': capture['capturedAt'], 'activeState': 'inactive',
                        'mainPid': 0, 'cgroupEmpty': True, 'oldPidsGone': True} for unit in capture['units']
                       if isinstance(unit, dict) and not (set(unit) & stop_keys)]}
    validate_runtime_release(proof, row)
    return capture


def canonical_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def canonical_hash(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def reject_nonfinite(_):
    raise ValueError('non-finite JSON')


class GatewayError(Exception):
    def __init__(self, code, status=500):
        self.code, self.status = code, status
        super().__init__(code)


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


class Registry:
    def __init__(self, value):
        if not isinstance(value, dict):
            raise ValueError('invalid stage registry')
        version = value.get('version')
        if version == 'bitovp-semantic-stages-v1':
            fields = {'version', 'stages'}
        elif version == 'bitovp-semantic-stages-combined-v1':
            fields = {'version', 'stages', 'legacyRegistryHash', 'flowRegistryHash'}
        elif version == 'bitovp-semantic-stages-planning-v1':
            fields = {'version', 'stages', 'legacyRegistryHash', 'choiceRegistryHash'}
        else:
            raise ValueError('invalid stage registry')
        if set(value) != fields:
            raise ValueError('invalid stage registry')
        self.stages = value['stages']
        if not isinstance(self.stages, dict):
            raise ValueError('invalid stage names')
        if version == 'bitovp-semantic-stages-v1':
            if not set(self.stages) <= LEGACY_STAGES:
                raise ValueError('invalid stage names')
        elif version == 'bitovp-semantic-stages-planning-v1':
            if set(self.stages) != LEGACY_STAGES | CHOICE_STAGES:
                raise ValueError('invalid stage names')
            legacy = {'version': 'bitovp-semantic-stages-v1',
                      'stages': {name: stage for name, stage in self.stages.items() if name in LEGACY_STAGES}}
            choice = {'version': 'local-story-choice-stages-v1',
                      'stages': {name: stage for name, stage in self.stages.items() if name in CHOICE_STAGES}}
            if value['legacyRegistryHash'] != canonical_hash(legacy) or value['choiceRegistryHash'] != canonical_hash(choice):
                raise ValueError('component registry hash mismatch')
        else:
            if set(self.stages) != LEGACY_STAGES | FLOW_STAGES:
                raise ValueError('invalid stage names')
            legacy = {'version': 'bitovp-semantic-stages-v1',
                      'stages': {name: stage for name, stage in self.stages.items() if name in LEGACY_STAGES}}
            flow = {'version': 'local-story-flow-stages-v1',
                    'stages': {name: stage for name, stage in self.stages.items() if name in FLOW_STAGES}}
            if value['legacyRegistryHash'] != canonical_hash(legacy) or value['flowRegistryHash'] != canonical_hash(flow):
                raise ValueError('component registry hash mismatch')
        for name, stage in self.stages.items():
            if not isinstance(stage, dict) or set(stage) != {'promptVersion', 'schemaHash', 'schema', 'maxOutputTokens'}:
                raise ValueError('invalid stage configuration')
            expected_prompt = PROMPT_VERSIONS[name]
            if stage['promptVersion'] != expected_prompt or not isinstance(stage['schema'], dict):
                raise ValueError('invalid prompt/schema')
            if stage['schemaHash'] != canonical_hash(stage['schema']):
                raise ValueError('stage schema hash mismatch')
            limit = stage['maxOutputTokens']
            if (type(limit) is not int or not 1 <= limit <= STAGES[name]
                    or (name in CHOICE_STAGES and limit != STAGES[name])):
                raise ValueError('stage token limit exceeds fixed budget')
            pending = [stage['schema']]
            while pending:
                node = pending.pop()
                if isinstance(node, dict):
                    if any(key in node and not str(node[key]).startswith('#') for key in ('$ref', '$dynamicRef')):
                        raise ValueError('external schema references forbidden')
                    pending.extend(node.values())
                elif isinstance(node, list):
                    pending.extend(node)

    def validate(self, body, organization):
        fields = {'version', 'requestKey', 'organizationId', 'profile', 'stage', 'prompt', 'inputHash', 'promptVersion', 'schemaHash'}
        if not isinstance(body, dict) or set(body) != fields:
            raise GatewayError('INVALID_REQUEST', 422)
        if body['organizationId'] != organization:
            raise GatewayError('TENANT_FORBIDDEN', 403)
        stage = self.stages.get(body['stage']) if isinstance(body['stage'], str) else None
        if (body['version'] != 'bitovp-semantic-job-v1' or not valid_uuid(body['requestKey'])
                or not isinstance(body['profile'], str) or body['profile'] not in PORTS or stage is None
                or body['promptVersion'] != stage['promptVersion'] or body['schemaHash'] != stage['schemaHash']
                or not isinstance(body['inputHash'], str) or not SHA.fullmatch(body['inputHash'])
                or not isinstance(body['prompt'], str) or not body['prompt'].strip()
                or len(body['prompt'].encode('utf-8')) > 8192 - stage['maxOutputTokens'] - 1024):
            raise GatewayError('INVALID_REQUEST', 422)
        return stage


class Store:
    def __init__(self, path):
        self.path = path
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, organization TEXT NOT NULL, request_key TEXT NOT NULL,
                request_hash TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL,
                payload TEXT NOT NULL, result TEXT, error_code TEXT, owner TEXT,
                cleanup_confirmed INTEGER NOT NULL DEFAULT 0,
                cancel_requested INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL,
                UNIQUE(organization, request_key))''')
            db.execute('CREATE TABLE IF NOT EXISTS cancellations (id TEXT, organization TEXT, created REAL NOT NULL, PRIMARY KEY(id,organization))')
            db.execute('CREATE TABLE IF NOT EXISTS runtime_quarantines (profile TEXT PRIMARY KEY, error_code TEXT NOT NULL, created REAL NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS runtime_release_confirmations (
                release_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, profile TEXT NOT NULL,
                request_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, terminal_row_hash TEXT NOT NULL,
                proof_hash TEXT NOT NULL, confirmed_at REAL NOT NULL, proof_json TEXT NOT NULL)''')
            db.execute("CREATE TRIGGER IF NOT EXISTS runtime_release_no_update BEFORE UPDATE ON runtime_release_confirmations BEGIN SELECT RAISE(ABORT, 'runtime release confirmations are append-only'); END")
            db.execute("CREATE TRIGGER IF NOT EXISTS runtime_release_no_delete BEFORE DELETE ON runtime_release_confirmations BEGIN SELECT RAISE(ABORT, 'runtime release confirmations are append-only'); END")
            db.execute('''CREATE TABLE IF NOT EXISTS runtime_release_captures (
                capture_hash TEXT PRIMARY KEY, capture_nonce TEXT UNIQUE NOT NULL, job_id TEXT NOT NULL,
                profile TEXT NOT NULL, request_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
                terminal_row_hash TEXT NOT NULL, captured_at REAL NOT NULL, capture_json TEXT NOT NULL)''')
            db.execute("CREATE TRIGGER IF NOT EXISTS runtime_capture_no_update BEFORE UPDATE ON runtime_release_captures BEGIN SELECT RAISE(ABORT, 'runtime release captures are append-only'); END")
            db.execute("CREATE TRIGGER IF NOT EXISTS runtime_capture_no_delete BEFORE DELETE ON runtime_release_captures BEGIN SELECT RAISE(ABORT, 'runtime release captures are append-only'); END")
            if 'cleanup_confirmed' not in {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}:
                db.execute('ALTER TABLE jobs ADD COLUMN cleanup_confirmed INTEGER NOT NULL DEFAULT 0')

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def public(row):
        result = {'id': row['id'], 'state': row['state'], 'stage': row['stage'], 'requestHash': row['request_hash'],
                  'cleanupConfirmed': bool(row['cleanup_confirmed'])}
        if row['state'] == 'SUCCEEDED' and row['result']:
            result['result'] = json.loads(row['result'])
        if row['error_code']:
            result['errorCode'] = row['error_code']
        return result

    def submit(self, body):
        digest = canonical_hash(body)
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE organization=? AND request_key=?',
                             (body['organizationId'], body['requestKey'])).fetchone()
            if row:
                if row['request_hash'] != digest:
                    raise GatewayError('IDEMPOTENCY_CONFLICT', 409)
                return self.public(row), False
            if db.execute('SELECT 1 FROM runtime_quarantines LIMIT 1').fetchone():
                raise GatewayError('RUNTIME_QUARANTINED', 503)
            live = db.execute("SELECT count(*) FROM jobs WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED')").fetchone()[0]
            if live >= 64:
                raise GatewayError('QUEUE_FULL', 429)
            job = str(uuid.uuid5(uuid.NAMESPACE_URL, 'bitovp-semantic:' + body['organizationId'] + ':' + body['requestKey']))
            cancelled = db.execute('SELECT 1 FROM cancellations WHERE id=? AND organization=?', (job, body['organizationId'])).fetchone() is not None
            db.execute('INSERT INTO jobs(id,organization,request_key,request_hash,stage,state,payload,created,cleanup_confirmed) VALUES(?,?,?,?,?,?,?,?,?)',
                       (job, body['organizationId'], body['requestKey'], digest, body['stage'], 'CANCELLED' if cancelled else 'QUEUED', canonical_json(body), time.time(), int(cancelled)))
            return self.public(db.execute('SELECT * FROM jobs WHERE id=?', (job,)).fetchone()), True

    def get(self, job, organization):
        with self.connection() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=? AND organization=?', (job, organization)).fetchone()
            if row is None:
                raise GatewayError('JOB_NOT_FOUND', 404)
            return self.public(row)

    def details(self, job):
        with self.connection() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job,)).fetchone()
            return dict(row) if row else None

    def next_queued(self):
        with self.connection() as db:
            row = db.execute("SELECT id FROM jobs WHERE state='QUEUED' ORDER BY created,id LIMIT 1").fetchone()
            return row['id'] if row else None

    def claim(self, job, owner):
        with self.connection() as db:
            return db.execute("UPDATE jobs SET owner=?,state='LOADING' WHERE id=? AND state='QUEUED' AND cancel_requested=0", (owner, job)).rowcount == 1

    def transition(self, job, owner, state):
        with self.connection() as db:
            return db.execute("UPDATE jobs SET state=? WHERE id=? AND owner=? AND state IN ('LOADING','RUNNING','VALIDATING') AND cancel_requested=0", (state, job, owner)).rowcount == 1

    def finish(self, job, owner, state, result=None, error_code=None, cleanup_confirmed=False):
        if state in ('SUCCEEDED', 'CANCELLED') and not cleanup_confirmed:
            return False
        with self.connection() as db:
            return db.execute("UPDATE jobs SET state=?,result=?,error_code=?,cleanup_confirmed=? WHERE id=? AND owner=? AND state IN ('LOADING','RUNNING','VALIDATING','CANCELLING') AND (?!='SUCCEEDED' OR cancel_requested=0)",
                              (state, canonical_json(result) if result else None, error_code, int(cleanup_confirmed), job, owner, state)).rowcount == 1

    def cancel(self, job, organization):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT OR IGNORE INTO cancellations(id,organization,created) VALUES(?,?,?)', (job, organization, time.time()))
            db.execute("UPDATE jobs SET cancel_requested=1,state=CASE WHEN state='QUEUED' THEN 'CANCELLED' ELSE 'CANCELLING' END,cleanup_confirmed=CASE WHEN state='QUEUED' THEN 1 ELSE 0 END WHERE id=? AND organization=? AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')", (job, organization))
        return self.get(job, organization)

    def recover(self):
        with self.connection() as db:
            rows = db.execute("SELECT * FROM jobs WHERE state IN ('LOADING','RUNNING','VALIDATING','CANCELLING') OR (state='FAILED' AND cleanup_confirmed=0 AND error_code IN ('CLEANUP_FAILED','RUNTIME_STOP_UNCONFIRMED','RESTARTED','RUNTIME_FAILED','LEASE_LOST'))").fetchall()
            for row in rows:
                profile = json.loads(row['payload'])['profile']
                if row['state'] == 'FAILED' and self._has_release(db, dict(row)):
                    continue
                db.execute('INSERT OR IGNORE INTO runtime_quarantines VALUES(?,?,?)', (profile, 'RESTARTED', time.time()))
            db.execute("UPDATE jobs SET state='FAILED',error_code='RESTARTED',owner=NULL,result=NULL,cleanup_confirmed=0 WHERE state IN ('LOADING','RUNNING','VALIDATING','CANCELLING')")

    @staticmethod
    def _capture(db, capture_hash, row):
        saved = db.execute('SELECT * FROM runtime_release_captures WHERE capture_hash=?', (capture_hash,)).fetchone()
        if saved is None:
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        capture = validate_runtime_capture(json.loads(saved['capture_json'], parse_constant=reject_nonfinite), row)
        expected = {'capture_hash': canonical_hash(capture), 'job_id': row['id'], 'profile': capture['bindings']['profile'],
                    'request_hash': row['request_hash'], 'payload_hash': capture['bindings']['payloadHash'],
                    'terminal_row_hash': capture['bindings']['terminalRowHash'], 'captured_at': capture['capturedAt']}
        if not valid_uuid(saved['capture_nonce']) or any(saved[key] != value for key, value in expected.items()):
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        return capture

    @classmethod
    def _release_capture_matches(cls, db, proof, row):
        capture = cls._capture(db, proof['captureHash'], row)
        stop_keys = {'observedStoppedAt', 'activeState', 'mainPid', 'cgroupEmpty', 'oldPidsGone'}
        before = [{key: value for key, value in unit.items() if key not in stop_keys} for unit in proof['units']]
        if (capture['units'] != before or capture['operatorUid'] != proof['operatorUid']
                or capture['bootId'] != proof['bootId'] or capture['quarantineHash'] != proof['quarantineHash']
                or any(unit['observedStoppedAt'] < capture['capturedAt'] for unit in proof['units'])):
            raise GatewayError('INVALID_RELEASE_PROOF', 422)
        return capture

    @classmethod
    def _has_release(cls, db, row):
        for saved in db.execute('SELECT * FROM runtime_release_confirmations WHERE job_id=?', (row['id'],)):
            try:
                proof = validate_runtime_release(json.loads(saved['proof_json'], parse_constant=reject_nonfinite), row)
                cls._release_capture_matches(db, proof, row)
                expected = {'release_id': proof['releaseId'], 'job_id': proof['jobId'], 'profile': proof['profile'],
                            'request_hash': proof['requestHash'], 'payload_hash': proof['payloadHash'],
                            'terminal_row_hash': proof['terminalRowHash'], 'proof_hash': canonical_hash(proof),
                            'confirmed_at': proof['confirmedAt']}
                if all(saved[key] == value for key, value in expected.items()):
                    return True
            except (ValueError, TypeError, KeyError, RecursionError, GatewayError):
                continue
        return False

    def confirm_runtime_release(self, proof):
        """Offline operator only; caller must have verified the owned OS stop evidence."""
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if not isinstance(proof, dict) or not valid_uuid(proof.get('jobId')):
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            found = db.execute('SELECT * FROM jobs WHERE id=?', (proof['jobId'],)).fetchone()
            if found is None:
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            row = dict(found)
            validate_runtime_release(proof, row)
            self._release_capture_matches(db, proof, row)
            quarantine = db.execute('SELECT * FROM runtime_quarantines WHERE profile=?', (proof['profile'],)).fetchone()
            if (quarantine is None or canonical_hash(dict(quarantine)) != proof['quarantineHash']
                    or quarantine['error_code'] not in (proof['errorCode'], 'RESTARTED')
                    or db.execute("SELECT 1 FROM jobs WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED') LIMIT 1").fetchone()):
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            db.execute('INSERT INTO runtime_release_confirmations VALUES(?,?,?,?,?,?,?,?,?)',
                       (proof['releaseId'], proof['jobId'], proof['profile'], proof['requestHash'], proof['payloadHash'],
                        proof['terminalRowHash'], canonical_hash(proof), proof['confirmedAt'], canonical_json(proof)))
            candidates = db.execute("SELECT * FROM jobs WHERE state='FAILED' AND cleanup_confirmed=0 AND error_code IN ('CLEANUP_FAILED','RUNTIME_STOP_UNCONFIRMED','RESTARTED','RUNTIME_FAILED','LEASE_LOST')").fetchall()
            cleared = all(self._has_release(db, dict(candidate)) for candidate in candidates
                          if json.loads(candidate['payload'])['profile'] == proof['profile'])
            if cleared:
                db.execute('DELETE FROM runtime_quarantines WHERE profile=? AND error_code=? AND created=?',
                           (quarantine['profile'], quarantine['error_code'], quarantine['created']))
            if dict(db.execute('SELECT * FROM jobs WHERE id=?', (row['id'],)).fetchone()) != row:
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            return {'releaseId': proof['releaseId'], 'jobId': proof['jobId'], 'profile': proof['profile'],
                    'proofHash': canonical_hash(proof), 'quarantineCleared': cleared}

    def retain_runtime_capture(self, capture):
        """Trusted offline capture only; imported files are never inserted by confirm."""
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            job = capture.get('bindings', {}).get('jobId') if isinstance(capture, dict) else None
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job,)).fetchone()
            if row is None:
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            row = dict(row)
            validate_runtime_capture(capture, row)
            quarantine = db.execute('SELECT * FROM runtime_quarantines WHERE profile=?', (capture['bindings']['profile'],)).fetchone()
            if (quarantine is None or canonical_hash(dict(quarantine)) != capture['quarantineHash']
                    or db.execute("SELECT 1 FROM jobs WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED') LIMIT 1").fetchone()):
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            digest = canonical_hash(capture)
            db.execute('INSERT INTO runtime_release_captures VALUES(?,?,?,?,?,?,?,?,?)',
                       (digest, str(uuid.uuid4()), row['id'], capture['bindings']['profile'], row['request_hash'],
                        capture['bindings']['payloadHash'], capture['bindings']['terminalRowHash'], capture['capturedAt'], canonical_json(capture)))
            return {'captureHash': digest}

    def load_runtime_capture(self, supplied):
        with self.connection() as db:
            if not isinstance(supplied, dict) or not isinstance(supplied.get('bindings'), dict):
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            row = db.execute('SELECT * FROM jobs WHERE id=?', (supplied['bindings'].get('jobId'),)).fetchone()
            if row is None:
                raise GatewayError('INVALID_RELEASE_PROOF', 422)
            return self._capture(db, canonical_hash(supplied), dict(row))

    def quarantine(self, profile, error_code):
        with self.connection() as db:
            db.execute('INSERT OR IGNORE INTO runtime_quarantines VALUES(?,?,?)', (profile, error_code, time.time()))

    def quarantined_profiles(self):
        with self.connection() as db:
            return [row['profile'] for row in db.execute('SELECT profile FROM runtime_quarantines ORDER BY profile')]


class Control:
    def __init__(self, store, job, owner, timeout, stopping):
        self.store, self.job, self.owner = store, job, owner
        self.deadline = time.monotonic() + timeout
        self.stopping = stopping

    def check(self):
        row = self.store.details(self.job)
        if row is None or row['owner'] != self.owner or row['state'] not in ACTIVE:
            raise GatewayError('LEASE_LOST')
        if row['cancel_requested'] or self.stopping.is_set():
            raise GatewayError('CANCELED')
        if time.monotonic() >= self.deadline:
            raise GatewayError('DEADLINE')


@contextmanager
def inference_lease(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise GatewayError('RESOURCE_BUSY') from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class Gateway:
    def __init__(self, root, organization, token_hash, registry, runtime, inference_lock=None, plamo_runtime=None):
        if not valid_uuid(organization) or not SHA.fullmatch(token_hash):
            raise ValueError('invalid configured tenant/token hash')
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.organization, self.token_hash = organization, token_hash
        self.registry, self.runtime = registry, runtime
        self.plamo_runtime = plamo_runtime
        self.store = Store(root / 'jobs.sqlite3')
        self.inference_lock = inference_lock or root / 'inference.lock'
        self.timeout_seconds = 900
        self.stopping = threading.Event()

    def authenticate(self, headers):
        authorization = headers.get('Authorization', '')
        if not isinstance(authorization, str) or not authorization.startswith('Bearer ') or len(authorization) > 1024:
            raise GatewayError('UNAUTHORIZED', 401)
        if not hmac.compare_digest(hashlib.sha256(authorization[7:].encode()).hexdigest(), self.token_hash):
            raise GatewayError('UNAUTHORIZED', 401)

    def availability(self, profile):
        if self.stopping.is_set():
            return 'GATEWAY_STOPPING', None
        if self.store.quarantined_profiles():
            return 'RUNTIME_QUARANTINED', None
        code = self.runtime.readiness(profile)
        gpu = self.runtime.gpu_capability(profile) if code == 'READY' else None
        if code == 'READY' and gpu is None:
            code = 'GPU_UNVERIFIED'
        if self.stopping.is_set():
            return 'GATEWAY_STOPPING', None
        if self.store.quarantined_profiles():
            return 'RUNTIME_QUARANTINED', None
        return code, gpu

    def route(self, method, path, headers, body=None):
        try:
            self.authenticate(headers)
            if method == 'GET' and path == '/health':
                quarantined = self.store.quarantined_profiles()
                accepting = not quarantined and not self.stopping.is_set()
                return 200, {'version': 'bitovp-semantic-gateway-v1', 'status': 'ok' if accepting else 'degraded', 'experimental': True,
                             'runtimeVersion': RUNTIME_VERSION, 'model': MODEL, 'modelDigest': MODEL_DIGEST,
                             'quarantinedProfiles': quarantined, 'acceptingJobs': accepting,
                             'profiles': list(PORTS), 'stages': [{k: stage[k] for k in ('promptVersion', 'schemaHash', 'maxOutputTokens')} | {'stage': name}
                                                               for name, stage in self.registry.stages.items()]}
            readiness = re.fullmatch(r'/readiness/(amd|nvidia)', path)
            if method == 'GET' and readiness:
                profile = readiness[1]
                code, gpu = self.availability(profile)
                return 200, {'version': 'bitovp-semantic-readiness-v2', 'profile': profile, 'organizationId': self.organization,
                             'scope': 'METADATA_ONLY', 'ready': code == 'READY', 'code': code,
                             **({'gpu': gpu} if code == 'READY' else {})}
            plamo_ready = re.fullmatch(r'/readiness/plamo/(amd|nvidia)/([a-f0-9]{64})', path)
            if method == 'GET' and plamo_ready:
                profile, expected_hash = plamo_ready[1], plamo_ready[2]
                identity = None
                if self.stopping.is_set():
                    code = 'GATEWAY_STOPPING'
                elif self.store.quarantined_profiles():
                    code = 'RUNTIME_QUARANTINED'
                elif self.plamo_runtime is None:
                    code = 'MODEL_NOT_INSTALLED'
                else:
                    code, identity = self.plamo_runtime.metadata(profile, expected_hash)
                    if self.stopping.is_set():
                        code, identity = 'GATEWAY_STOPPING', None
                    elif self.store.quarantined_profiles():
                        code, identity = 'RUNTIME_QUARANTINED', None
                return 200, {'version': 'bitovp-plamo-readiness-v1', 'profile': profile, 'scope': 'METADATA_ONLY',
                             'ready': code == 'READY', 'code': code, 'manifestHash': expected_hash if code == 'READY' else None,
                             'identity': identity if code == 'READY' else None}
            if method == 'POST' and path == '/v1/plamo-caption-jobs':
                self.validate_plamo(body)
                job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'bitovp-semantic:' + body['organizationId'] + ':' + body['requestKey']))
                if self.store.details(job_id) is not None:
                    row, _ = self.store.submit(body)
                    return 200, row
                code, _ = self.availability(body['profile'])
                if code != 'READY':
                    raise GatewayError(code, 503)
                if self.stopping.is_set():
                    raise GatewayError('GATEWAY_STOPPING', 503)
                if self.store.quarantined_profiles():
                    raise GatewayError('RUNTIME_QUARANTINED', 503)
                if self.plamo_runtime is None:
                    raise GatewayError('MODEL_NOT_INSTALLED', 503)
                code, _ = self.plamo_runtime.metadata(body['profile'], body['manifestHash'])
                if code != 'READY':
                    raise GatewayError(code, 503)
                row, created = self.store.submit(body)
                return (202 if created else 200), row
            match = re.fullmatch(r'/v1/plamo-caption-jobs/([a-f0-9-]{36})(/cancel)?', path)
            if match and valid_uuid(match[1]):
                if method == 'GET' and not match[2]:
                    row = self.store.get(match[1], self.organization)
                    if row['stage'] != 'LOCAL_PLAMO_CAPTION_JA_V1':
                        raise GatewayError('JOB_NOT_FOUND', 404)
                    return 200, row
                if method == 'POST' and match[2] and body == {}:
                    row = self.store.details(match[1])
                    if row and (row['organization'] != self.organization or row['stage'] != 'LOCAL_PLAMO_CAPTION_JA_V1'):
                        raise GatewayError('JOB_NOT_FOUND', 404)
                    return 200, self.store.cancel(match[1], self.organization)
            if method == 'POST' and path == '/v1/semantic-jobs':
                self.registry.validate(body, self.organization)
                # Exact idempotent reads remain available during quarantine or
                # hardware loss, without admitting another job or retrying it.
                job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'bitovp-semantic:' + body['organizationId'] + ':' + body['requestKey']))
                if self.store.details(job_id) is not None:
                    row, _ = self.store.submit(body)
                    return 200, row
                code, _ = self.availability(body['profile'])
                if code != 'READY':
                    raise GatewayError(code, 503)
                row, created = self.store.submit(body)
                return (202 if created else 200), row
            match = re.fullmatch(r'/v1/semantic-jobs/([a-f0-9-]{36})(/cancel)?', path)
            if match and valid_uuid(match[1]):
                if method == 'GET' and not match[2]:
                    return 200, self.store.get(match[1], self.organization)
                if method == 'POST' and match[2] and body == {}:
                    return 200, self.store.cancel(match[1], self.organization)
            raise GatewayError('NOT_FOUND', 404)
        except GatewayError as error:
            return error.status, {'error': {'code': error.code}}

    def validate_plamo(self, body):
        fields = {'version', 'requestKey', 'organizationId', 'profile', 'stage', 'prompt', 'inputHash', 'promptVersion', 'schemaHash', 'manifestHash'}
        if not isinstance(body, dict) or set(body) != fields:
            raise GatewayError('INVALID_REQUEST', 422)
        if body['organizationId'] != self.organization:
            raise GatewayError('TENANT_FORBIDDEN', 403)
        if (body['version'] != 'bitovp-plamo-caption-job-v1' or not valid_uuid(body['requestKey'])
                or not isinstance(body['profile'], str) or body['profile'] not in PORTS or body['stage'] != 'LOCAL_PLAMO_CAPTION_JA_V1'
                or body['promptVersion'] != 'plamo-pfml3-caption-v1'
                or any(not isinstance(body[key], str) or not SHA.fullmatch(body[key]) for key in ('schemaHash', 'inputHash', 'manifestHash'))
                or not isinstance(body['prompt'], str) or not body['prompt'].strip() or len(body['prompt'].encode()) > 5632):
            raise GatewayError('INVALID_REQUEST', 422)

    def run_plamo(self, row, owner, control, started):
        from plamo_runtime import PlamoError
        job, body = row['id'], json.loads(row['payload'])
        confirmed = True
        try:
            self.validate_plamo(body)
            with inference_lease(self.inference_lock):
                control.check()
                if self.store.quarantined_profiles():
                    raise GatewayError('RUNTIME_QUARANTINED')
                if self.plamo_runtime is None:
                    raise GatewayError('MODEL_NOT_INSTALLED')
                code, _ = self.availability(body['profile'])
                if code != 'READY':
                    raise GatewayError(code, 503)
                if any(self.runtime.loaded(profile) for profile in PORTS):
                    raise GatewayError('RESOURCE_BUSY')
                control.check()
                if not self.store.transition(job, owner, 'RUNNING'):
                    control.check()
                try:
                    content, identity, ready_ms, stats, placement = self.plamo_runtime.run(body['profile'], body, control)
                except PlamoError as error:
                    if error.code in ('CLEANUP_FAILED', 'RUNTIME_STOP_UNCONFIRMED'):
                        confirmed = False
                        try: self.store.quarantine(body['profile'], error.code)
                        except Exception:
                            self.stopping.set()
                            raise
                    raise GatewayError(error.code)
                control.check()
                if not self.store.transition(job, owner, 'VALIDATING'):
                    control.check()
                receipt = {'version': 'bitovp-plamo-caption-receipt-v1', 'identity': identity, 'profile': body['profile'],
                           'manifestHash': body['manifestHash'], 'inputHash': body['inputHash'],
                           'promptHash': hashlib.sha256(body['prompt'].encode()).hexdigest(), 'schemaHash': body['schemaHash'],
                           'promptVersion': body['promptVersion'], 'context': 8192, 'maxOutputTokens': 1536, 'thinking': False,
                           'requestHash': row['request_hash'], 'elapsedMs': round((time.monotonic() - started) * 1000),
                           'startupReadyMs': ready_ms, 'apiStats': stats, 'placement': placement,
                           'cleanupConfirmed': True, 'runtimeProcessStopped': True, 'schemaVerified': False}
                if not self.store.finish(job, owner, 'SUCCEEDED', {'content': content, 'receipt': receipt}, cleanup_confirmed=True):
                    control.check()
        except GatewayError as error:
            cancelled = error.code == 'CANCELED' and confirmed
            self.store.finish(job, owner, 'CANCELLED' if cancelled else 'FAILED', None, None if cancelled else error.code, cleanup_confirmed=confirmed)
        except Exception:
            self.store.finish(job, owner, 'FAILED', None, 'RUNTIME_FAILED', cleanup_confirmed=confirmed)
        return True

    def run_one(self):
        job = self.store.next_queued()
        if job is None or self.stopping.is_set():
            return False
        owner = str(uuid.uuid4())
        if not self.store.claim(job, owner):
            return False
        row = self.store.details(job)
        body = json.loads(row['payload'])
        control = Control(self.store, job, owner, self.timeout_seconds, self.stopping)
        started = time.monotonic()
        if body.get('stage') == 'LOCAL_PLAMO_CAPTION_JA_V1':
            return self.run_plamo(row, owner, control, started)
        attempted, released = False, False
        try:
            stage = self.registry.validate(body, self.organization)
            with inference_lease(self.inference_lock):
                control.check()
                if self.store.quarantined_profiles():
                    raise GatewayError('RUNTIME_QUARANTINED')
                self.runtime.identity(body['profile'])
                code, _ = self.availability(body['profile'])
                if code != 'READY':
                    raise GatewayError(code, 503)
                if any(self.runtime.loaded(profile) for profile in PORTS):
                    raise GatewayError('RESOURCE_BUSY')
                control.check()
                if not self.store.transition(job, owner, 'RUNNING'):
                    control.check()
                payload = {'model': MODEL, 'messages': [{'role': 'user', 'content': body['prompt']}],
                           'stream': False, 'think': False, 'keep_alive': '2m', 'format': stage['schema'],
                           'options': {'num_ctx': 8192, 'num_predict': stage['maxOutputTokens'], 'temperature': 0, 'seed': 41}}
                try:
                    attempted = True
                    response = self.runtime.chat(body['profile'], payload, control)
                    control.check()
                    if not self.store.transition(job, owner, 'VALIDATING'):
                        control.check()
                    message = response.get('message')
                    content = message.get('content') if isinstance(message, dict) else None
                    if not isinstance(content, str) or len(content.encode()) > 192 * 1024:
                        raise GatewayError('OUTPUT_INVALID')
                    try:
                        decoded = json.loads(content, parse_constant=reject_nonfinite)
                    except (ValueError, RecursionError):
                        raise GatewayError('OUTPUT_INVALID')
                    if not isinstance(decoded, dict) or response.get('done_reason') != 'stop':
                        raise GatewayError('OUTPUT_INVALID')
                    placement = self.runtime.placement(body['profile'])
                    api_stats = {'doneReason': response['done_reason']}
                    for output, source in [('promptEvalCount', 'prompt_eval_count'), ('evalCount', 'eval_count'),
                                           ('loadDurationNs', 'load_duration'), ('promptEvalDurationNs', 'prompt_eval_duration'),
                                           ('evalDurationNs', 'eval_duration')]:
                        if type(response.get(source)) is not int or response[source] < 0:
                            raise GatewayError('OUTPUT_INVALID')
                        api_stats[output] = response[source]
                finally:
                    try:
                        self.runtime.unload(body['profile'])
                    except Exception as error:
                        code = error.code if isinstance(error, GatewayError) else 'CLEANUP_FAILED'
                        try:
                            # Persist the fence before releasing the shared inference lock.
                            self.store.quarantine(body['profile'], code)
                        except Exception:
                            self.stopping.set()
                            raise
                        raise
                    released = True
                control.check()
                receipt = {'version': 'bitovp-semantic-receipt-v1', 'profile': body['profile'], 'model': MODEL,
                           'modelDigest': MODEL_DIGEST, 'runtimeVersion': RUNTIME_VERSION,
                           'inputHash': body['inputHash'], 'promptHash': hashlib.sha256(body['prompt'].encode()).hexdigest(),
                           'schemaHash': body['schemaHash'], 'promptVersion': body['promptVersion'],
                           'context': 8192, 'maxOutputTokens': stage['maxOutputTokens'], 'thinking': False,
                           'schemaVerified': False, 'requestHash': row['request_hash'],
                           'elapsedMs': round((time.monotonic() - started) * 1000), 'apiStats': api_stats,
                           'placement': [{'name': p['name'], 'size': p['size'], 'sizeVram': p['size_vram'],
                                          'contextLength': p['context_length']} for p in placement], 'cleanupConfirmed': True}
                if not self.store.finish(job, owner, 'SUCCEEDED', {'content': content, 'receipt': receipt}, cleanup_confirmed=True):
                    control.check()
        except GatewayError as error:
            confirmed = (not attempted or released) and error.code not in ('CLEANUP_FAILED', 'RUNTIME_STOP_UNCONFIRMED', 'LEASE_LOST')
            cancelled = error.code == 'CANCELED' and confirmed
            self.store.finish(job, owner, 'CANCELLED' if cancelled else 'FAILED', None,
                              None if cancelled else error.code, cleanup_confirmed=confirmed)
        except Exception:
            self.store.finish(job, owner, 'FAILED', None, 'RUNTIME_FAILED', cleanup_confirmed=not attempted or released)
        return True


class FixedRuntime:
    """No environment proxy, redirects, arbitrary hosts, downloads or tool calls."""
    def __init__(self):
        self.unconfirmed_profiles = set()
        self.gpu_probe = RuntimeGpuCapability()
        self.gpu_observations = {}
        self.gpu_probe_lock = threading.Lock()

    def gpu_capability(self, profile):
        # One bounded discovery per profile per five seconds, including failures.
        with self.gpu_probe_lock:
            previous = self.gpu_observations.get(profile)
            now = time.monotonic()
            if previous is not None and 0 <= now - previous[0] < 5:
                return previous[1]
            result = self.gpu_probe.read(profile)
            self.gpu_observations[profile] = (time.monotonic(), result)
            return result

    @staticmethod
    def request(profile, route, payload=None, control=None):
        if profile not in PORTS or route not in {'/api/version', '/api/tags', '/api/ps', '/api/chat', '/api/generate'}:
            raise GatewayError('NOT_CAPABLE')
        connection = http.client.HTTPConnection('127.0.0.1', PORTS[profile], timeout=5)
        wire, result = {}, {}
        cancelling = threading.Event()
        wire_lock = threading.Lock()
        def send():
            try:
                connection.connect()
                with wire_lock:
                    if cancelling.is_set():
                        raise GatewayError('CANCELED')
                    wire['socket'] = connection.sock
                    connection.sock.settimeout(900 if control else 10)
                data = canonical_json(payload).encode() if payload is not None else None
                connection.request('POST' if data is not None else 'GET', route, body=data,
                                   headers={'Content-Type': 'application/json', 'Connection': 'close'})
                response = connection.getresponse()
                raw = response.read(2 * 1024 * 1024 + 1)
                if response.status != 200 or len(raw) > 2 * 1024 * 1024:
                    raise GatewayError('RUNTIME_FAILED')
                value = json.loads(raw, parse_constant=reject_nonfinite)
                if not isinstance(value, dict) or value.get('error'):
                    raise GatewayError('RUNTIME_FAILED')
                result['value'] = value
            except Exception as error:
                result['error'] = error
            finally:
                connection.close()
        if control is None:
            send()
        else:
            thread = threading.Thread(target=send, daemon=True)
            thread.start()
            try:
                while thread.is_alive():
                    control.check()
                    thread.join(.1)
            except GatewayError:
                cancelling.set()
                with wire_lock:
                    owned_socket = wire.get('socket')
                    if owned_socket:
                        try:
                            owned_socket.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                thread.join(6)
                if thread.is_alive():
                    raise GatewayError('RUNTIME_STOP_UNCONFIRMED')
                raise
        if 'error' in result:
            raise GatewayError('RUNTIME_FAILED') from result['error']
        return result['value']

    def identity(self, profile):
        if self.request(profile, '/api/version').get('version') != RUNTIME_VERSION:
            raise GatewayError('NOT_CAPABLE')
        rows = self.request(profile, '/api/tags').get('models', [])
        if not any(row.get('name') == MODEL and row.get('digest') == MODEL_DIGEST for row in rows):
            raise GatewayError('NOT_CAPABLE')

    def readiness(self, profile):
        """Read registered metadata only; never load, infer, unload, or probe other ports."""
        try:
            version = self.request(profile, '/api/version').get('version')
            if not isinstance(version, str):
                return 'RUNTIME_UNAVAILABLE'
            if version != RUNTIME_VERSION:
                return 'RUNTIME_VERSION_MISMATCH'
            rows = self.request(profile, '/api/tags').get('models')
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                return 'RUNTIME_UNAVAILABLE'
            if not any(row.get('name') == MODEL and row.get('digest') == MODEL_DIGEST for row in rows):
                return 'MODEL_MISMATCH'
            return 'READY'
        except Exception:
            # HTTP/TLS/JSON failures and backend error bodies are not public diagnostics.
            return 'RUNTIME_UNAVAILABLE'

    def loaded(self, profile):
        rows = self.request(profile, '/api/ps').get('models')
        if not isinstance(rows, list):
            raise GatewayError('RUNTIME_FAILED')
        return rows

    def chat(self, profile, payload, control):
        self.unconfirmed_profiles.add(profile)
        response = self.request(profile, '/api/chat', payload, control)
        if response.get('model') != MODEL or response.get('done') is not True:
            raise GatewayError('RUNTIME_STOP_UNCONFIRMED')
        self.unconfirmed_profiles.discard(profile)
        return response

    def placement(self, profile):
        rows = self.loaded(profile)
        if (len(rows) != 1 or rows[0].get('name') != MODEL or rows[0].get('digest') != MODEL_DIGEST
                or rows[0].get('context_length') != 8192 or type(rows[0].get('size_vram')) is not int
                or rows[0]['size_vram'] <= 0 or type(rows[0].get('size')) is not int):
            raise GatewayError('GPU_PLACEMENT_UNVERIFIED')
        return rows

    def unload(self, profile):
        try:
            # /api/ps may be empty while an accepted chat is still loading its runner.
            # Always attempt the owned unload, but its ACK cannot acknowledge that chat.
            response = self.request(profile, '/api/generate', {'model': MODEL, 'keep_alive': 0, 'stream': False})
            if response.get('model') != MODEL or response.get('done') is not True or response.get('done_reason') != 'unload':
                raise GatewayError('CLEANUP_FAILED')
            if profile in self.unconfirmed_profiles:
                raise GatewayError('RUNTIME_STOP_UNCONFIRMED')
            deadline = time.monotonic() + 30
            while self.loaded(profile):
                if time.monotonic() >= deadline:
                    raise GatewayError('CLEANUP_FAILED')
                time.sleep(.2)
        except Exception as error:
            code = 'RUNTIME_STOP_UNCONFIRMED' if isinstance(error, GatewayError) and error.code == 'RUNTIME_STOP_UNCONFIRMED' else 'CLEANUP_FAILED'
            raise GatewayError(code) from error


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *_):
        pass  # Never put prompts, credentials, content or URLs into request logs.

    def dispatch(self):
        try:
            if len(self.headers.get_all('Authorization', [])) != 1:
                raise GatewayError('UNAUTHORIZED', 401)
            self.server.gateway.authenticate(self.headers)
            body = None
            if self.command == 'POST':
                length = self.headers.get_all('Content-Length', [])
                if (len(length) != 1 or not re.fullmatch(r'\d{1,8}', length[0])
                        or self.headers.get('Transfer-Encoding') is not None):
                    raise GatewayError('INVALID_REQUEST', 400)
                size = int(length[0])
                if size > MAX_BODY:
                    raise GatewayError('BODY_TOO_LARGE', 413)
                if self.headers.get('Content-Type', '').split(';', 1)[0].strip() != 'application/json':
                    raise GatewayError('INVALID_REQUEST', 400)
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise GatewayError('INVALID_REQUEST', 400)
                try:
                    body = json.loads(raw, parse_constant=reject_nonfinite)
                except (ValueError, RecursionError):
                    raise GatewayError('INVALID_REQUEST', 400)
            status, value = self.server.gateway.route(self.command, self.path, self.headers, body)
        except GatewayError as error:
            status, value = error.status, {'error': {'code': error.code}}
        except Exception:
            status, value = 500, {'error': {'code': 'GATEWAY_FAILED'}}
        encoded = canonical_json(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (OSError, ssl.SSLError):
            pass

    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_OPTIONS = dispatch


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, gateway, context):
        self.gateway, self.context = gateway, context
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, RequestHandler)
        self.timeout = .5

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def finish_request(self, request, address):
        request.settimeout(10)
        try:
            with self.context.wrap_socket(request, server_side=True) as secured:
                self.RequestHandlerClass(secured, address, self)
        except (OSError, ssl.SSLError):
            pass

    def handle_error(self, *_):
        print('{"event":"HTTP_HANDLER_FAILED"}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    config = json.loads((directory / 'config.json').read_text())
    if set(config) != {'version', 'organizationId', 'tokenSha256'} or config['version'] != 'bitovp-semantic-gateway-config-v1':
        raise ValueError('invalid private gateway configuration')
    for name in ['config.json', 'server-key.pem']:
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError('private gateway files must be regular mode600 files')
    registry = Registry(json.loads((directory / 'stages.json').read_text()))
    state = directory / 'state'
    state.mkdir(exist_ok=True, mode=0o700)
    with (state / 'gateway.lock').open('a') as instance:
        fcntl.flock(instance, fcntl.LOCK_EX | fcntl.LOCK_NB)
        from plamo_runtime import InstalledPlamoRuntime
        gateway = Gateway(state, config['organizationId'], config['tokenSha256'], registry,
                          FixedRuntime(), directory.parent / 'locks/inference.lock', InstalledPlamoRuntime(directory))
        gateway.store.recover()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(directory / 'gateway-ca.pem', directory / 'server-key.pem')
        server = GatewayServer(('192.168.68.62', 11437), gateway, context)
        def stop(*_):
            gateway.stopping.set()
        for sig in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(sig, stop)
        def work():
            while not gateway.stopping.is_set():
                if not gateway.run_one():
                    gateway.stopping.wait(.2)
        worker = threading.Thread(target=work, daemon=True)
        worker.start()
        print('{"event":"gateway-ready","scope":"experimental-local-story"}', flush=True)
        try:
            while not gateway.stopping.is_set():
                server.handle_request()
        finally:
            gateway.stopping.set()
            server.server_close()
            worker.join(80)
            if worker.is_alive():
                raise RuntimeError('owned operation did not stop before shutdown')


if __name__ == '__main__':
    main()
