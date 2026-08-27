# Separate Recorder selection from Bridge ownership

Recorder selection is persisted independently from the Local Recorder and Bridge Recorder configurations. `/dictate-config` changes only that selection; it preserves both configurations, never installs or removes Bridge infrastructure, and never falls back automatically. Bridge connection and credential state remains owned by the Bridge installer so ordinary settings changes cannot invalidate its ownership proof, while users can switch non-destructively between Local recording and the configured Bridge recording.
