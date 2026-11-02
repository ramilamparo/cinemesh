/**
 * The room's name: the host picks it on Home before hosting; the invite carries it (`Join "<name>" on Cinemesh`) and
 * viewers get it from the host. Invites keep at most 48 UTF-8 bytes of it (INVITE_NAME_MAX_BYTES), so the field
 * allows 48 characters.
 */
export const ROOM_NAME_MAX = 48

/** What a room is called when the host leaves the name empty (or an older UI sends none). */
export function defaultRoomName(displayName: string): string {
  return `${displayName}'s room`
}

/** The name to use: `name` trimmed and cut to ROOM_NAME_MAX, or the default when it is empty. */
export function roomName(name: string | undefined, displayName: string): string {
  const trimmed = (name ?? '').trim().slice(0, ROOM_NAME_MAX)
  return trimmed || defaultRoomName(displayName)
}
