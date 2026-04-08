/**
 * Shared utilities for IPC bridge wrappers.
 *
 * Instead of writing a boilerplate async function per IPC method:
 *
 *   export async function listEc2Instances(c: AwsConnection) {
 *     return unwrap((await bridge().listEc2Instances(c)) as Wrapped<Ec2InstanceSummary[]>)
 *   }
 *
 * Use the `call` factory to create the same function in one line:
 *
 *   export const listEc2Instances = awsCall<[AwsConnection], Ec2InstanceSummary[]>('listEc2Instances')
 */

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

type AnyBridge = Record<string, (...args: unknown[]) => unknown>

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

/**
 * Creates a typed async wrapper for a single bridge method.
 * @param getBridge - function that returns the bridge object
 * @param method - the method name on the bridge
 */
export function makeBridgeCall<TBridge extends AnyBridge>(getBridge: () => TBridge) {
  return function call<TArgs extends unknown[], TReturn>(
    method: keyof TBridge & string
  ): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      const result = await (getBridge()[method] as (...a: unknown[]) => unknown)(...args)
      return unwrap(result as Wrapped<TReturn>)
    }
  }
}
