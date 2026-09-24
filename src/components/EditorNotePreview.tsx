import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function EditorNotePreview({
  note,
  onEdit,
}: {
  note: string
  onEdit: () => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const anchor = useRef<HTMLButtonElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const hovered = useRef(false)
  const id = useId()
  const hasNote = Boolean(note.trim())
  const keepOpen = () => {
    clearTimeout(closeTimer.current)
    if (hasNote) setOpen(true)
  }
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && document.activeElement !== anchor.current)
        setOpen(false)
    }, 140)
  }
  useEffect(() => {
    const timer = closeTimer
    return () => clearTimeout(timer.current)
  }, [])

  useLayoutEffect(() => {
    if (!open) { hovered.current = false; return }
    const place = () => {
      if (!anchor.current || !preview.current) return
      const button = anchor.current.getBoundingClientRect()
      const popup = preview.current.getBoundingClientRect()
      const below = button.bottom + 8
      const top =
        below + popup.height <= window.innerHeight - 16
          ? below
          : button.top - popup.height - 8
      setPosition({
        left: Math.max(
          16,
          Math.min(button.left, window.innerWidth - popup.width - 16),
        ),
        top: Math.max(
          16,
          Math.min(top, window.innerHeight - popup.height - 16),
        ),
      })
    }
    const onScroll = (event: Event) => {
      if (!preview.current?.contains(event.target as Node)) setOpen(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        !anchor.current?.contains(event.target as Node) &&
        !preview.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, note])

  return (
    <>
      <button
        ref={anchor}
        className="library-note"
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => {
          hovered.current = true
          keepOpen()
        }}
        onMouseLeave={() => {
          hovered.current = false
          closeSoon()
        }}
        onFocus={keepOpen}
        onBlur={closeSoon}
        onClick={() => {
          clearTimeout(closeTimer.current)
          setOpen(false)
          onEdit()
        }}
      >
        {hasNote ? note.replace(/\s+/g, ' ').trim() : '待补充收稿备注'}
      </button>
      {open &&
        hasNote &&
        createPortal(
          <div
            ref={preview}
            id={id}
            role="tooltip"
            className="editor-note-preview"
            style={position}
            onMouseEnter={() => {
              hovered.current = true
              keepOpen()
            }}
            onMouseLeave={() => {
              hovered.current = false
              closeSoon()
            }}
          >
            <strong>收稿要求与备注</strong>
            <div>{note}</div>
          </div>,
          document.body,
        )}
    </>
  )
}
