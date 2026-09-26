export function createRequestGuard() {
  let sequence = 0
  return {
    begin: () => ++sequence,
    isCurrent: (id: number) => id === sequence,
    invalidate: () => { sequence++ },
  }
}
