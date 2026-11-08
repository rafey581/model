/**
 * Socket.io rooms this connection should leave because they are not the match now open.
 *
 * Joining a match only called `socket.join`. The previous practice room stayed joined,
 * and the bot's later shot was delivered to the table the player had since started.
 * Every name returned here is a `match:` room other than the one being entered.
 * Passing no active match returns every match room, which is the leave-the-table case.
 */
export function foreignMatchRooms(joined: Iterable<string>, activeMatchId: string | null): string[] {
  const keep = activeMatchId ? `match:${activeMatchId}` : null
  const rooms: string[] = []
  for (const room of joined) {
    if (!room.startsWith('match:') || room === keep) continue
    rooms.push(room)
  }
  return rooms
}

/** The match id encoded in a `match:` room name. */
export function matchIdFromRoom(room: string): string {
  return room.slice('match:'.length)
}
