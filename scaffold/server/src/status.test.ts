import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStatus, isValidDisplayStatus, type DisplayStatus } from './status.js';

test('mergeStatus - forward progression', () => {
  assert.equal(mergeStatus('queued', 'sent'), 'sent');
  assert.equal(mergeStatus('queued', 'delivered'), 'delivered');
  assert.equal(mergeStatus('queued', 'failed'), 'failed');
  assert.equal(mergeStatus('sent', 'delivered'), 'delivered');
  assert.equal(mergeStatus('sent', 'failed'), 'failed');
});

test('mergeStatus - terminal states never regress', () => {
  assert.equal(mergeStatus('delivered', 'sent'), 'delivered');
  assert.equal(mergeStatus('delivered', 'queued'), 'delivered');
  assert.equal(mergeStatus('delivered', 'failed'), 'delivered');
  assert.equal(mergeStatus('failed', 'sent'), 'failed');
  assert.equal(mergeStatus('failed', 'queued'), 'failed');
  assert.equal(mergeStatus('failed', 'delivered'), 'failed');
});

test('mergeStatus - identical status stays same', () => {
  assert.equal(mergeStatus('queued', 'queued'), 'queued');
  assert.equal(mergeStatus('sent', 'sent'), 'sent');
  assert.equal(mergeStatus('delivered', 'delivered'), 'delivered');
  assert.equal(mergeStatus('failed', 'failed'), 'failed');
});

test('isValidDisplayStatus', () => {
  assert.equal(isValidDisplayStatus('queued'), true);
  assert.equal(isValidDisplayStatus('sent'), true);
  assert.equal(isValidDisplayStatus('delivered'), true);
  assert.equal(isValidDisplayStatus('failed'), true);
  assert.equal(isValidDisplayStatus('unknown'), false);
  assert.equal(isValidDisplayStatus(''), false);
});
