import { useLayoutEffect, useRef, type RefObject } from 'react'

type Layer = { element: HTMLElement; previous: HTMLElement | null }
const layers: Layer[] = []
const inertBefore = new Map<HTMLElement, boolean>()
const focusable = 'button, input, textarea, select, summary, iframe, a[href], [tabindex], [contenteditable="true"]'

function roots(element: HTMLElement): HTMLElement[] {
  const result = [element]
  // Select menus are portaled, but belong to the dialog via aria-controls.
  for (const trigger of element.querySelectorAll('[aria-controls]')) {
    for (const id of trigger.getAttribute('aria-controls')!.split(/\s+/)) {
      const controlled = document.getElementById(id)
      if (controlled && !element.contains(controlled)) result.push(controlled)
    }
  }
  return result
}
function updateInert() {
  for (const [element, value] of inertBefore) element.inert = value
  inertBefore.clear()
  const top = layers.at(-1)
  if (!top) return
  const allowed = roots(top.element)
  const paths = new Set<Element>()
  for (const root of allowed) for (let node: Element | null = root; node; node = node.parentElement) paths.add(node)
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || ['SCRIPT', 'STYLE'].includes(child.tagName)) continue
      if (allowed.includes(child)) continue
      if (paths.has(child)) visit(child)
      else { inertBefore.set(child, child.inert); child.inert = true }
    }
  }
  visit(document.body)
}
function candidates(element: HTMLElement) {
  return roots(element).flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(focusable)))
    .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
}

/** Shared focus scope for normal dialogs, nested dialogs and confirmations. */
export function useModalFocus(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  // Capture before React's autofocus commit moves focus into newly mounted content.
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const layer = { element, previous: opener.current }
    layers.push(layer)
    updateInert()
    // Preserve a deliberate autofocus inside the dialog; otherwise focus its container.
    const initial = element.querySelector<HTMLElement>('[data-modal-initial-focus]')
    if (initial) initial.focus()
    else if (!element.contains(document.activeElement)) element.focus()
    const observer = new MutationObserver(updateInert)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-controls'] })
    const keydown = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer || event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current() }
      if (event.key === 'Tab') {
        event.preventDefault()
        const nodes = candidates(element)
        const current = nodes.indexOf(document.activeElement as HTMLElement)
        const next = current < 0 ? (event.shiftKey ? nodes.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length
        ;(nodes[next] ?? element).focus()
      }
    }
    const focusin = (event: FocusEvent) => {
      if (layers.at(-1) === layer && !roots(element).some(root => root.contains(event.target as Node))) {
        ;(candidates(element)[0] ?? element).focus()
      }
    }
    window.addEventListener('keydown', keydown)
    document.addEventListener('focusin', focusin)
    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', keydown)
      document.removeEventListener('focusin', focusin)
      const wasTop = layers.at(-1) === layer
      layers.splice(layers.indexOf(layer), 1)
      updateInert()
      if (wasTop) {
        if (layer.previous?.isConnected && !layer.previous.closest('[inert]')) layer.previous.focus()
        else layers.at(-1)?.element.focus()
      }
    }
  }, [ref])
}
