// Persistent state management + logging + API helper
// Saves state to state.json and logs with timestamps

import * as fs from 'fs';
import * as path from 'path';
import axios, { type AxiosRequestConfig } from 'axios';

const STATE_FILE = path.join(__dirname, 'state.json');
const REWARDS_LOG_FILE = path.join(__dirname, 'rewards-log.json');
const MOLTX_BASE_URL = 'https://moltx.io/v1';

export interface CommunityMessageLog {
  messageId: string;
  sentAt: string;
  category: string;
  isUpdate?: boolean;
}

export interface RewardLogEntry {
  date: string;
  eligible: boolean;
  amount?: number;
  status: string;
  details?: any;
}

export interface BotState {
  walletLinked: boolean;
  walletAddress: string;
  joinedCommunities: string[];
  // Per-community message tracking
  messageHistory: Record<string, CommunityMessageLog[]>;
  // Current category rotation index (0=A, 1=B, 2=C)
  categoryIndex: number;
  // Current message index within each category
  messageIndices: Record<string, number>; // category -> index
  // Cycle count (increments when all 30 messages are exhausted)
  cycleCount: number;
  // Timestamps
  lastMessageTime: Record<string, string>; // communityId -> ISO timestamp
  lastRewardsCheck: string;
  lastActivity: string;
  // Rewards
  rewardsHistory: RewardLogEntry[];
}

const DEFAULT_STATE: BotState = {
  walletLinked: false,
  walletAddress: '0x2b4D825417f568231e809E31B9332ED146760337',
  joinedCommunities: [],
  messageHistory: {},
  categoryIndex: 0,
  messageIndices: { A: 0, B: 0, C: 0 },
  cycleCount: 0,
  lastMessageTime: {},
  lastRewardsCheck: '',
  lastActivity: '',
  rewardsHistory: [],
};

let _state: BotState | null = null;

export function loadState(): BotState {
  if (_state) return _state;

  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      _state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      log('State loaded from disk');
    } else {
      _state = { ...DEFAULT_STATE };
      log('No state file found, using defaults');
    }
  } catch (err: any) {
    log(`Error loading state: ${err.message}, using defaults`);
    _state = { ...DEFAULT_STATE };
  }
  return _state!;
}

export function saveState(): void {
  if (!_state) return;
  _state.lastActivity = new Date().toISOString();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
  } catch (err: any) {
    log(`Error saving state: ${err.message}`);
  }
}

export function getState(): BotState {
  if (!_state) return loadState();
  return _state;
}

export function updateState(updates: Partial<BotState>): void {
  const state = getState();
  Object.assign(state, updates);
  saveState();
}

// --- Rewards log ---

export function appendRewardsLog(entry: RewardLogEntry): void {
  try {
    let logs: RewardLogEntry[] = [];
    if (fs.existsSync(REWARDS_LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(REWARDS_LOG_FILE, 'utf-8'));
    }
    logs.push(entry);
    fs.writeFileSync(REWARDS_LOG_FILE, JSON.stringify(logs, null, 2));
  } catch (err: any) {
    log(`Error writing rewards log: ${err.message}`);
  }
}

// --- Logging ---

export function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

// --- API helper ---

function getApiKey(): string {
  const key = process.env.MOLTX_API_KEY;
  if (!key) throw new Error('MOLTX_API_KEY required in .env');
  return key;
}

export async function apiCall(method: string, endpoint: string, body?: any): Promise<any> {
  const url = `${MOLTX_BASE_URL}${endpoint}`;
  const config: AxiosRequestConfig = {
    method: method as any,
    url,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  };
  if (body) config.data = body;

  try {
    const resp = await axios(config);
    return resp.data;
  } catch (err: any) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;

    if (status === 429 || status === 500 || status === 502 || status === 503) {
      log(`API error ${status} on ${endpoint}: ${msg} — retrying in 5 min`);
      await sleep(5 * 60 * 1000);
      const retryResp = await axios(config);
      return retryResp.data;
    }
    throw new Error(`API ${method} ${endpoint} failed (${status}): ${msg}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
