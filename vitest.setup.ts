import { beforeEach, afterEach, vi } from 'vitest';

// Mock Firebase
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  doc: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(() => new Date()),
  writeBatch: vi.fn(),
  updateDoc: vi.fn(),
  setDoc: vi.fn(),
  addDoc: vi.fn(),
  deleteDoc: vi.fn(),
  increment: vi.fn(),
}));

// Mock Firebase config
vi.mock('@kloqo/shared-firebase', () => ({
  db: {},
  firebaseConfig: {
    apiKey: 'test-api-key',
    projectId: 'test-project',
  },
}));

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Cleanup after each test
afterEach(() => {
  vi.restoreAllMocks();
});






