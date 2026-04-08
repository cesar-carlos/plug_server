export const agentProfileReliabilityMetrics = {
  profileWritesCommittedTotal: 0,
  profileWritesIdempotentTotal: 0,
  profileWritesConflictTotal: 0,
  /** pull_sync: remote profile_version equals server but merged catalog fields differ. */
  profileWritesPullSyncVersionContentConflictTotal: 0,
  profileWritesSkippedStaleRemoteVersionTotal: 0,
  profileWritesSkippedMissingTimestampTotal: 0,
  profileWritesSkippedStaleTimestampTotal: 0,
  profileWritesLegacyNoExpectedVersionTotal: 0,
  profileBroadcastEmittedTotal: 0,
  profileBroadcastFailedTotal: 0,
};

export const resetAgentProfileReliabilityMetricsForTests = (): void => {
  agentProfileReliabilityMetrics.profileWritesCommittedTotal = 0;
  agentProfileReliabilityMetrics.profileWritesIdempotentTotal = 0;
  agentProfileReliabilityMetrics.profileWritesConflictTotal = 0;
  agentProfileReliabilityMetrics.profileWritesPullSyncVersionContentConflictTotal = 0;
  agentProfileReliabilityMetrics.profileWritesSkippedStaleRemoteVersionTotal = 0;
  agentProfileReliabilityMetrics.profileWritesSkippedMissingTimestampTotal = 0;
  agentProfileReliabilityMetrics.profileWritesSkippedStaleTimestampTotal = 0;
  agentProfileReliabilityMetrics.profileWritesLegacyNoExpectedVersionTotal = 0;
  agentProfileReliabilityMetrics.profileBroadcastEmittedTotal = 0;
  agentProfileReliabilityMetrics.profileBroadcastFailedTotal = 0;
};
