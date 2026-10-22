import { CodedError } from '../../shared/result.js'
import { extractInvite, inviteCode, inviteLink } from '../../shared/invite-link.js'
import { KEY_BYTES, blake2b, z32Decode, z32Encode } from './crypto.js'
import { NET_ERRORS } from './errors.js'
import { truncateUtf8 } from './wire.js'

// Invite v1 (plan §4.1): [ver][flags][roomSecret 32][hostKey 32][relayKey 32?][nameLen 1 + name ≤ 48?][checksum 2]
// The checksum is the first 2 bytes of BLAKE2b-128 over everything before it; it catches typos and
// truncation, not tampering (whoever holds an invite holds the room secret anyway).

export const INVITE_VERSION = 1
export const INVITE_NAME_MAX_BYTES = 48
/** Where people without the app get it. Set for real when releases are published (M9). */
export const DOWNLOAD_URL = 'https://github.com/watch-together-p2p/watch-together-p2p/releases/latest'

const FLAG_RELAY = 0b01
const FLAG_NAME = 0b10
const KNOWN_FLAGS = FLAG_RELAY | FLAG_NAME
const CHECKSUM_BYTES = 2
const MIN_BYTES = 2 + KEY_BYTES * 2 + CHECKSUM_BYTES

export interface Invite {
  roomSecret: Buffer
  hostKey: Buffer
  relayKey: Buffer | null
  /** '' when the invite carries no name */
  name: string
}

export function encodeInvite(invite: Invite): string {
  checkKey(invite.roomSecret, 'roomSecret')
  checkKey(invite.hostKey, 'hostKey')
  if (invite.relayKey) checkKey(invite.relayKey, 'relayKey')
  const name = truncateUtf8(invite.name.trim(), INVITE_NAME_MAX_BYTES)
  const flags = (invite.relayKey ? FLAG_RELAY : 0) | (name.byteLength > 0 ? FLAG_NAME : 0)
  const parts: Buffer[] = [Buffer.from([INVITE_VERSION, flags]), invite.roomSecret, invite.hostKey]
  if (invite.relayKey) parts.push(invite.relayKey)
  if (name.byteLength > 0) parts.push(Buffer.from([name.byteLength]), name)
  const body = Buffer.concat(parts)
  return z32Encode(Buffer.concat([body, checksum(body)]))
}

/**
 * Accepts a cinemesh:// link or a bare code (case and surrounding whitespace ignored). Throws a
 * CodedError with one of NET_ERRORS.invite* when the text is not a valid v1 invite.
 */
export function decodeInvite(text: string): Invite {
  const trimmed = text.trim().toLowerCase()
  const code = inviteCode(trimmed) ?? inviteCode(extractInvite(trimmed, { joinLines: true }) ?? '') ?? trimmed
  const bytes = z32Decode(code)
  if (bytes === null || code.length === 0) throw inviteError(NET_ERRORS.inviteEncoding, 'This is not an invite code.')
  if (bytes.byteLength < MIN_BYTES) throw inviteError(NET_ERRORS.inviteLength, 'The invite is incomplete.')
  if (bytes[0] !== INVITE_VERSION) {
    throw inviteError(NET_ERRORS.inviteVersion, 'The invite was made by a different version of the app.')
  }
  const body = bytes.subarray(0, bytes.byteLength - CHECKSUM_BYTES)
  if (!checksum(body).equals(bytes.subarray(body.byteLength))) {
    throw inviteError(NET_ERRORS.inviteChecksum, 'The invite is damaged; copy it again.')
  }
  const flags = bytes[1] ?? 0
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw inviteError(NET_ERRORS.inviteVersion, 'The invite was made by a newer version of the app.')
  }

  let offset = 2
  const take = (n: number): Buffer => {
    if (offset + n > body.byteLength) throw inviteError(NET_ERRORS.inviteLength, 'The invite is incomplete.')
    const out = Buffer.from(body.subarray(offset, offset + n))
    offset += n
    return out
  }
  const roomSecret = take(KEY_BYTES)
  const hostKey = take(KEY_BYTES)
  const relayKey = flags & FLAG_RELAY ? take(KEY_BYTES) : null
  let name = ''
  if (flags & FLAG_NAME) {
    const len = take(1)[0] ?? 0
    if (len === 0 || len > INVITE_NAME_MAX_BYTES) throw inviteError(NET_ERRORS.inviteLength, 'The invite is malformed.')
    name = take(len).toString('utf8')
  }
  if (offset !== body.byteLength) throw inviteError(NET_ERRORS.inviteLength, 'The invite has extra data.')
  return { roomSecret, hostKey, relayKey, name }
}

export interface InviteText {
  code: string
  link: string
  text: string
}

/** What "Copy invite" puts on the clipboard: name, link, bare code, download URL, one-line install steps. */
export function inviteText(invite: Invite): InviteText {
  const code = encodeInvite(invite)
  const link = inviteLink(code)
  const title = invite.name.trim() ? `Join "${invite.name.trim()}" on Cinemesh` : 'Join me on Cinemesh'
  const text = [
    title,
    '',
    `Link: ${link}`,
    `Code: ${code}`,
    '',
    `No app yet? Download it from ${DOWNLOAD_URL}`,
    '- Windows: run the Setup .exe, then click the link (or paste the code on the Home screen).',
    '- macOS: open the .dmg, drag the app to Applications, open it, then allow it under System Settings > Privacy & Security > Open Anyway.',
    '- Linux: install the .deb, or make the .AppImage executable, start it and choose Settings > Register invite links.',
  ].join('\n')
  return { code, link, text }
}

function checksum(body: Uint8Array): Buffer {
  return blake2b(body, 16).subarray(0, CHECKSUM_BYTES)
}

function checkKey(key: Uint8Array, label: string): void {
  if (key.byteLength !== KEY_BYTES) throw new Error(`${label} must be ${String(KEY_BYTES)} bytes`)
}

function inviteError(code: string, message: string): CodedError {
  return new CodedError(code, message)
}
