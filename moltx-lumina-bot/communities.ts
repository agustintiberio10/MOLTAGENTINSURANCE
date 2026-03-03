// Community management — join communities + send messages
// Target communities for Lumina Protocol engagement

import { apiCall, log, getState, updateState, sleep, randomBetween } from './state';
import { ALL_MESSAGES, CATEGORY_ROTATION, MESSAGES_BY_CATEGORY, type MessageCategory } from './messages';

// The 3 target communities
export const TARGET_COMMUNITIES = [
  { id: '8ae70e90-0ac9-4403-8b92-eef685058b74', name: 'AI x Crypto' },
  { id: '5b741532-af13-4ece-b98f-ce5dbe945d8b', name: 'Crypto Trading' },
  { id: '4032676b-10d6-46e0-a292-d13dcd941e81', name: 'Crypto' },
];

export async function joinAllCommunities(): Promise<void> {
  const state = getState();

  for (const community of TARGET_COMMUNITIES) {
    if (state.joinedCommunities.includes(community.id)) {
      log(`Already joined: ${community.name} (${community.id})`);
      continue;
    }

    try {
      await apiCall('POST', `/conversations/${community.id}/join`);
      log(`Joined community: ${community.name}`);
      state.joinedCommunities.push(community.id);
      updateState({ joinedCommunities: state.joinedCommunities });
      await sleep(2000);
    } catch (err: any) {
      log(`Failed to join ${community.name}: ${err.message}`);
    }
  }
}

export async function sendCommunityMessage(communityId: string, content: string): Promise<string | null> {
  try {
    const data = await apiCall('POST', `/conversations/${communityId}/messages`, { content });
    const name = TARGET_COMMUNITIES.find((c) => c.id === communityId)?.name || communityId;
    log(`Message sent to ${name}: "${content.slice(0, 60)}..."`);
    return data?.id || null;
  } catch (err: any) {
    log(`Failed to send message to ${communityId}: ${err.message}`);
    return null;
  }
}

// Get the next message to send, following A→B→C rotation
// Never repeats a message in the same community until full cycle exhausted
export function getNextMessage(communityId: string): { message: typeof ALL_MESSAGES[0]; newCategoryIndex: number; newMessageIndex: number } | null {
  const state = getState();
  const sentInCommunity = (state.messageHistory[communityId] || [])
    .filter((m) => !m.isUpdate)
    .map((m) => m.messageId);

  // Try current category rotation
  let categoryIndex = state.categoryIndex;
  let attempts = 0;

  while (attempts < 3) {
    const category = CATEGORY_ROTATION[categoryIndex % CATEGORY_ROTATION.length] as MessageCategory;
    const messages = MESSAGES_BY_CATEGORY[category];
    let msgIndex = state.messageIndices[category] || 0;

    // Find next unsent message in this category for this community
    for (let i = 0; i < messages.length; i++) {
      const candidateIndex = (msgIndex + i) % messages.length;
      const candidate = messages[candidateIndex];

      if (!sentInCommunity.includes(candidate.id)) {
        return {
          message: candidate,
          newCategoryIndex: (categoryIndex + 1) % CATEGORY_ROTATION.length,
          newMessageIndex: (candidateIndex + 1) % messages.length,
        };
      }
    }

    // All messages in this category sent to this community, try next category
    categoryIndex = (categoryIndex + 1) % CATEGORY_ROTATION.length;
    attempts++;
  }

  // All 30 messages sent to this community — reset cycle
  log(`All messages sent to ${communityId}, resetting cycle`);
  state.messageHistory[communityId] = (state.messageHistory[communityId] || []).filter((m) => m.isUpdate);
  updateState({
    messageHistory: state.messageHistory,
    cycleCount: state.cycleCount + 1,
    messageIndices: { A: 0, B: 0, C: 0 },
    categoryIndex: 0,
  });

  // Return first message of category A
  return {
    message: MESSAGES_BY_CATEGORY.A[0],
    newCategoryIndex: 1,
    newMessageIndex: 1,
  };
}

// Record that a message was sent
export function recordMessageSent(communityId: string, messageId: string, category: string, isUpdate = false): void {
  const state = getState();
  if (!state.messageHistory[communityId]) {
    state.messageHistory[communityId] = [];
  }
  state.messageHistory[communityId].push({
    messageId,
    sentAt: new Date().toISOString(),
    category,
    isUpdate,
  });
  state.lastMessageTime[communityId] = new Date().toISOString();
  updateState({
    messageHistory: state.messageHistory,
    lastMessageTime: state.lastMessageTime,
  });
}

// Check if enough time has passed since last message to a community (2-4 hours)
export function canSendToCommunity(communityId: string): boolean {
  const state = getState();
  const lastTime = state.lastMessageTime[communityId];
  if (!lastTime) return true;

  const elapsed = Date.now() - new Date(lastTime).getTime();
  const minInterval = 2 * 60 * 60 * 1000; // 2 hours minimum
  return elapsed >= minInterval;
}

// Get a random delay between 2 and 4 hours in ms
export function getNextMessageDelay(): number {
  return randomBetween(2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000);
}

// Get delay between communities (5-10 min)
export function getInterCommunityDelay(): number {
  return randomBetween(5 * 60 * 1000, 10 * 60 * 1000);
}

// Broadcast an update message to all 3 communities with 5 min delay between each
export async function broadcastUpdate(message: string): Promise<void> {
  log(`Broadcasting update to ${TARGET_COMMUNITIES.length} communities...`);

  for (let i = 0; i < TARGET_COMMUNITIES.length; i++) {
    const community = TARGET_COMMUNITIES[i];
    const sent = await sendCommunityMessage(community.id, message);
    if (sent) {
      recordMessageSent(community.id, `update_${Date.now()}`, 'update', true);
      log(`Update broadcast to ${community.name}`);
    }

    if (i < TARGET_COMMUNITIES.length - 1) {
      log('Waiting 5 min before next community...');
      await sleep(5 * 60 * 1000);
    }
  }

  log('Broadcast complete');
}
