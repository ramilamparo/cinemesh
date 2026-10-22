// Error codes raised or reported by src/core/net. The UI maps them to text via diagnostics.hintFor().

export const NET_ERRORS = {
  inviteEncoding: 'WTP_INVITE_ENCODING',
  inviteLength: 'WTP_INVITE_LENGTH',
  inviteVersion: 'WTP_INVITE_VERSION',
  inviteChecksum: 'WTP_INVITE_CHECKSUM',
  authFailed: 'WTP_AUTH_FAILED',
  authTimeout: 'WTP_AUTH_TIMEOUT',
  protocol: 'WTP_PROTOCOL',
  frameTooLarge: 'WTP_FRAME_TOO_LARGE',
  denied: 'WTP_DENIED',
  kicked: 'WTP_KICKED',
  roomEnded: 'WTP_ROOM_ENDED',
  notAdmitted: 'WTP_NOT_ADMITTED',
  notHost: 'WTP_NOT_HOST',
  closed: 'WTP_ROOM_CLOSED',
  blobNotFound: 'WTP_BLOB_NOT_FOUND',
  blobHash: 'WTP_BLOB_HASH',
  relayUnreachable: 'WTP_RELAY_UNREACHABLE',
} as const

export type NetErrorCode = (typeof NET_ERRORS)[keyof typeof NET_ERRORS]

export function errorCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') return e.code
  return null
}
