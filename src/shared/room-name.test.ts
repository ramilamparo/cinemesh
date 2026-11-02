import { describe, expect, it } from 'vitest'
import { ROOM_NAME_MAX, defaultRoomName, roomName } from './room-name'

describe('roomName', () => {
  it('is "<display name>\'s room" when the host gives none, or only spaces', () => {
    expect(defaultRoomName('Ram')).toBe("Ram's room")
    expect(roomName(undefined, 'Ram')).toBe("Ram's room")
    expect(roomName('', 'Ram')).toBe("Ram's room")
    expect(roomName('   ', 'Ram')).toBe("Ram's room")
  })

  it("is the host's name trimmed and cut to ROOM_NAME_MAX", () => {
    expect(roomName('  Movie night ', 'Ram')).toBe('Movie night')
    expect(roomName('x'.repeat(ROOM_NAME_MAX + 10), 'Ram')).toBe('x'.repeat(ROOM_NAME_MAX))
  })
})
