import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { resizeRect, snapRect, type Guide, type Handle, type Rect } from './lib/layout.ts'

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

type Props = {
  selected: boolean
  scale: number
  left: number
  top: number
  width: number
  height: number
  testId?: string
  snapTargets?: Rect[]
  onGuides?: (guides: Guide[]) => void
  onCommit: (rect: Rect | null, live: boolean) => void
  onFrameKey?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}

export function BoxFrame({
  selected,
  scale,
  left,
  top,
  width,
  height,
  testId,
  snapTargets,
  onGuides,
  onCommit,
  onFrameKey,
  children,
}: Props) {
  const drag = useRef<{ mode: 'move' | Handle; x: number; y: number; orig: Rect } | null>(null)

  function finish(next: Rect, live: boolean) {
    const snapped = snapTargets?.length ? snapRect(next, snapTargets) : { rect: next, guides: [] as Guide[] }
    onGuides?.(live ? snapped.guides : [])
    onCommit(snapped.rect, live)
  }

  function down(event: ReactPointerEvent<HTMLElement>, mode: 'move' | Handle) {
    event.stopPropagation()
    event.preventDefault()
    drag.current = { mode, x: event.clientX, y: event.clientY, orig: { x: left, y: top, w: width, h: height } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current
    if (!state) return
    const dx = (event.clientX - state.x) / scale
    const dy = (event.clientY - state.y) / scale
    if (state.mode === 'move') finish({ ...state.orig, x: state.orig.x + dx, y: state.orig.y + dy }, true)
    else finish(resizeRect(state.orig, state.mode, dx, dy, 28, 14), true)
  }

  function up() {
    if (!drag.current) return
    drag.current = null
    onGuides?.([])
    onCommit(null, false)
  }

  return (
    <div
      data-overlay
      data-testid={testId}
      className={selected ? 'box-frame selected' : 'box-frame'}
      style={{ left: left * scale, top: top * scale, width: width * scale, height: height * scale }}
    >
      {children}
      {selected ? (
        <button
          type="button"
          className="box-drag"
          aria-label="Move box"
          data-testid="box-drag"
          onPointerDown={(event) => down(event, 'move')}
          onPointerMove={move}
          onPointerUp={up}
          onKeyDown={onFrameKey}
        />
      ) : null}
      {selected
        ? HANDLES.map((handle) => (
            <span
              key={handle}
              className={`box-handle box-handle-${handle}`}
              data-testid={`handle-${handle}`}
              onPointerDown={(event) => down(event, handle)}
              onPointerMove={move}
              onPointerUp={up}
            />
          ))
        : null}
    </div>
  )
}
