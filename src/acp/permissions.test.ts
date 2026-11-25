import { describe, expect, test } from 'bun:test';
import { acpPermissionOptions, permissionChoice } from './permissions.js';

describe('acpPermissionOptions', () => {
  test('offers "always" only when remembering a rule can have an effect', () => {
    expect(acpPermissionOptions(true).map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);
    expect(acpPermissionOptions(false).map((option) => option.optionId)).toEqual(['allow_once', 'reject_once']);
  });

  test('every option carries the kind of its answer', () => {
    for (const option of acpPermissionOptions(true)) expect(option.kind).toBe(option.optionId);
  });
});

describe('permissionChoice', () => {
  test('maps what the host answered onto what to do', () => {
    expect(permissionChoice('allow_once')).toBe('once');
    expect(permissionChoice('allow_always')).toBe('always');
    expect(permissionChoice('allow_session')).toBe('always');
    expect(permissionChoice('approve_for_session')).toBe('always');
    expect(permissionChoice('reject_always')).toBe('reject_always');
    expect(permissionChoice('reject_once')).toBe('reject');
    expect(permissionChoice('something_else')).toBe('reject');
    expect(permissionChoice(undefined)).toBe('reject');
  });
});
