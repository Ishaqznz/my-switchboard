import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;

// Connects on first use with a retry loop (backoff up to 10 s).
export async function connectDb(): Promise<void> {
  if (client) return;
  let delay = 500;
  const maxDelay = 10_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const c = new MongoClient(config.mongoUrl, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 10000,
      });
      await c.connect();
      client = c;
      console.log('MongoDB connected');
      return;
    } catch (err) {
      console.error(`MongoDB connect attempt ${attempt} failed: ${(err as Error).message}`);
      if (delay >= maxDelay) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

export async function getDb(): Promise<Db> {
  if (!client) await connectDb();
  return client!.db();
}
