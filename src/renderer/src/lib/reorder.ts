import { useState } from 'react'

/** What a list row spreads to be dragged to a new place; `data-drop` marks where the dragged row would land. */
export interface DragRowProps {
  draggable: boolean
  'data-dragging': 'true' | undefined
  'data-drop': 'before' | 'after' | undefined
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

/**
 * Drag-and-drop ordering for a list: dropping a row on another moves it to that row's index (as playlist.move's
 * `toIndex`). The ↑/↓ buttons beside it stay the keyboard way to do the same. With `enabled` false the rows do
 * not drag.
 */
export function useDragReorder(
  onMove: (from: number, to: number) => void,
  enabled = true,
): (index: number) => DragRowProps {
  const [from, setFrom] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const reset = (): void => {
    setFrom(null)
    setOver(null)
  }
  return (index) => ({
    draggable: enabled,
    'data-dragging': from === index ? 'true' : undefined,
    // a row moved down lands after the row it is dropped on, a row moved up before it
    'data-drop': from === null || over !== index || from === index ? undefined : from < index ? 'after' : 'before',
    onDragStart: (e) => {
      if (!enabled) return
      setFrom(index)
      e.dataTransfer.effectAllowed = 'move'
      // some platforms start no drag without data
      e.dataTransfer.setData('text/plain', String(index))
    },
    onDragOver: (e) => {
      if (from === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (over !== index) setOver(index)
    },
    onDrop: (e) => {
      if (from === null) return
      e.preventDefault()
      if (from !== index) onMove(from, index)
      reset()
    },
    onDragEnd: reset,
  })
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  const [it] = out.splice(from, 1)
  if (it === undefined) return out
  out.splice(to, 0, it)
  return out
}
