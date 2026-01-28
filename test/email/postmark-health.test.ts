import { describe, it, expect } from 'vitest';

describe('Postmark API Key (Optional)', () => {
  const apiKey = process.env.POSTMARK_API_KEY;
  const shouldRun = Boolean(apiKey);

  it.skipIf(!shouldRun)('validates Postmark API key via server endpoint', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch('https://api.postmarkapp.com/server', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Postmark-Server-Token': apiKey as string,
        },
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('ID');
    } finally {
      clearTimeout(timeout);
    }
  });
});
