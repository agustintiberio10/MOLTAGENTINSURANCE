// Rewards monitoring and claiming
// Checks every 6 hours, auto-claims when eligible

import { apiCall, log, getState, updateState, appendRewardsLog, type RewardLogEntry } from './state';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function shouldCheckRewards(): boolean {
  const state = getState();
  if (!state.lastRewardsCheck) return true;

  const elapsed = Date.now() - new Date(state.lastRewardsCheck).getTime();
  return elapsed >= CHECK_INTERVAL_MS;
}

export async function checkAndClaimRewards(): Promise<void> {
  log('Checking active rewards...');

  try {
    const rewards = await apiCall('GET', '/rewards/active');
    log(`Rewards response: ${JSON.stringify(rewards)}`);

    const now = new Date().toISOString();
    updateState({ lastRewardsCheck: now });

    if (rewards?.eligible === true) {
      log('Eligible for rewards! Claiming...');

      try {
        const claimResult = await apiCall('POST', '/rewards/claim');
        log(`Rewards claimed: ${JSON.stringify(claimResult)}`);

        const entry: RewardLogEntry = {
          date: now,
          eligible: true,
          amount: claimResult?.amount || rewards?.amount,
          status: 'claimed',
          details: claimResult,
        };
        appendRewardsLog(entry);

        const state = getState();
        state.rewardsHistory.push(entry);
        updateState({ rewardsHistory: state.rewardsHistory });
      } catch (claimErr: any) {
        log(`Failed to claim rewards: ${claimErr.message}`);
        const entry: RewardLogEntry = {
          date: now,
          eligible: true,
          status: 'claim_failed',
          details: claimErr.message,
        };
        appendRewardsLog(entry);
      }
    } else {
      log('Not eligible for rewards at this time');
      const entry: RewardLogEntry = {
        date: now,
        eligible: false,
        status: 'not_eligible',
        details: rewards,
      };
      appendRewardsLog(entry);
    }
  } catch (err: any) {
    log(`Error checking rewards: ${err.message}`);
  }
}
