async function recoverLifecycleOrRethrow(originalError, recover) {
  try {
    return await recover();
  } catch {
    throw originalError;
  }
}

module.exports = { recoverLifecycleOrRethrow };
