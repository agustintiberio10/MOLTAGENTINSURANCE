// Lumina Protocol Community Bot — Main Loop
// Sends technical messages to 3 MoltX communities with smart rotation
//
// Usage:
//   npm run dev          — start the bot loop
//   npm run broadcast -- "message"  — broadcast an update to all communities

import { loadState, log, sleep, getState, updateState, randomBetween } from './state';
import { ensureWalletLinked } from './wallet';
import {
  joinAllCommunities,
  sendCommunityMessage,
  getNextMessage,
  recordMessageSent,
  canSendToCommunity,
  getInterCommunityDelay,
  broadcastUpdate,
  TARGET_COMMUNITIES,
} from './communities';
import { shouldCheckRewards, checkAndClaimRewards } from './rewards';
import { CATEGORY_ROTATION } from './messages';

// --- Quiet hours: 2am-7am UTC ---
function isQuietHours(): boolean {
  const hour = new Date().getUTCHours();
  return hour >= 2 && hour < 7;
}

// --- Main engagement cycle ---
async function runEngagementCycle(): Promise<void> {
  if (isQuietHours()) {
    log('Quiet hours (2-7 UTC), skipping message cycle');
    return;
  }

  const state = getState();

  for (let i = 0; i < TARGET_COMMUNITIES.length; i++) {
    const community = TARGET_COMMUNITIES[i];

    if (!canSendToCommunity(community.id)) {
      const lastTime = state.lastMessageTime[community.id];
      log(`Too soon to send to ${community.name} (last: ${lastTime})`);
      continue;
    }

    const next = getNextMessage(community.id);
    if (!next) {
      log(`No messages available for ${community.name}`);
      continue;
    }

    const { message, newCategoryIndex, newMessageIndex } = next;
    log(`Sending [${message.category}:${message.id}] to ${community.name}`);

    const sent = await sendCommunityMessage(community.id, message.content);
    if (sent) {
      recordMessageSent(community.id, message.id, message.category);
      updateState({
        categoryIndex: newCategoryIndex,
        messageIndices: {
          ...state.messageIndices,
          [message.category]: newMessageIndex,
        },
      });
      log(`Sent ${message.id} to ${community.name}, next category: ${CATEGORY_ROTATION[newCategoryIndex]}`);
    }

    // Wait 5-10 min between communities
    if (i < TARGET_COMMUNITIES.length - 1) {
      const delay = getInterCommunityDelay();
      log(`Waiting ${Math.round(delay / 60000)} min before next community...`);
      await sleep(delay);
    }
  }
}

// --- Main loop ---
async function main(): Promise<void> {
  log('=== Lumina Protocol Community Bot starting ===');

  // Load state from disk (survives restarts)
  loadState();
  const state = getState();

  // Step 1: Ensure wallet is linked
  const linked = await ensureWalletLinked(state.walletLinked);
  if (linked && !state.walletLinked) {
    updateState({ walletLinked: true });
  }

  // Step 2: Join all 3 target communities
  await joinAllCommunities();

  // Step 3: Main loop
  log('Entering main loop...');

  while (true) {
    try {
      // Check rewards every 6 hours
      if (shouldCheckRewards()) {
        await checkAndClaimRewards();
      }

      // Run engagement cycle
      await runEngagementCycle();

      // Sleep 2-4 hours (random) before next cycle
      if (isQuietHours()) {
        // During quiet hours, sleep until 7 UTC
        const now = new Date();
        const wakeUp = new Date(now);
        wakeUp.setUTCHours(7, 0, 0, 0);
        if (wakeUp <= now) wakeUp.setUTCDate(wakeUp.getUTCDate() + 1);
        const sleepMs = wakeUp.getTime() - now.getTime();
        log(`Quiet hours — sleeping ${Math.round(sleepMs / 60000)} min until 7 UTC`);
        await sleep(sleepMs);
      } else {
        const delay = randomBetween(2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000);
        log(`Next cycle in ${Math.round(delay / 60000)} min`);
        await sleep(delay);
      }
    } catch (err: any) {
      log(`Main loop error: ${err.message}`);
      log('Retrying in 5 min...');
      await sleep(5 * 60 * 1000);
    }
  }
}

// Export broadcastUpdate for CLI use
export { broadcastUpdate };

// Run if executed directly
main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
