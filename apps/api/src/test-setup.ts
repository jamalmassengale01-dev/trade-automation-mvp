import { vi } from 'vitest';

/**
 * Test Setup
 * 
 * Mocks modules that require environment variables or external dependencies.
 * This allows unit tests to run without a database connection.
 */

// Mock the database module to avoid DATABASE_URL requirement
vi.mock('./db', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

// Set minimal required env vars for tests
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
