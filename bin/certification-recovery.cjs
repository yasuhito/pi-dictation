async function recoverLifecycleOrRethrow(originalError, recover) {
  try {
    return await recover();
  } catch {
    throw originalError;
  }
}

function commitProvenLifecycle(observedReason, expectedReason, observedState, commit) {
  if (observedReason !== expectedReason) {
    throw new Error(`Expected ${expectedReason}, observed ${observedReason || observedState}.`);
  }
  commit();
}

module.exports = { commitProvenLifecycle, recoverLifecycleOrRethrow };
