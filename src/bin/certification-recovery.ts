export async function recoverLifecycleOrRethrow(originalError, recover) {
  try {
    return await recover();
  } catch {
    throw originalError;
  }
}

export function commitProvenLifecycle(
  observedReason,
  expectedReason,
  observedState,
  commit
) {
  if (observedReason !== expectedReason) {
    throw new Error(
      `Expected ${expectedReason}, observed ${observedReason || observedState}.`
    );
  }
  commit();
}

export function recoversLifecycleInlineAfterError(name) {
  return !new Set(["logout", "reboot"]).has(name);
}
