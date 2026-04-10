import { useCallback, useEffect, useRef } from 'react'

/**
 * Returns a guard function that wraps async state updates to prevent
 * stale responses from overwriting newer state.
 *
 * Usage:
 *   const guard = useStaleGuard()
 *
 *   async function load() {
 *     const data = await fetchSomething()
 *     guard(() => setState(data))   // no-op if component unmounted or a newer call superseded this one
 *   }
 *
 * The guard is automatically invalidated when the component unmounts.
 * Call guard.invalidate() manually to cancel pending updates (e.g. on connection change).
 */
export function useStaleGuard() {
  const generationRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const guard = useCallback((fn: () => void, generation?: number) => {
    if (!mountedRef.current) return
    if (generation !== undefined && generation !== generationRef.current) return
    fn()
  }, [])

  // Returns the current generation token to pass into guard()
  const nextGeneration = useCallback((): number => {
    generationRef.current += 1
    return generationRef.current
  }, [])

  return { guard, nextGeneration }
}
