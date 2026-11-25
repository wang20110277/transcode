import type { AcpPermissionOption } from './protocol.js';

/**
 * The choices offered to the host. "Always" is offered only when the
 * question came from the mode: a rule remembered now ranks below a
 * configured `ask` rule, so there it would do nothing.
 */
export function acpPermissionOptions(offerAlways: boolean): AcpPermissionOption[] {
  const once: AcpPermissionOption = { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' };
  const reject: AcpPermissionOption = { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' };
  if (!offerAlways) return [once, reject];
  return [
    once,
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    reject,
  ];
}

export type PermissionChoice = 'once' | 'always' | 'reject' | 'reject_always';

/** What the host's answer means. Anything unknown, or a cancelled question, is a plain reject. */
export function permissionChoice(optionId: string | undefined): PermissionChoice {
  switch (optionId) {
    case 'allow_once':
      return 'once';
    case 'allow_always':
    case 'allow_session':
    case 'approve_for_session':
      return 'always';
    case 'reject_always':
      return 'reject_always';
    default:
      return 'reject';
  }
}
